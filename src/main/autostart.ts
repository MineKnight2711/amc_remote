import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { app } from 'electron';

const APP_REG_NAME = 'SwiftDeskRemote';
const MAC_PLIST_ID = 'com.swiftdesk.remote';

export class AutoStartManager {
  /**
   * Enables or disables automatic launch when Windows or macOS starts up.
   * Supports both packaged (.exe / .app) and unpackaged Electron modes.
   */
  public static async setAutoStart(enable: boolean): Promise<boolean> {
    const execPath = process.execPath;
    const appPath = app.getAppPath();
    const isPackaged = app.isPackaged;
    const args = isPackaged ? ['--autostart'] : [appPath, '--autostart'];

    try {
      // 1. Standard Electron Login Item API (Windows & macOS)
      app.setLoginItemSettings({
        openAtLogin: enable,
        openAsHidden: true,
        path: execPath,
        args,
      });
    } catch (err) {
      console.warn('Electron setLoginItemSettings warning:', err);
    }

    // 2. OS-Specific explicit persistence (works reliably even in dev/portable builds)
    if (process.platform === 'win32') {
      await this.setWindowsRegistryAutoStart(enable, execPath, args);
    } else if (process.platform === 'darwin') {
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
      const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
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
      const programArgsXml = [execPath, ...args]
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
