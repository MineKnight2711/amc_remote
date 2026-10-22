import * as http from 'http';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as mqtt from 'mqtt';
import { BrowserWindow, desktopCapturer, screen } from 'electron';
import { ConfigStore } from './store';
import { InputController } from './input-controller';
import { getLocalNetworkInterfaces } from './network';
import {
  ActiveSessionInfo,
  DisplaySourceInfo,
  HostPublicInfo,
  RemoteInputEvent,
} from '../shared/types';

export function normalizeDeviceId(raw: string): string {
  return String(raw || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

export function isDeviceIdFormat(input: string): boolean {
  const trimmed = input.trim();
  if (/^\d{3}[-\s]?\d{3}[-\s]?\d{3}$/.test(trimmed)) {
    return true;
  }
  return false;
}

const MAX_RELAY_BACKLOG_BYTES = 1_500_000;

const CLOUD_BROKERS = [
  'mqtts://broker.emqx.io:8883',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

interface ClientSession {
  sessionId: string;
  transport: 'ws' | 'cloud';
  ws?: WebSocket;
  replyTopic?: string;
  remoteIp: string;
  authenticated: boolean;
  webrtcStarted: boolean;
  quality: 'ultra' | 'balanced' | 'low';
  primarySourceId?: string;
  primaryDisplayId?: string;
  controllerId: string;
  controllerName: string;
  platform: string;
  authMethod: 'password' | 'trust-token';
  connectedAt: number;
  lastSeenAt: number;
}

export class HostSignalingServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private mqttClient: mqtt.MqttClient | null = null;
  private cloudConnected = false;
  private brokerIndex = 0;

  private sessions = new Map<string, ClientSession>();
  private currentPort = 0;

  private activeClientSubTopic: string | null = null;
  private pendingProbes = new Map<
    string,
    { start: number; resolve: (res: { online: boolean; latencyMs?: number; info?: HostPublicInfo }) => void }
  >();
  private clientProbeTopic = `swiftdesk/v2/probe/${crypto.randomUUID()}`;

  constructor(
    private store: ConfigStore,
    private inputController: InputController,
    private getMainWindow: () => BrowserWindow | null,
    private onSessionStateChange?: () => void
  ) {
    this.initCloudBroker();
  }

  public isCloudOnline(): boolean {
    return this.cloudConnected;
  }

  private initCloudBroker(): void {
    const brokerUrl = CLOUD_BROKERS[this.brokerIndex % CLOUD_BROKERS.length];
    const cleanHostId = normalizeDeviceId(this.store.get().deviceId);

    try {
      const client = mqtt.connect(brokerUrl, {
        clientId: `swiftdesk_${cleanHostId}_${crypto.randomBytes(4).toString('hex')}`,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 3000,
        keepalive: 30,
        // Never buffer messages while offline: stale relay frames would pile up in memory
        queueQoSZero: false,
      });

      this.mqttClient = client;

      client.on('connect', () => {
        this.cloudConnected = true;
        const hostInboxTopic = `swiftdesk/v2/host/${cleanHostId}/in`;
        const topics = [hostInboxTopic, this.clientProbeTopic];
        if (this.activeClientSubTopic) {
          topics.push(this.activeClientSubTopic);
        }
        client.subscribe(topics, { qos: 0 });
        console.log(`[CloudID] Connected to Cloud Broker (${brokerUrl}) with ID: ${this.store.get().deviceId}`);
        this.notifyRenderer('app:cloud-status', { online: true, deviceId: this.store.get().deviceId });
      });

      client.on('message', (topic, payloadBuf) => {
        this.handleCloudMqttMessage(topic, payloadBuf);
      });

      client.on('offline', () => {
        console.warn(`[CloudID] Broker connection lost (${brokerUrl}), reconnecting...`);
        this.cloudConnected = false;
        this.notifyRenderer('app:cloud-status', { online: false, deviceId: this.store.get().deviceId });
      });

      client.on('error', (err) => {
        console.warn('[CloudID] Broker error:', err.message);
      });
    } catch (err) {
      console.error('[CloudID] Failed to init MQTT:', err);
    }
  }

  private async handleCloudMqttMessage(topic: string, payloadBuf: Buffer): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(payloadBuf.toString('utf-8'));
    } catch {
      return;
    }

    if (topic === this.clientProbeTopic && msg.type === 'ping-probe-reply' && msg.probeId) {
      const pending = this.pendingProbes.get(msg.probeId);
      if (pending) {
        this.pendingProbes.delete(msg.probeId);
        pending.resolve({
          online: true,
          latencyMs: Math.max(1, Date.now() - pending.start),
          info: msg.hostInfo,
        });
      }
      return;
    }

    if (this.activeClientSubTopic && topic === this.activeClientSubTopic) {
      this.notifyRenderer('client:cloud-message', msg);
      return;
    }

    const cleanHostId = normalizeDeviceId(this.store.get().deviceId);
    const hostInboxTopic = `swiftdesk/v2/host/${cleanHostId}/in`;
    if (topic === hostInboxTopic) {
      if (msg.type === 'ping-probe' && msg.replyTopic && msg.probeId) {
        const cfg = this.store.get();
        this.publishCloud(msg.replyTopic, {
          type: 'ping-probe-reply',
          probeId: msg.probeId,
          hostInfo: {
            deviceId: cfg.deviceId,
            deviceName: cfg.deviceName,
            platform: process.platform,
            port: this.currentPort,
            version: '1.2.0',
          },
        });
        return;
      }

      const sessionId = String(msg.sessionId || '');
      if (!sessionId) return;

      let session = this.sessions.get(sessionId);
      if (!session && msg.type === 'auth-request') {
        session = {
          sessionId,
          transport: 'cloud',
          replyTopic: `swiftdesk/v2/client/${sessionId}/in`,
          remoteIp: `ID: ${msg.controllerId || 'Internet P2P'}`,
          authenticated: false,
          webrtcStarted: false,
          quality: msg.quality || 'ultra',
          controllerId: '',
          controllerName: 'Remote Device',
          platform: 'unknown',
          authMethod: 'password',
          connectedAt: Date.now(),
          lastSeenAt: Date.now(),
        };
        this.sessions.set(sessionId, session);
      }

      if (session) {
        session.lastSeenAt = Date.now();
        if (msg.type === 'client-disconnect') {
          const wasAuth = session.authenticated;
          this.sessions.delete(sessionId);
          if (wasAuth) {
            this.inputController.releaseAllInputs();
            this.notifyRenderer('host:peer-disconnected', { sessionId });
            this.notifySessionsUpdated();
          }
          return;
        }
        await this.handleClientMessage(session, msg);
      }
    }
  }

  public probeCloudDeviceId(
    targetDeviceId: string,
    timeoutMs = 2200
  ): Promise<{ online: boolean; latencyMs?: number; info?: HostPublicInfo }> {
    return new Promise((resolve) => {
      if (!this.mqttClient || !this.cloudConnected) {
        resolve({ online: false });
        return;
      }
      const cleanId = normalizeDeviceId(targetDeviceId);
      if (!cleanId) {
        resolve({ online: false });
        return;
      }

      const probeId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingProbes.delete(probeId);
        resolve({ online: false });
      }, timeoutMs);

      this.pendingProbes.set(probeId, {
        start: Date.now(),
        resolve: (res) => {
          clearTimeout(timer);
          resolve(res);
        },
      });

      this.publishCloud(`swiftdesk/v2/host/${cleanId}/in`, {
        type: 'ping-probe',
        probeId,
        replyTopic: this.clientProbeTopic,
      });
    });
  }

  public startClientCloudSession(sessionId: string): void {
    if (this.activeClientSubTopic && this.mqttClient) {
      this.mqttClient.unsubscribe(this.activeClientSubTopic);
    }
    this.activeClientSubTopic = `swiftdesk/v2/client/${sessionId}/in`;
    if (this.mqttClient) {
      this.mqttClient.subscribe(this.activeClientSubTopic, { qos: 0 });
    }
  }

  public stopClientCloudSession(targetDeviceId?: string, sessionId?: string): void {
    if (targetDeviceId && sessionId) {
      const cleanId = normalizeDeviceId(targetDeviceId);
      this.publishCloud(`swiftdesk/v2/host/${cleanId}/in`, {
        type: 'client-disconnect',
        sessionId,
      });
    }
    if (this.activeClientSubTopic && this.mqttClient) {
      this.mqttClient.unsubscribe(this.activeClientSubTopic);
      this.activeClientSubTopic = null;
    }
  }

  public sendClientCloudMessage(targetDeviceId: string, payload: Record<string, unknown>): void {
    const cleanId = normalizeDeviceId(targetDeviceId);
    this.publishCloud(`swiftdesk/v2/host/${cleanId}/in`, payload);
  }

  private publishCloud(topic: string, data: unknown): void {
    if (this.mqttClient && this.cloudConnected) {
      this.mqttClient.publish(topic, JSON.stringify(data), { qos: 0 });
    }
  }

  /** Bytes queued on the broker socket that the network hasn't accepted yet. */
  private cloudBacklogBytes(): number {
    const stream = (this.mqttClient as unknown as { stream?: { writableLength?: number } } | null)?.stream;
    return stream?.writableLength || 0;
  }

  public async start(port?: number): Promise<{ success: boolean; port: number; error?: string }> {
    const targetPort = port || this.store.get().listenPort || 9876;
    await this.stopLocalServer();

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
            version: '1.2.0',
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
        perMessageDeflate: false,
      });

      wss.on('connection', (ws, req) => {
        this.handleWsConnection(ws, req);
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

  private async stopLocalServer(): Promise<void> {
    if (this.wss) {
      await new Promise<void>((r) => this.wss!.close(() => r()));
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((r) => this.httpServer!.close(() => r()));
      this.httpServer = null;
    }
  }

  public async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.sendToSession(session, {
        type: 'session-closed',
        reason: 'Máy chủ đã dừng phiên kết nối.',
      });
      if (session.ws) {
        try {
          session.ws.close(1000, 'Host stopping');
        } catch {}
      }
    }
    this.sessions.clear();
    this.inputController.releaseAllInputs();
    await this.stopLocalServer();
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
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
      this.sendToSession(s, {
        type: 'session-closed',
        reason: 'Máy chủ đã ngắt kết nối phiên này.',
      });
      if (s.ws) {
        try {
          s.ws.close(1000, 'Disconnected by host');
        } catch {}
      }
      this.sessions.delete(sessionId);
      this.inputController.releaseAllInputs();
      this.notifyRenderer('host:peer-disconnected', { sessionId });
      this.notifySessionsUpdated();
    }
  }

  public sendSignalToClient(sessionId: string, payload: Record<string, unknown>): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      this.sendToSession(s, payload);
    }
  }

  private sendToSession(session: ClientSession, payload: unknown): void {
    // Relay frames are disposable: drop them when the link is backed up instead of buffering
    // megabytes of JPEG (which also delays pings, signaling and input behind them)
    const isVideoFrame = (payload as { type?: string })?.type === 'video-frame';
    if (session.transport === 'ws' && session.ws) {
      if (session.ws.readyState === WebSocket.OPEN) {
        if (isVideoFrame && session.ws.bufferedAmount > MAX_RELAY_BACKLOG_BYTES) return;
        session.ws.send(JSON.stringify(payload));
      }
    } else if (session.transport === 'cloud' && session.replyTopic) {
      if (isVideoFrame && this.cloudBacklogBytes() > MAX_RELAY_BACKLOG_BYTES) return;
      this.publishCloud(session.replyTopic, payload);
    }
  }

  /** Ends every authenticated session (used when the host renderer dies). */
  public disconnectAllSessions(): void {
    for (const s of [...this.sessions.values()]) {
      if (s.authenticated) this.disconnectSession(s.sessionId);
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

  private handleWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const sessionId = crypto.randomUUID();
    const rawIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const cfg = this.store.get();

    const session: ClientSession = {
      sessionId,
      transport: 'ws',
      ws,
      remoteIp: rawIp,
      authenticated: false,
      webrtcStarted: false,
      quality: 'ultra',
      controllerId: '',
      controllerName: 'Unknown Device',
      platform: 'unknown',
      authMethod: 'password',
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    };

    this.sessions.set(sessionId, session);

    this.sendToSession(session, {
      type: 'hello',
      sessionId,
      hostInfo: {
        deviceId: cfg.deviceId,
        deviceName: cfg.deviceName,
        platform: process.platform,
        port: this.currentPort,
        version: '1.2.0',
      },
    });

    ws.on('message', async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        await this.handleClientMessage(session, msg);
      } catch (err) {
        console.error('[SignalingServer] Invalid WS message:', err);
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

  private triggerHostWebRTCIfNeeded(session: ClientSession): void {
    if (session.webrtcStarted) return;
    session.webrtcStarted = true;
    this.notifyRenderer('host:start-webrtc', {
      sessionId: session.sessionId,
      sourceId: session.primarySourceId,
      displayId: session.primaryDisplayId,
      quality: session.quality,
      transport: session.transport,
    });
  }

  private async handleClientMessage(session: ClientSession, msg: any): Promise<void> {
    if (msg.type === 'ping') {
      this.sendToSession(session, { type: 'pong', ts: msg.ts });
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

      if (trustToken && this.store.verifyTrustToken(controllerId, trustToken)) {
        authenticated = true;
        authMethod = 'trust-token';
      } else if (password && this.store.verifyPassword(password)) {
        authenticated = true;
        authMethod = 'password';
      }

      if (!authenticated) {
        const reason =
          trustToken && !password ? 'TOKEN_EXPIRED_OR_INVALID' : 'INVALID_PASSWORD';
        this.sendToSession(session, {
          type: 'auth-failed',
          reason,
          message:
            reason === 'TOKEN_EXPIRED_OR_INVALID'
              ? 'Phiên đăng nhập tự động đã hết hạn. Vui lòng nhập mật khẩu của máy đích.'
              : 'Mật khẩu không chính xác. Vui lòng kiểm tra lại.',
        });
        if (session.transport === 'cloud') {
          this.sessions.delete(session.sessionId);
        }
        return;
      }

      const issuedTrustToken = this.store.issueTrustToken(controllerId, controllerName, platform);
      const displays = await this.getDisplaySources();
      const primaryDisplay = displays.find((d) => d.isPrimary) || displays[0];
      const cfg = this.store.get();

      session.authenticated = true;
      session.controllerId = controllerId;
      session.controllerName = controllerName;
      session.platform = platform;
      session.authMethod = authMethod;
      session.quality = quality;
      session.primarySourceId = primaryDisplay?.id;
      session.primaryDisplayId = primaryDisplay?.displayId;
      session.connectedAt = Date.now();

      this.sendToSession(session, {
        type: 'auth-success',
        sessionId: session.sessionId,
        trustToken: issuedTrustToken,
        hostInfo: {
          deviceId: cfg.deviceId,
          deviceName: cfg.deviceName,
          platform: process.platform,
          port: this.currentPort,
          version: '1.2.0',
        },
        localIps: getLocalNetworkInterfaces().map((n) => n.address),
        displays,
      });

      this.notifySessionsUpdated();

      // Safety fallback if client-webrtc-ready takes > 600ms
      setTimeout(() => {
        if (this.sessions.has(session.sessionId)) {
          this.triggerHostWebRTCIfNeeded(session);
        }
      }, 600);
      return;
    }

    if (!session.authenticated) {
      return;
    }

    if (msg.type === 'client-webrtc-ready') {
      this.triggerHostWebRTCIfNeeded(session);
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
      case 'change-quality':
      case 'request-frame-relay':
      case 'frame-ack': {
        this.notifyRenderer('host:signal-from-client', {
          sessionId: session.sessionId,
          ...msg,
        });
        break;
      }
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
