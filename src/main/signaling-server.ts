import * as http from 'http';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { BrowserWindow, desktopCapturer, screen } from 'electron';
import { ConfigStore } from './store';
import { InputController } from './input-controller';
import {
  ActiveSessionInfo,
  DisplaySourceInfo,
  HostPublicInfo,
  RemoteInputEvent,
} from '../shared/types';

interface ClientSession {
  sessionId: string;
  ws: WebSocket;
  remoteIp: string;
  authenticated: boolean;
  controllerId: string;
  controllerName: string;
  platform: string;
  authMethod: 'password' | 'trust-token';
  connectedAt: number;
}

export class HostSignalingServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, ClientSession>();
  private currentPort = 0;

  constructor(
    private store: ConfigStore,
    private inputController: InputController,
    private getMainWindow: () => BrowserWindow | null,
    private onSessionStateChange?: () => void
  ) {}

  public async start(port?: number): Promise<{ success: boolean; port: number; error?: string }> {
    const targetPort = port || this.store.get().listenPort || 9876;
    await this.stop();

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.url === '/ping' && req.method === 'GET') {
          const cfg = this.store.get();
          const info: HostPublicInfo = {
            deviceId: cfg.deviceId,
            deviceName: cfg.deviceName,
            platform: process.platform,
            port: this.currentPort || targetPort,
            version: '1.0.0',
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(info));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('SwiftDesk Remote Desktop Host Active');
      });

      const wss = new WebSocketServer({
        server,
        perMessageDeflate: false, // Disable compression for lowest possible latency
      });

      wss.on('connection', (ws, req) => {
        this.handleConnection(ws, req);
      });

      server.once('error', (err: NodeJS.ErrnoException) => {
        console.error(`[SignalingServer] Failed to bind port ${targetPort}:`, err.message);
        resolve({
          success: false,
          port: targetPort,
          error: err.code === 'EADDRINUSE' ? `Cổng ${targetPort} đang được sử dụng` : err.message,
        });
      });

      server.listen(targetPort, '0.0.0.0', () => {
        this.httpServer = server;
        this.wss = wss;
        this.currentPort = targetPort;
        console.log(`[SignalingServer] Listening on 0.0.0.0:${targetPort}`);
        resolve({ success: true, port: targetPort });
      });
    });
  }

  public async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.ws.close(1000, 'Host stopping');
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
    this.inputController.releaseAllInputs();

    if (this.wss) {
      await new Promise<void>((r) => this.wss!.close(() => r()));
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((r) => this.httpServer!.close(() => r()));
      this.httpServer = null;
    }
  }

  public getActiveSessions(): ActiveSessionInfo[] {
    const list: ActiveSessionInfo[] = [];
    for (const s of this.sessions.values()) {
      if (s.authenticated) {
        list.push({
          sessionId: s.sessionId,
          controllerId: s.controllerId,
          controllerName: s.controllerName,
          remoteIp: s.remoteIp,
          connectedAt: s.connectedAt,
          authMethod: s.authMethod,
        });
      }
    }
    return list;
  }

  public disconnectSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      this.sendJson(s.ws, { type: 'session-closed', reason: 'Máy chủ đã ngắt kết nối phiên này.' });
      s.ws.close(1000, 'Disconnected by host');
      this.sessions.delete(sessionId);
      this.inputController.releaseAllInputs();
      this.notifyRenderer('host:peer-disconnected', { sessionId });
      this.notifySessionsUpdated();
    }
  }

  public sendSignalToClient(sessionId: string, payload: Record<string, unknown>): void {
    const s = this.sessions.get(sessionId);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      this.sendJson(s.ws, payload);
    }
  }

  public async getDisplaySources(): Promise<DisplaySourceInfo[]> {
    const displays = screen.getAllDisplays();
    const primaryId = String(screen.getPrimaryDisplay().id);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });

    return sources.map((src, idx) => {
      const matchedDisplay =
        displays.find((d) => String(d.id) === String(src.display_id)) ||
        displays[idx] ||
        screen.getPrimaryDisplay();

      return {
        id: src.id,
        displayId: String(matchedDisplay.id),
        name: src.name || `Màn hình ${idx + 1}`,
        width: matchedDisplay.size.width,
        height: matchedDisplay.size.height,
        scaleFactor: matchedDisplay.scaleFactor || 1,
        bounds: matchedDisplay.bounds,
        isPrimary: String(matchedDisplay.id) === primaryId || idx === 0,
      };
    });
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const sessionId = crypto.randomUUID();
    const rawIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const cfg = this.store.get();

    const session: ClientSession = {
      sessionId,
      ws,
      remoteIp: rawIp,
      authenticated: false,
      controllerId: '',
      controllerName: 'Unknown Device',
      platform: 'unknown',
      authMethod: 'password',
      connectedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);

    // Send initial hello with host metadata
    this.sendJson(ws, {
      type: 'hello',
      sessionId,
      hostInfo: {
        deviceId: cfg.deviceId,
        deviceName: cfg.deviceName,
        platform: process.platform,
        port: this.currentPort,
        version: '1.0.0',
      },
    });

    ws.on('message', async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        await this.handleClientMessage(session, msg);
      } catch (err) {
        console.error('[SignalingServer] Invalid message:', err);
      }
    });

    ws.on('close', () => {
      const wasAuth = session.authenticated;
      this.sessions.delete(sessionId);
      if (wasAuth) {
        this.inputController.releaseAllInputs();
        this.notifyRenderer('host:peer-disconnected', { sessionId });
        this.notifySessionsUpdated();
      }
    });

    ws.on('error', () => {
      this.sessions.delete(sessionId);
    });
  }

  private async handleClientMessage(session: ClientSession, msg: any): Promise<void> {
    if (msg.type === 'ping') {
      this.sendJson(session.ws, { type: 'pong', ts: msg.ts });
      return;
    }

    if (msg.type === 'auth-request') {
      const controllerId = String(msg.controllerId || 'unknown');
      const controllerName = String(msg.controllerName || 'Remote Controller');
      const platform = String(msg.platform || 'unknown');
      const password = String(msg.password || '');
      const trustToken = String(msg.trustToken || '');
      const quality = msg.quality || 'ultra';

      let authenticated = false;
      let authMethod: 'password' | 'trust-token' = 'password';

      // 1. Check saved 1-click Trust Token first
      if (trustToken && this.store.verifyTrustToken(controllerId, trustToken)) {
        authenticated = true;
        authMethod = 'trust-token';
      } else if (password && this.store.verifyPassword(password)) {
        // 2. Verify Host Password
        authenticated = true;
        authMethod = 'password';
      }

      if (!authenticated) {
        const reason =
          trustToken && !password
            ? 'TOKEN_EXPIRED_OR_INVALID'
            : 'INVALID_PASSWORD';
        this.sendJson(session.ws, {
          type: 'auth-failed',
          reason,
          message:
            reason === 'TOKEN_EXPIRED_OR_INVALID'
              ? 'Phiên đăng nhập tự động đã hết hạn. Vui lòng nhập mật khẩu của máy đích.'
              : 'Mật khẩu không chính xác. Vui lòng kiểm tra lại.',
        });
        return;
      }

      // Issue or refresh Trust Token so future connections are 1-click without password
      const issuedTrustToken = this.store.issueTrustToken(controllerId, controllerName, platform);

      session.authenticated = true;
      session.controllerId = controllerId;
      session.controllerName = controllerName;
      session.platform = platform;
      session.authMethod = authMethod;
      session.connectedAt = Date.now();

      const displays = await this.getDisplaySources();
      const cfg = this.store.get();

      this.sendJson(session.ws, {
        type: 'auth-success',
        sessionId: session.sessionId,
        trustToken: issuedTrustToken,
        hostInfo: {
          deviceId: cfg.deviceId,
          deviceName: cfg.deviceName,
          platform: process.platform,
          port: this.currentPort,
          version: '1.0.0',
        },
        displays,
      });

      this.notifySessionsUpdated();

      // Instruct Host Renderer to begin WebRTC 60FPS screen capture for this session
      const primaryDisplay = displays.find((d) => d.isPrimary) || displays[0];
      this.notifyRenderer('host:start-webrtc', {
        sessionId: session.sessionId,
        sourceId: primaryDisplay?.id,
        displayId: primaryDisplay?.displayId,
        quality,
      });
      return;
    }

    // All subsequent commands require authentication
    if (!session.authenticated) {
      return;
    }

    switch (msg.type) {
      case 'input': {
        if (msg.event) {
          this.inputController.handleEvent(
            msg.event as RemoteInputEvent,
            this.store.get().allowClipboardSync
          );
        }
        break;
      }
      case 'webrtc-answer':
      case 'webrtc-ice':
      case 'switch-display':
      case 'change-quality': {
        this.notifyRenderer('host:signal-from-client', {
          sessionId: session.sessionId,
          ...msg,
        });
        break;
      }
    }
  }

  private sendJson(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private notifyRenderer(channel: string, payload: unknown): void {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  private notifySessionsUpdated(): void {
    this.notifyRenderer('host:sessions-updated', {
      sessions: this.getActiveSessions(),
      trustedControllers: this.store.get().trustedControllers,
    });
    if (this.onSessionStateChange) {
      this.onSessionStateChange();
    }
  }
}
