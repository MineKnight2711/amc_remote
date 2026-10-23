import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  powerSaveBlocker,
  session,
  desktopCapturer,
} from 'electron';
import { ConfigStore, generateRandomPassword } from './store';
import { AutoStartManager } from './autostart';
import { getLocalNetworkInterfaces, probeRemoteHost } from './network';
import { InputController } from './input-controller';
import { HostSignalingServer, isDeviceIdFormat } from './signaling-server';
import { TrayManager } from './tray';
import { UpnpPortMapper } from './upnp';
import { initFileLogger, writeLine } from './logger';
import { RemoteInputEvent, SavedDevice } from '../shared/types';

// Set standalone App Name & Bundle ID for macOS TCC & Windows
app.setName('SwiftDesk');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.swiftdesk.remote');
}

// --- Ultra-Low-Latency WebRTC & Background Streaming Flags ---
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let store: ConfigStore;
let inputController: InputController;
let signalingServer: HostSignalingServer;
let trayManager: TrayManager;
let powerSaveId: number | null = null;
const upnpMapper = new UpnpPortMapper();

const isMultiInstanceAllowed = process.argv.includes('--multi-instance');
// Build this process started from; compared when a second instance is launched (see buildStamp)
const startupBuildStamp = buildStamp();
const isAutoStarted = process.argv.includes('--autostart');

// macOS pre-login instance, started at the login window (after a restart, or after logging out) by
// /Library/LaunchAgents/com.swiftdesk.remote.loginwindow.plist. It runs as root, so it gets its own
// Chromium profile and log folder, but reuses the user's config (same Cloud ID / password).
const isLoginWindowMode = process.platform === 'darwin' && process.argv.includes('--login-window');
const configFileArg = process.argv.find((a) => a.startsWith('--config-file='))?.slice('--config-file='.length);
if (isLoginWindowMode) {
  app.setPath('userData', '/Library/Application Support/SwiftDesk/loginwindow');
  app.setAppLogsPath('/Library/Logs/SwiftDesk');
}

/** At the login window /dev/console belongs to root; once someone logs in it belongs to that user. */
function isUserLoggedIn(): boolean {
  try {
    return fs.statSync('/dev/console').uid !== 0;
  } catch {
    return false;
  }
}

if (!isMultiInstanceAllowed) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', (_event, argv) => {
      // `npm start` while SwiftDesk already runs (e.g. in the tray) only reaches this handler, so the
      // new build would never load: if the code on disk changed since we started, restart into it
      if (buildStamp() !== startupBuildStamp) {
        console.log('[Main] Newer build detected on launch, restarting into it');
        app.relaunch();
        app.quit();
        return;
      }
      // A duplicate login-item launch must not pop the window open; a user launch (shortcut) should
      if (argv.includes('--autostart')) return;
      showMainWindow();
    });
  }
}

/** Modification times of the compiled main + renderer code: changes whenever `npm run build` runs. */
function buildStamp(): string {
  try {
    return [
      path.join(__dirname, 'index.js'),
      path.join(__dirname, '..', 'renderer', 'app.js'),
      path.join(__dirname, '..', 'renderer', 'index.html'),
    ]
      .map((f) => fs.statSync(f).mtimeMs)
      .join('|');
  } catch {
    return '';
  }
}

