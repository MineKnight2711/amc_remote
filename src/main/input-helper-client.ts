import * as net from 'net';

/**
 * Talks to the privileged macOS input helper (native/mac-input-helper), a root LaunchDaemon that can
 * post keystrokes to the login window / lock screen where a sandboxed GUI app's events are dropped.
 * SwiftDesk sends newline-delimited JSON key commands over a local Unix socket; the helper posts them.
 *
 * Cross-platform on purpose so the protocol can be tested on Windows against a mock server.
 */

export const DEFAULT_HELPER_SOCKET = '/var/run/com.swiftdesk.inputhelper.sock';

export type HelperCommand =
  | { t: 'k'; vk: number; down: boolean; flags: number } // key by macOS virtual key + CGEventFlags
  | { t: 'u'; s: string } // type a Unicode string (down+up)
  | { t: 'ping' };

const RECONNECT_MS = 3000;

export class InputHelperClient {
  private socket: net.Socket | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly socketPath: string) {}

  public start(): void {
    this.connect();
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public send(cmd: HelperCommand): boolean {
    if (!this.connected || !this.socket) return false;
    try {
      return this.socket.write(JSON.stringify(cmd) + '\n');
    } catch {
      return false;
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {}
      this.socket = null;
    }
    this.connected = false;
  }

  private connect(): void {
    if (this.disposed) return;
    const socket = net.connect(this.socketPath);
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on('connect', () => {
      this.connected = true;
      console.log(`[InputHelper] Connected to ${this.socketPath}`);
    });
    const drop = () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.socket = null;
      this.scheduleReconnect();
    };
    socket.on('error', drop);
    socket.on('close', drop);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }
}
