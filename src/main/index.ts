import * as path from 'path';
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
import { RemoteInputEvent, SavedDevice } from '../shared/types';

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

const isMultiInstanceAllowed = process.argv.includes('--multi-instance');
const isAutoStarted = process.argv.includes('--autostart');

if (!isMultiInstanceAllowed) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      showMainWindow();
    });
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
    show: !isAutoStarted,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setBackgroundThrottling(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

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

    trayManager.refreshMenu();
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

app.whenReady().then(async () => {
  powerSaveId = powerSaveBlocker.start('prevent-app-suspension');

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0] });
    });
  });

  store = new ConfigStore();
  inputController = new InputController();

  signalingServer = new HostSignalingServer(
    store,
    inputController,
    () => mainWindow,
    () => trayManager?.refreshMenu()
  );

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

  registerIpcHandlers();
  createMainWindow();
  trayManager.init();

  await AutoStartManager.setAutoStart(store.get().autoStart);
  await signalingServer.start(store.get().listenPort);
  trayManager.refreshMenu();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('before-quit', async () => {
  isQuitting = true;
  if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId);
  }
  if (signalingServer) {
    await signalingServer.stop();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
