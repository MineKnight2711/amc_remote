import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { app, shell } from 'electron';

const APP_REG_NAME = 'SwiftDeskRemote';
const MAC_PLIST_ID = 'com.swiftdesk.remote';
const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// Written by Electron's own login item before the AppUserModelId was set
const LEGACY_WIN_RUN_NAME = 'electron.app.Electron';

export class AutoStartManager {
  /**
   * Enables or disables automatic launch when Windows or macOS starts up.
   * Supports both packaged (.exe / SwiftDesk.app) and unpackaged Electron modes.
   */
  public static async setAutoStart(enable: boolean): Promise<boolean> {
    const execPath = process.execPath;
    const appPath = app.getAppPath();
    const isPackaged = app.isPackaged;
    const args = isPackaged ? ['--autostart'] : [appPath, '--autostart'];

    if (process.platform === 'win32') {
      // Keep a single Run entry: Electron's login item (named after the AppUserModelId) and a legacy
      // "electron.app.Electron" value duplicated it, so every login launched three instances
      try {
        app.setLoginItemSettings({ openAtLogin: false, path: execPath, args });
      } catch {}
      await this.removeLegacyWindowsRunEntry(appPath);
      await this.setWindowsRegistryAutoStart(enable, execPath, args);
      return enable;
    }

    try {
      app.setLoginItemSettings({
        openAtLogin: enable,
        openAsHidden: true,
        path: execPath,
        args,
      });
    } catch (err) {
      console.warn('Electron setLoginItemSettings warning:', err);
    }

    if (process.platform === 'darwin') {
      await this.setMacLaunchAgentAutoStart(enable, execPath, args);
    } else if (process.platform === 'linux') {
      await this.setLinuxDesktopAutoStart(enable, execPath, args);
    }

    return enable;
  }

  private static setWindowsRegistryAutoStart(
    enable: boolean,
    execPath: string,
    args: string[]
  ): Promise<void> {
    return new Promise((resolve) => {
      const regKey = WIN_RUN_KEY;
      if (enable) {
        const quotedArgs = args.map((a) => `"${a}"`).join(' ');
        const commandValue = `"${execPath}" ${quotedArgs}`;
        execFile(
          'reg',
          ['add', regKey, '/v', APP_REG_NAME, '/t', 'REG_SZ', '/d', commandValue, '/f'],
          { windowsHide: true },
          (err) => {
            if (err) {
              console.warn('Windows Registry auto-start warning:', err.message);
            }
            resolve();
          }
        );
      } else {
        execFile(
          'reg',
          ['delete', regKey, '/v', APP_REG_NAME, '/f'],
          { windowsHide: true },
          () => resolve()
        );
      }
    });
  }

  /** Deletes the legacy Run value, but only when it launches this app (other Electron apps share the name). */
  private static removeLegacyWindowsRunEntry(appPath: string): Promise<void> {
    return new Promise((resolve) => {
      execFile('reg', ['query', WIN_RUN_KEY, '/v', LEGACY_WIN_RUN_NAME], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout.toLowerCase().includes(appPath.toLowerCase())) {
          resolve();
          return;
        }
        execFile('reg', ['delete', WIN_RUN_KEY, '/v', LEGACY_WIN_RUN_NAME, '/f'], { windowsHide: true }, () => resolve());
      });
    });
  }

  /**
   * Dev installs have no installer, so after a reboot the only way back in was a terminal + `npm start`.
   * Create Start Menu + Desktop shortcuts; opening one while SwiftDesk sits in the tray just shows
   * the window (single-instance). The Desktop one is created once, so deleting it is respected.
   */
  public static ensureWindowsShortcuts(): void {
    if (process.platform !== 'win32') return;
    const target = process.execPath;
    const options: Electron.ShortcutDetails = {
      target,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      cwd: app.isPackaged ? path.dirname(target) : app.getAppPath(),
      description: 'SwiftDesk — Điều khiển máy tính từ xa',
      appUserModelId: 'com.swiftdesk.remote',
      icon: target,
      iconIndex: 0,
    };

    const startMenuLink = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SwiftDesk.lnk');
    const desktopLink = path.join(app.getPath('desktop'), 'SwiftDesk.lnk');
    const desktopMarker = path.join(app.getPath('userData'), 'desktop-shortcut-created');
    const write = (lnk: string): boolean => {
      try {
        // writeShortcutLink can fail transiently (e.g. AV scanning a new .lnk): retried next launch
        return shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', options);
      } catch {
        return false;
      }
    };

    if (!write(startMenuLink)) console.warn(`[AutoStart] Could not write ${startMenuLink}`);
    if (!fs.existsSync(desktopMarker)) {
      if (write(desktopLink)) {
        fs.writeFileSync(desktopMarker, new Date().toISOString());
        console.log(`[AutoStart] Created Desktop shortcut ${desktopLink}`);
      } else {
        console.warn(`[AutoStart] Could not write ${desktopLink}`);
      }
    }
  }

  private static async setMacLaunchAgentAutoStart(
    enable: boolean,
    execPath: string,
    args: string[]
  ): Promise<void> {
    try {
      const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      const plistPath = path.join(launchAgentsDir, `${MAC_PLIST_ID}.plist`);

      if (!enable) {
        if (fs.existsSync(plistPath)) {
          fs.unlinkSync(plistPath);
        }
        return;
      }

      fs.mkdirSync(launchAgentsDir, { recursive: true });

      // Detect if running inside SwiftDesk.app bundle
      const appBundleMatch = execPath.match(/^(.+\.app)\/Contents\/MacOS\//);
      const launchArgs = appBundleMatch
        ? ['/usr/bin/open', '-a', appBundleMatch[1], '--args', '--autostart']
        : [execPath, ...args];

      const programArgsXml = launchArgs
        .map((arg) => `      <string>${this.escapeXml(arg)}</string>`)
        .join('\n');

      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${MAC_PLIST_ID}</string>
    <key>ProgramArguments</key>
    <array>
${programArgsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>ProcessType</key>
    <string>Interactive</string>
  </dict>
</plist>
`;
      fs.writeFileSync(plistPath, plistContent, 'utf-8');
    } catch (err) {
      console.warn('macOS LaunchAgent auto-start warning:', err);
    }
  }

  private static async setLinuxDesktopAutoStart(
    enable: boolean,
    execPath: string,
    args: string[]
  ): Promise<void> {
    try {
      const autostartDir = path.join(os.homedir(), '.config', 'autostart');
      const desktopPath = path.join(autostartDir, 'swiftdesk-remote.desktop');
      if (!enable) {
        if (fs.existsSync(desktopPath)) fs.unlinkSync(desktopPath);
        return;
      }
      fs.mkdirSync(autostartDir, { recursive: true });
      const cmd = `"${execPath}" ${args.map((a) => `"${a}"`).join(' ')}`;
      const content = `[Desktop Entry]
Type=Application
Name=SwiftDesk Remote
Exec=${cmd}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
      fs.writeFileSync(desktopPath, content, 'utf-8');
    } catch (err) {
      console.warn('Linux autostart warning:', err);
    }
  }

  private static escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
