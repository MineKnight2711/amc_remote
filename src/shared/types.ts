export type QualityPreset = 'ultra' | 'balanced' | 'low';

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  type: 'vpn' | 'lan' | 'other';
  label: string; // e.g. "Tailscale VPN", "ZeroTier", "Wi-Fi / LAN"
}

export interface SavedDevice {
  id: string; // Remote device unique ID (e.g. "482-910-375" or "ip:port")
  deviceId?: string; // 9-digit Cloud Device ID (XXX-XXX-XXX)
  name: string; // Remote device hostname or custom alias
  ip: string; // Can be IP or Device ID (XXX-XXX-XXX)
  port: number;
  connectionMode?: 'cloud-id' | 'direct-ip';
  platform: string; // 'win32' | 'darwin' | 'linux'
  trustToken: string; // Issued by host upon first successful password authentication
  savedPassword?: string; // Optional saved password fallback
  lastConnectedAt: number;
  online?: boolean;
  latencyMs?: number;
}

export interface TrustedController {
  controllerId: string;
  controllerName: string;
  platform: string;
  tokenHash: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface AppConfig {
  deviceId: string;
  deviceName: string;
  listenPort: number;
  password: string; // Viewable/editable password on host machine
  passwordHash: string;
  hostSecret: string;
  autoStart: boolean;
  minimizeToTray: boolean;
  defaultQuality: QualityPreset;
  allowClipboardSync: boolean;
  savedDevices: SavedDevice[];
  trustedControllers: TrustedController[];
}

export interface DisplaySourceInfo {
  id: string; // desktopCapturer source id e.g. 'screen:0:0'
  displayId: string;
  name: string;
  width: number;
  height: number;
  scaleFactor: number;
  bounds: { x: number; y: number; width: number; height: number };
  isPrimary: boolean;
}

export type RemoteInputEvent =
  | {
      type: 'mousemove';
      x: number; // Normalized 0.0 -> 1.0 within active display
      y: number; // Normalized 0.0 -> 1.0 within active display
      displayId?: string;
      seq?: number; // Monotonic pointer sequence, used to drop reordered DataChannel moves
    }
  | {
      type: 'mousedown' | 'mouseup';
      button: 'left' | 'middle' | 'right';
      x: number;
      y: number;
      displayId?: string;
      seq?: number;
    }
  | {
      type: 'wheel';
      deltaX: number;
      deltaY: number;
      x?: number;
      y?: number;
    }
  | {
      type: 'keydown' | 'keyup';
      key: string;
      code: string;
      keyCode: number;
      ctrlKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
    }
  | {
      type: 'special-combo';
      combo: 'ctrl-alt-del' | 'alt-tab' | 'win-key' | 'cmd-space' | 'task-manager';
    }
  | {
      type: 'clipboard-set';
      text: string;
    };

export interface HostPublicInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  port: number;
  version: string;
}

export interface ActiveSessionInfo {
  sessionId: string;
  controllerId: string;
  controllerName: string;
  remoteIp: string;
  connectedAt: number;
  authMethod: 'password' | 'trust-token';
}