function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    title: 'SwiftDesk Remote Desktop',
    backgroundColor: '#090d16',
    autoHideMenuBar: true,
    show: !isAutoStarted && !isLoginWindowMode,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setBackgroundThrottling(false);
  // Gather ICE only on the default-route interfaces (LAN IPv4 + public IPv6). With "default",
  // Chromium's 5-network IPv6 cap gets filled by VPN/ULA/Teredo addresses (Radmin, Tailscale...)
  // and the real public IPv6 — the only NAT-free direct path — is never offered to the peer.
  mainWindow.webContents.setWebRTCIPHandlingPolicy('default_public_and_private_interfaces');
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Renderer diagnostics ([HostWebRTC] / [ClientViewer] lines, warnings, errors) go to the log file too
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 || message.startsWith('[')) {
      writeLine(level >= 3 ? 'RENDERER-ERROR' : 'RENDERER', message);
    }
  });

  // The host is usually unattended: if its renderer (capture + WebRTC) dies, end the sessions so
  // viewers can reconnect, then reload instead of leaving a blank window
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[Main] Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
    inputController?.releaseAllInputs();
    signalingServer?.disconnectAllSessions();
    if (details.reason !== 'clean-exit') {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      }, 1000);
    }
  });

  let unresponsiveTimer: NodeJS.Timeout | null = null;
  mainWindow.on('unresponsive', () => {
    console.warn('[Main] Renderer unresponsive');
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      console.error('[Main] Renderer hung for 15s, restarting it');
      mainWindow?.webContents.forcefullyCrashRenderer();
    }, 15000);
  });
  mainWindow.on('responsive', () => {
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
      console.log('[Main] Renderer responsive again');
    }
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && store.get().minimizeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  // Fast fire-and-forget IPC for WebRTC DataChannel input events
  ipcMain.on('host:input-event', (_event, inputEvent: RemoteInputEvent) => {
    inputController.handleEvent(inputEvent, store.get().allowClipboardSync);
  });

  ipcMain.on('host:release-inputs', () => {
    inputController.releaseAllInputs();
  });

  ipcMain.handle('app:get-input-diagnostics', () => inputController.getDiagnostics());

  // Host WebRTC signaling back to connected client (works for both WS and Cloud ID)
  ipcMain.on('host:signal-to-client', (_event, data: { sessionId: string; payload: Record<string, unknown> }) => {
    signalingServer.sendSignalToClient(data.sessionId, data.payload);
  });

  // Client Cloud ID session controls
  ipcMain.on('client:start-cloud-session', (_event, sessionId: string) => {
    signalingServer.startClientCloudSession(sessionId);
  });

  ipcMain.on('client:stop-cloud-session', (_event, data: { targetDeviceId?: string; sessionId?: string }) => {
    signalingServer.stopClientCloudSession(data?.targetDeviceId, data?.sessionId);
  });

  ipcMain.on('client:send-cloud-msg', (_event, data: { targetDeviceId: string; payload: Record<string, unknown> }) => {
    signalingServer.sendClientCloudMessage(data.targetDeviceId, data.payload);
  });

  // UPnP: forward the router's UDP port to a WebRTC host candidate so the peer can reach us directly
  ipcMain.handle('nat:map-udp', (_event, data: { owner: string; ip: string; port: number }) => {
    return upnpMapper.mapUdp(data.owner, data.ip, data.port).catch(() => null);
  });

  ipcMain.on('nat:release', (_event, owner: string) => {
    upnpMapper.releaseOwner(owner).catch(() => {});
  });

  ipcMain.handle('app:get-bootstrap', async () => {
    const cfg = store.get();
    const nets = getLocalNetworkInterfaces();
    const displays = await signalingServer.getDisplaySources();
    const macPermissions = inputController.checkMacPermissions(false);

    return {
      config: cfg,
      platform: process.platform,
      networks: nets,
      displays,
      activeSessions: signalingServer.getActiveSessions(),
      macPermissions,
      cloudOnline: signalingServer.isCloudOnline(),
    };
  });

  ipcMain.handle('app:get-networks', () => {
    return getLocalNetworkInterfaces();
  });

  ipcMain.handle('app:get-displays', async () => {
    return signalingServer.getDisplaySources();
  });

  ipcMain.handle('app:check-mac-permissions', (_event, promptUser: boolean) => {
    return inputController.checkMacPermissions(promptUser);
  });

  ipcMain.handle('app:set-password', (_event, newPassword: string) => {
    const updated = store.setPassword(newPassword);
    return { success: true, config: updated };
  });

  ipcMain.handle('app:generate-password', () => {
    const newPass = generateRandomPassword(8);
    const updated = store.setPassword(newPass);
    return { success: true, password: newPass, config: updated };
  });

  ipcMain.handle('app:update-settings', async (_event, partial: {
    deviceName?: string;
    listenPort?: number;
    autoStart?: boolean;
    minimizeToTray?: boolean;
    defaultQuality?: 'ultra' | 'balanced' | 'low';
    allowClipboardSync?: boolean;
    mapCtrlToCmd?: boolean;
    viewerResolution?: string;
    viewerCursor?: 'dot' | 'arrow' | 'none';
  }) => {
    const current = store.get();
    const portChanged = partial.listenPort !== undefined && partial.listenPort !== current.listenPort;
    const autoStartChanged = partial.autoStart !== undefined && partial.autoStart !== current.autoStart;

    if (autoStartChanged && partial.autoStart !== undefined) {
      await AutoStartManager.setAutoStart(partial.autoStart);
    }

    const updated = store.save(partial);

    let serverResult: { success: boolean; port: number; error?: string } = {
      success: true,
      port: updated.listenPort,
    };
    if (portChanged && partial.listenPort) {
      serverResult = await signalingServer.start(partial.listenPort);
    }

    trayManager?.refreshMenu();
    return {
      success: serverResult.success,
      error: serverResult.error,
      config: updated,
    };
  });

  ipcMain.handle('app:upsert-saved-device', (_event, device: Omit<SavedDevice, 'lastConnectedAt'>) => {
    const list = store.upsertSavedDevice(device);
    return list;
  });

  ipcMain.handle('app:rename-saved-device', (_event, { id, name }: { id: string; name: string }) => {
    return store.renameSavedDevice(id, name);
  });

  ipcMain.handle('app:remove-saved-device', (_event, id: string) => {
    return store.removeSavedDevice(id);
  });

  ipcMain.handle('app:probe-saved-devices', async () => {
    const saved = store.get().savedDevices;
    return Promise.all(
      saved.map(async (dev) => {
        if (dev.connectionMode === 'cloud-id' || isDeviceIdFormat(dev.ip) || isDeviceIdFormat(dev.id)) {
          const targetId = isDeviceIdFormat(dev.ip) ? dev.ip : dev.id;
          const res = await signalingServer.probeCloudDeviceId(targetId, 2000);
          return {
            ...dev,
            online: res.online,
            latencyMs: res.latencyMs,
            name: res.info?.deviceName || dev.name,
            platform: res.info?.platform || dev.platform,
          };
        } else {
          const res = await probeRemoteHost(dev.ip, dev.port, 1600);
          return {
            ...dev,
            online: res.online,
            latencyMs: res.latencyMs,
            name: res.info?.deviceName || dev.name,
            platform: res.info?.platform || dev.platform,
          };
        }
      })
    );
  });

  ipcMain.handle('app:probe-host', async (_event, { ip, port }: { ip: string; port: number }) => {
    if (isDeviceIdFormat(ip)) {
      return signalingServer.probeCloudDeviceId(ip, 2200);
    }
    return probeRemoteHost(ip, port);
  });

  ipcMain.handle('app:disconnect-session', (_event, sessionId: string) => {
    signalingServer.disconnectSession(sessionId);
    return signalingServer.getActiveSessions();
  });

  ipcMain.handle('app:revoke-trusted-controller', (_event, controllerId: string) => {
    const updated = store.revokeTrustedController(controllerId);
    return updated.trustedControllers;
  });

  ipcMain.handle('app:read-clipboard', () => {
    return clipboard.readText();
  });

  ipcMain.handle('app:write-clipboard', (_event, text: string) => {
    clipboard.writeText(text || '');
    return true;
  });
}

