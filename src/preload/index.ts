import { contextBridge, ipcRenderer } from 'electron';
import { RemoteInputEvent, SavedDevice } from '../shared/types';

const api = {
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  getNetworks: () => ipcRenderer.invoke('app:get-networks'),
  getDisplays: () => ipcRenderer.invoke('app:get-displays'),
  checkMacPermissions: (promptUser: boolean) =>
    ipcRenderer.invoke('app:check-mac-permissions', promptUser),

  setPassword: (newPassword: string) => ipcRenderer.invoke('app:set-password', newPassword),
  generatePassword: () => ipcRenderer.invoke('app:generate-password'),
  updateSettings: (partial: Record<string, unknown>) =>
    ipcRenderer.invoke('app:update-settings', partial),

  upsertSavedDevice: (device: Omit<SavedDevice, 'lastConnectedAt'>) =>
    ipcRenderer.invoke('app:upsert-saved-device', device),
  renameSavedDevice: (id: string, name: string) =>
    ipcRenderer.invoke('app:rename-saved-device', { id, name }),
  removeSavedDevice: (id: string) => ipcRenderer.invoke('app:remove-saved-device', id),
  probeSavedDevices: () => ipcRenderer.invoke('app:probe-saved-devices'),
  probeHost: (ip: string, port: number) => ipcRenderer.invoke('app:probe-host', { ip, port }),

  disconnectSession: (sessionId: string) => ipcRenderer.invoke('app:disconnect-session', sessionId),
  revokeTrustedController: (controllerId: string) =>
    ipcRenderer.invoke('app:revoke-trusted-controller', controllerId),

  readClipboard: () => ipcRenderer.invoke('app:read-clipboard'),
  writeClipboard: (text: string) => ipcRenderer.invoke('app:write-clipboard', text),

  // High-speed fire-and-forget channels for Host WebRTC & Input
  sendHostInputEvent: (ev: RemoteInputEvent) => ipcRenderer.send('host:input-event', ev),
  sendSignalToClient: (sessionId: string, payload: Record<string, unknown>) =>
    ipcRenderer.send('host:signal-to-client', { sessionId, payload }),

  // Event listeners from Main -> Renderer
  onStartHostWebRTC: (callback: (data: any) => void) => {
    ipcRenderer.on('host:start-webrtc', (_e, data) => callback(data));
  },
  onSignalFromClient: (callback: (data: any) => void) => {
    ipcRenderer.on('host:signal-from-client', (_e, data) => callback(data));
  },
  onPeerDisconnected: (callback: (data: { sessionId: string }) => void) => {
    ipcRenderer.on('host:peer-disconnected', (_e, data) => callback(data));
  },
  onSessionsUpdated: (callback: (data: any) => void) => {
    ipcRenderer.on('host:sessions-updated', (_e, data) => callback(data));
  },
  onConfigUpdated: (callback: (config: any) => void) => {
    ipcRenderer.on('app:config-updated', (_e, config) => callback(config));
  },
};

contextBridge.exposeInMainWorld('swiftdesk', api);