app.on('child-process-gone', (_e, details) => {
  console.error(
    `[Main] ${details.type} process gone: reason=${details.reason} exitCode=${details.exitCode} ${details.name || ''}`
  );
});

let displayAwakeId: number | null = null;
let lastSessionCount = 0;

/**
 * While someone is connected keep the host's display on, and wake it when a session starts:
 * a sleeping display streams black, and a locked Mac couldn't be unlocked remotely.
 */
function onSessionsChanged(): void {
  trayManager?.refreshMenu();
  const count = signalingServer.getActiveSessions().length;
  if (count > lastSessionCount && process.platform === 'darwin') {
    // -u declares user activity: turns a sleeping display back on
    execFile('/usr/bin/caffeinate', ['-u', '-t', '5'], () => {});
  }
  if (count > 0 && displayAwakeId === null) {
    displayAwakeId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (count === 0 && displayAwakeId !== null) {
    powerSaveBlocker.stop(displayAwakeId);
    displayAwakeId = null;
  }
  lastSessionCount = count;
}

app.whenReady().then(async () => {
  const logPath = initFileLogger();
  console.log(`[Main] Writing log to ${logPath}`);

  if (isLoginWindowMode) {
    if (isUserLoggedIn()) {
      // A user session is active: that session's own SwiftDesk instance serves it
      console.log('[Main] Login-window instance started while a user is logged in, exiting');
      app.exit(0);
      return;
    }
    console.log(`[Main] Login-window mode (before login), config: ${configFileArg || '(default)'}`);
  }

  powerSaveId = powerSaveBlocker.start('prevent-app-suspension');

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0] });
    });
  });

  store = new ConfigStore(configFileArg);
  inputController = new InputController(isLoginWindowMode, {
    // Login-window keyboard injection is experimental and off unless explicitly enabled
    allowKeyInject: process.argv.includes('--enable-loginwindow-keys'),
    crashGuardFile: isLoginWindowMode
      ? path.join(app.getPath('userData'), 'loginwindow-keyinject.crashguard')
      : undefined,
  });
  if (isLoginWindowMode) {
    console.log(`[Main] Input diagnostics: ${JSON.stringify(inputController.getDiagnostics())}`);
  }

  signalingServer = new HostSignalingServer(store, inputController, () => mainWindow, onSessionsChanged);

  registerIpcHandlers();
  createMainWindow();

  if (isLoginWindowMode) {
    // Hand over to the user's own instance (started by their LaunchAgent) as soon as someone logs in.
    // Quitting sends "session-closed" with reconnect=true, so the viewer reconnects to the new instance.
    setInterval(() => {
      if (isUserLoggedIn() && !isQuitting) {
        console.log('[Main] User logged in, login-window instance handing over and exiting');
        app.quit();
      }
    }, 1500);
  } else {
    trayManager = new TrayManager(
      () => showMainWindow(),
      () => {
        isQuitting = true;
      },
      () => ({
        port: store.get().listenPort,
        activeCount: signalingServer.getActiveSessions().length,
        autoStart: store.get().autoStart,
      }),
      async (enabled) => {
        await AutoStartManager.setAutoStart(enabled);
        store.save({ autoStart: enabled });
        trayManager.refreshMenu();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:config-updated', store.get());
        }
      }
    );
    trayManager.init();
    await AutoStartManager.setAutoStart(store.get().autoStart);
    AutoStartManager.ensureWindowsShortcuts();
  }

  await signalingServer.start(store.get().listenPort);
  trayManager?.refreshMenu();
  upnpMapper.warmUp();

  app.on('activate', () => {
    showMainWindow();
  });
});

let quitCleanupDone = false;
app.on('before-quit', (e) => {
  isQuitting = true;
  if (quitCleanupDone) return;
  console.log('[Main] Quit requested (tray, ⌘Q / app menu, or system shutdown)');
  // Hold the quit until router port mappings are removed (some routers only support permanent leases)
  e.preventDefault();
  quitCleanupDone = true;
  if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId);
  }
  const cleanup = Promise.all([signalingServer?.stop(), upnpMapper.releaseAll()]);
  Promise.race([cleanup, new Promise((r) => setTimeout(r, 2000))])
    .catch(() => {})
    .finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
