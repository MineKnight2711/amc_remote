/// <reference lib="dom" />

(() => {
  interface NetworkInterfaceInfo {
    name: string;
    address: string;
    type: 'vpn' | 'lan' | 'other';
    label: string;
  }

  interface SavedDevice {
    id: string;
    deviceId?: string;
    name: string;
    ip: string;
    port: number;
    connectionMode?: 'cloud-id' | 'direct-ip';
    platform: string;
    trustToken: string;
    savedPassword?: string;
    lastConnectedAt: number;
    online?: boolean;
    latencyMs?: number;
  }

  interface TrustedController {
    controllerId: string;
    controllerName: string;
    platform: string;
    tokenHash: string;
    createdAt: number;
    lastUsedAt: number;
  }

  interface AppConfig {
    deviceId: string;
    deviceName: string;
    listenPort: number;
    password: string;
    autoStart: boolean;
    minimizeToTray: boolean;
    defaultQuality: 'ultra' | 'balanced' | 'low';
    allowClipboardSync: boolean;
    mapCtrlToCmd: boolean;
    viewerResolution: string;
    savedDevices: SavedDevice[];
    trustedControllers: TrustedController[];
  }

  interface DisplaySourceInfo {
    id: string;
    displayId: string;
    name: string;
    width: number;
    height: number;
    scaleFactor: number;
    isPrimary: boolean;
  }

  const swiftdesk = (window as any).swiftdesk;

  // --- State ---
  let currentConfig: AppConfig;
  let currentPlatform = 'win32';
  let localNetworks: NetworkInterfaceInfo[] = [];

  // Host WebRTC Sessions (when other machines control this computer)
  interface HostPeerSession {
    sessionId: string;
    pc: RTCPeerConnection;
    stream: MediaStream | null;
    videoSender: RTCRtpSender | null;
    fastChannel: RTCDataChannel | null;
    reliableChannel: RTCDataChannel | null;
    pendingIce: RTCIceCandidateInit[];
    remoteDescSet: boolean;
    activeDisplayId: string;
    quality: 'ultra' | 'balanced' | 'low';
    frameRelayTimer: number | null;
    relayInFlight: number;
    relayLastAckAt: number;
    relayLastSentAt: number;
    relayLastDataUrl: string;
    relayFrameId: number;
    relayVideoEl: HTMLVideoElement | null;
    relayCanvas: HTMLCanvasElement | null;
    lastPointerSeq: number;
    statsTimer: number | null;
    maxResolution: MaxResolution | null;
  }

  interface MaxResolution {
    width: number;
    height: number;
  }
  const hostPeers = new Map<string, HostPeerSession>();

  // Client Viewer State (when this computer controls a remote machine)
  let clientTransport: 'ws' | 'cloud' = 'cloud';
  let clientSessionId = '';
  let clientTargetDeviceId = '';
  let clientWs: WebSocket | null = null;
  let clientPc: RTCPeerConnection | null = null;
  let clientFastChannel: RTCDataChannel | null = null;
  let clientReliableChannel: RTCDataChannel | null = null;
  let clientPendingIce: RTCIceCandidateInit[] = [];
  let clientRemoteDescSet = false;
  let clientUsedPassword = '';
  let clientQuality: 'ultra' | 'balanced' | 'low' = 'ultra';
  let clientConnectTimer: number | null = null;
  let clientWebRtcFallbackTimer: number | null = null;
  let clientHasWebRtcVideo = false;
  let clientNatOwner = '';
  let lastHostStats: {
    fps: number;
    width: number;
    height: number;
    srcWidth?: number;
    srcHeight?: number;
    limit: string;
    encoder: string;
    codec: string;
  } | null = null;
  let lastDiagnostics = '';

  let activeRemoteDisplayId = '';
  let activeRemoteDisplays: DisplaySourceInfo[] = [];
  let activeRemotePlatform = '';
  let activeRemoteTargetLabel = '';
  let activeRemoteIp = '';
  let activeRemotePort = 9876;
  let clientPingTimer: number | null = null;
  let clientStatsTimer: number | null = null;
  let currentPingMs = 1;
  let lastFramesDecoded = 0;
  let lastStatsTime = performance.now();
  let relayFramesCount = 0;
  let isOriginalScale = false;

  // RTC Configuration with STUN only. The free openrelay.metered.ca TURN no longer issues relay
  // candidates; when P2P is impossible (symmetric NAT / CGNAT) the session falls back to frame relay.
  const RTC_CONFIG: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };

  /**
   * RTCSessionDescription / RTCIceCandidate expose their fields as prototype getters, so passing
   * them through contextBridge / IPC yields an empty `{}`. Always convert to plain objects first!
   */
  function toPlainSdp(desc: RTCSessionDescription | null): RTCSessionDescriptionInit | null {
    return desc ? { type: desc.type, sdp: desc.sdp } : null;
  }

  function isValidSdp(sdp: any): sdp is RTCSessionDescriptionInit {
    return !!sdp && typeof sdp.type === 'string' && typeof sdp.sdp === 'string' && sdp.sdp.length > 0;
  }

  /**
   * If our router supports UPnP and has a public IPv4, forward the UDP port of the LAN host candidate
   * and advertise publicIP:port as an extra candidate. One reachable side is enough for P2P, even when
   * the other side is behind a symmetric / carrier-grade NAT where STUN hole punching cannot work.
   */
  async function advertiseUpnpCandidate(
    owner: string,
    cand: RTCIceCandidate,
    send: (init: RTCIceCandidateInit) => void
  ): Promise<void> {
    if (cand.type !== 'host' || cand.protocol !== 'udp' || !cand.address || !cand.port) return;
    if (cand.address.includes(':')) return; // IPv6 needs no NAT mapping
    const mapping: { externalIp: string; externalPort: number } | null = await swiftdesk
      .mapUdpPort(owner, cand.address, cand.port)
      .catch(() => null);
    if (!mapping) return;

    const priority = 100 * 2 ** 24 + 65535 * 2 ** 8 + 255; // srflx type preference, component 1
    const foundation = String(Math.floor(Math.random() * 1e9));
    send({
      candidate:
        `candidate:${foundation} 1 udp ${priority} ${mapping.externalIp} ${mapping.externalPort} ` +
        `typ srflx raddr ${cand.address} rport ${cand.port} generation 0`,
      sdpMid: cand.sdpMid,
      sdpMLineIndex: cand.sdpMLineIndex,
      usernameFragment: cand.usernameFragment,
    });
  }

  /** Human-readable path of the selected ICE candidate pair, e.g. "P2P IPv6". */
  function describeIcePath(local: any, remote: any): string {
    if (!local || !remote) return 'P2P';
    if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'TURN';
    if (String(remote.address || '').includes(':')) return 'P2P IPv6';
    if (local.candidateType === 'host' && remote.candidateType === 'host') return 'P2P LAN';
    return 'P2P IPv4';
  }

  /** e.g. "host4 host6 srflx4" — tells at a glance whether a side offered IPv6 / public candidates. */
  function summarizeCandidates(reports: Map<string, any>, type: 'local-candidate' | 'remote-candidate'): string {
    const kinds = new Set<string>();
    for (const r of reports.values()) {
      if (r.type !== type) continue;
      kinds.add(`${r.candidateType}${String(r.address || '').includes(':') ? '6' : '4'}`);
    }
    return [...kinds].sort().join(' ') || 'none';
  }

  /**
   * Boosts WebRTC SDP video bitrate so Chromium immediately encodes at full sharpness
   * (12–25 Mbps start/max bitrate instead of WebRTC's default 300 kbps ramp-up).
   * The sender reads these from the REMOTE description, so only the host applies it to the answer.
   */
  function boostSdpVideoBitrate(sdp: string, quality: 'ultra' | 'balanced' | 'low'): string {
    const startKbps = quality === 'ultra' ? 12000 : quality === 'balanced' ? 6000 : 2500;
    const maxKbps = quality === 'ultra' ? 25000 : quality === 'balanced' ? 10000 : 4000;
    // A high floor forces congestion + packet loss on slower links, which collapses FPS
    const minKbps = quality === 'ultra' ? 1000 : quality === 'balanced' ? 600 : 300;

    return sdp
      .split('\r\n')
      .map((line) => {
        if (line.startsWith('a=fmtp:') && !line.includes('x-google-max-bitrate')) {
          return `${line};x-google-min-bitrate=${minKbps};x-google-start-bitrate=${startKbps};x-google-max-bitrate=${maxKbps}`;
        }
        return line;
      })
      .join('\r\n');
  }

  // --- DOM Elements ---
  const elCloudStatusText = document.getElementById('cloud-status-text')!;
  const elOsBadgeText = document.getElementById('os-badge-text')!;
  const elMacBanner = document.getElementById('mac-permission-banner')!;
  const elBtnMacPermissions = document.getElementById('btn-mac-permissions')!;
  const elIncomingBanner = document.getElementById('incoming-session-banner')!;
  const elIncomingTitle = document.getElementById('incoming-title')!;
  const elIncomingSubtitle = document.getElementById('incoming-subtitle')!;
  const elIncomingActions = document.getElementById('incoming-session-actions')!;

  const elBtnCopyCloudId = document.getElementById('btn-copy-cloud-id')!;
  const elHostCloudId = document.getElementById('host-cloud-id')!;
  const elHostDeviceName = document.getElementById('host-device-name')!;
  const elHostPortDisplay = document.getElementById('host-port-display')!;
  const elNetworkList = document.getElementById('network-list')!;
  const elBtnRefreshNet = document.getElementById('btn-refresh-net')!;

  const elHostPassInput = document.getElementById('host-password-input') as HTMLInputElement;
  const elBtnTogglePass = document.getElementById('btn-toggle-pass')!;
  const elBtnRandomPass = document.getElementById('btn-random-pass')!;
  const elBtnSavePass = document.getElementById('btn-save-pass')!;

  const elChkAutostart = document.getElementById('chk-autostart') as HTMLInputElement;
  const elChkMinimizeTray = document.getElementById('chk-minimize-tray') as HTMLInputElement;
  const elChkClipboardSync = document.getElementById('chk-clipboard-sync') as HTMLInputElement;
  const elInputDeviceName = document.getElementById('input-device-name') as HTMLInputElement;
  const elInputListenPort = document.getElementById('input-listen-port') as HTMLInputElement;
  const elBtnSaveHostCfg = document.getElementById('btn-save-host-cfg')!;

  const elConnectForm = document.getElementById('connect-form') as HTMLFormElement;
  const elRemoteIpInput = document.getElementById('remote-ip-input') as HTMLInputElement;
  const elRemotePassInput = document.getElementById('remote-password-input') as HTMLInputElement;
  const elRemoteQualitySelect = document.getElementById('remote-quality-select') as HTMLSelectElement;
  const elConnectStatusMsg = document.getElementById('connect-status-msg')!;
  const elBtnConnectNow = document.getElementById('btn-connect-now') as HTMLButtonElement;

  const elSavedDevicesGrid = document.getElementById('saved-devices-grid')!;
  const elBtnPingSaved = document.getElementById('btn-ping-saved')!;
  const elTrustedList = document.getElementById('trusted-controllers-list')!;

  // Viewer Overlay Elements
  const elViewerOverlay = document.getElementById('viewer-overlay')!;
  const elViewerHostName = document.getElementById('viewer-host-name')!;
  const elViewerHostIp = document.getElementById('viewer-host-ip')!;
  const elViewerStats = document.getElementById('viewer-stats')!;
  const elStatFps = document.getElementById('stat-fps')!;
  const elStatPing = document.getElementById('stat-ping')!;
  const elStatRes = document.getElementById('stat-res')!;
  const elViewerDisplaySelect = document.getElementById('viewer-display-select') as HTMLSelectElement;
  const elViewerQualitySelect = document.getElementById('viewer-quality-select') as HTMLSelectElement;
  const elBtnViewerScale = document.getElementById('btn-viewer-scale')!;
  const elBtnViewerClipboard = document.getElementById('btn-viewer-clipboard')!;
  const elBtnViewerAltTab = document.getElementById('btn-viewer-alttab')!;
  const elBtnViewerWinKey = document.getElementById('btn-viewer-winkey')!;
  const elBtnViewerCtrlCmd = document.getElementById('btn-viewer-ctrlcmd')!;
  const elBtnViewerKeys = document.getElementById('btn-viewer-keys')!;
  const elViewerKeysMenu = document.getElementById('viewer-keys-menu')!;
  const elKbdAltTab = document.getElementById('kbd-alttab')!;
  const elKbdWinKey = document.getElementById('kbd-winkey')!;
  const elStatPath = document.getElementById('stat-path')!;
  const elViewerResSelect = document.getElementById('viewer-res-select') as HTMLSelectElement;
  const elResPopover = document.getElementById('viewer-res-popover')!;
  const elResCustomW = document.getElementById('res-custom-w') as HTMLInputElement;
  const elResCustomH = document.getElementById('res-custom-h') as HTMLInputElement;
  const elBtnResCustomApply = document.getElementById('btn-res-custom-apply')!;
  const elBtnResCustomCancel = document.getElementById('btn-res-custom-cancel')!;
  const elBtnViewerFullscreen = document.getElementById('btn-viewer-fullscreen')!;
  const elBtnViewerDisconnect = document.getElementById('btn-viewer-disconnect')!;
  const elViewerStage = document.getElementById('viewer-stage')!;
  const elRemoteVideo = document.getElementById('remote-video') as HTMLVideoElement;
  const elRemoteCanvas = document.getElementById('remote-canvas') as HTMLCanvasElement;
  const elViewerLoading = document.getElementById('viewer-loading')!;
  const elViewerLoadingText = document.getElementById('viewer-loading-text')!;

  // --- Helpers ---
  function showToast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
    const container = document.getElementById('toast-container')!;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3400);
  }

  function formatPlatform(platform: string): string {
    if (platform === 'win32') return 'Windows';
    if (platform === 'darwin') return 'macOS';
    if (platform === 'linux') return 'Linux';
    return platform;
  }

  function isCloudDeviceId(raw: string): boolean {
    const trimmed = raw.trim();
    return /^\d{3}[-\s]?\d{3}[-\s]?\d{3}$/.test(trimmed);
  }

  function formatDeviceIdDisplay(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 9) {
      return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}`;
    }
    return raw.trim();
  }

  function parseIpPort(raw: string, fallbackPort = 9876): { ip: string; port: number } {
    const trimmed = raw.trim().replace(/^ws:\/\//i, '').replace(/^http:\/\//i, '');
    const parts = trimmed.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      return { ip: parts[0].trim(), port: parseInt(parts[1], 10) };
    }
    return { ip: trimmed, port: fallbackPort };
  }

  // --- Render UI Functions ---
  function renderConfigUI(): void {
    if (!currentConfig) return;
    elHostCloudId.textContent = currentConfig.deviceId;
    elOsBadgeText.textContent = `${formatPlatform(currentPlatform)} • Tự khởi động: ${
      currentConfig.autoStart ? 'BẬT' : 'TẮT'
    }`;

    elHostDeviceName.textContent = currentConfig.deviceName;
    elHostPortDisplay.textContent = String(currentConfig.listenPort);
    elHostPassInput.value = currentConfig.password;

    elChkAutostart.checked = currentConfig.autoStart;
    elChkMinimizeTray.checked = currentConfig.minimizeToTray;
    elChkClipboardSync.checked = currentConfig.allowClipboardSync;
    elInputDeviceName.value = currentConfig.deviceName;
    elInputListenPort.value = String(currentConfig.listenPort);
    elRemoteQualitySelect.value = currentConfig.defaultQuality || 'ultra';

    renderNetworks();
    renderSavedDevices(currentConfig.savedDevices);
    renderTrustedControllers(currentConfig.trustedControllers);
  }

  function renderNetworks(): void {
    elNetworkList.innerHTML = '';
    const port = currentConfig?.listenPort || 9876;

    if (!localNetworks || localNetworks.length === 0) {
      elNetworkList.innerHTML = `<div class="help-text">Sử dụng Mã ID phía trên để kết nối qua Internet.</div>`;
      return;
    }

    for (const net of localNetworks) {
      const fullAddr = `${net.address}:${port}`;
      const item = document.createElement('div');
      item.className = 'net-item';
      item.title = 'Nhấn để sao chép địa chỉ IP nội bộ';
      item.innerHTML = `
        <div class="net-left">
          <span class="net-badge ${net.type}">${net.type === 'vpn' ? 'VPN' : 'LAN'}</span>
          <div>
            <div class="net-ip">${fullAddr}</div>
            <div class="net-label">${net.label}</div>
          </div>
        </div>
        <span class="copy-tag">Sao chép</span>
      `;
      item.addEventListener('click', async () => {
        await swiftdesk.writeClipboard(fullAddr);
        showToast(`Đã sao chép địa chỉ ${fullAddr}`, 'success');
      });
      elNetworkList.appendChild(item);
    }
  }

  function renderSavedDevices(devices: SavedDevice[]): void {
    elSavedDevicesGrid.innerHTML = '';
    if (!devices || devices.length === 0) {
      elSavedDevicesGrid.innerHTML = `
        <div class="empty-state">
          Chưa có thiết bị nào được lưu.<br/>
          Khi bạn kết nối điều khiển một máy bằng <strong>Mã ID</strong> hoặc <strong>IP</strong> thành công lần đầu tiên, máy đó sẽ tự động lưu tại đây để lần sau <strong>kết nối 1-chạm không cần nhập lại mật khẩu</strong>.
        </div>
      `;
      return;
    }

    for (const dev of devices) {
      const card = document.createElement('div');
      card.className = 'device-card';

      const isOnline = dev.online === true;
      const statusClass = isOnline ? 'online' : 'offline';
      const statusLabel = isOnline
        ? `● Online ${dev.latencyMs ? `(${dev.latencyMs}ms)` : ''}`
        : '○ Offline';
      const osShort = dev.platform === 'darwin' ? 'Mac' : dev.platform === 'win32' ? 'Win' : 'PC';
      const isCloud =
        dev.connectionMode === 'cloud-id' || isCloudDeviceId(dev.ip) || isCloudDeviceId(dev.id);
      const addrDisplay = isCloud
        ? `Mã ID: ${dev.deviceId || dev.ip}`
        : `${dev.ip}:${dev.port}`;
      const lastDate = new Date(dev.lastConnectedAt).toLocaleString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
      });

      card.innerHTML = `
        <div>
          <div class="device-card-top">
            <div class="device-title-row">
              <div class="device-os-icon">${osShort}</div>
              <div>
                <div class="device-name">${escapeHtml(dev.name)}</div>
                <div class="device-ip">${escapeHtml(addrDisplay)}</div>
              </div>
            </div>
            <span class="device-status-badge ${statusClass}">${statusLabel}</span>
          </div>
        </div>

        <div class="device-meta">
          <span class="trust-pill">✓ Đã lưu xác thực 1-chạm</span>
          <span>Lần cuối: ${lastDate}</span>
        </div>

        <div class="device-actions">
          <button class="btn btn-accent btn-sm btn-connect-saved">⚡ Kết nối ngay</button>
          <button class="btn btn-ghost btn-sm btn-rename-saved" title="Đổi tên gợi nhớ">Đổi tên</button>
          <button class="btn btn-danger btn-sm btn-delete-saved" title="Xóa khỏi danh sách">✕</button>
        </div>
      `;

      const btnConnect = card.querySelector('.btn-connect-saved')!;
      btnConnect.addEventListener('click', () => {
        if (isCloud) {
          connectViaCloudId({
            targetDeviceId: dev.deviceId || dev.ip || dev.id,
            password: dev.savedPassword || '',
            trustToken: dev.trustToken || '',
          });
        } else {
          connectViaDirectIp({
            ip: dev.ip,
            port: dev.port,
            password: dev.savedPassword || '',
            trustToken: dev.trustToken || '',
          });
        }
      });

      const btnRename = card.querySelector('.btn-rename-saved')!;
      btnRename.addEventListener('click', async () => {
        const newName = prompt('Nhập tên gợi nhớ cho thiết bị này:', dev.name);
        if (newName && newName.trim()) {
          const updated = await swiftdesk.renameSavedDevice(dev.id, newName.trim());
          currentConfig.savedDevices = updated;
          renderSavedDevices(updated);
          showToast('Đã cập nhật tên thiết bị', 'success');
        }
      });

      const btnDelete = card.querySelector('.btn-delete-saved')!;
      btnDelete.addEventListener('click', async () => {
        const updated = await swiftdesk.removeSavedDevice(dev.id);
        currentConfig.savedDevices = updated;
        renderSavedDevices(updated);
        showToast('Đã xóa thiết bị khỏi danh sách lưu', 'info');
      });

      elSavedDevicesGrid.appendChild(card);
    }
  }

  function renderTrustedControllers(controllers: TrustedController[]): void {
    elTrustedList.innerHTML = '';
    if (!controllers || controllers.length === 0) {
      elTrustedList.innerHTML = `<div class="help-text">Chưa có thiết bị nào được cấp quyền truy cập nhanh vào máy này.</div>`;
      return;
    }

    for (const c of controllers) {
      const row = document.createElement('div');
      row.className = 'trusted-item';
      const lastUsed = new Date(c.lastUsedAt).toLocaleString('vi-VN');
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(c.controllerName)}</strong>
          <span class="help-text"> (${formatPlatform(c.platform)} • Kết nối gần nhất: ${lastUsed})</span>
        </div>
        <button class="btn btn-danger btn-sm">Thu hồi quyền</button>
      `;
      row.querySelector('button')!.addEventListener('click', async () => {
        const updated = await swiftdesk.revokeTrustedController(c.controllerId);
        currentConfig.trustedControllers = updated;
        renderTrustedControllers(updated);
        showToast(`Đã thu hồi quyền truy cập tự động của ${c.controllerName}`, 'info');
      });
      elTrustedList.appendChild(row);
    }
  }

  function renderActiveIncomingSessions(sessions: any[]): void {
    if (!sessions || sessions.length === 0) {
      elIncomingBanner.classList.add('hidden');
      return;
    }
    elIncomingBanner.classList.remove('hidden');
    const first = sessions[0];
    elIncomingTitle.textContent = `Thiết bị "${first.controllerName}" đang điều khiển máy của bạn`;
    elIncomingSubtitle.textContent = `${first.remoteIp} • Xác thực: ${
      first.authMethod === 'trust-token' ? 'Thiết bị tin cậy đã lưu' : 'Mật khẩu'
    }`;
    elIncomingActions.innerHTML = '';

    for (const s of sessions) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-danger btn-sm';
      btn.textContent = `Ngắt kết nối (${s.controllerName})`;
      btn.addEventListener('click', async () => {
        const remaining = await swiftdesk.disconnectSession(s.sessionId);
        renderActiveIncomingSessions(remaining);
      });
      elIncomingActions.appendChild(btn);
    }
  }

  function escapeHtml(str: string): string {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============================================================================
  // PART 1: HOST WEBRTC 60FPS NATIVE RESOLUTION ENGINE
  // ============================================================================

  async function captureDisplayStream(
    sourceId: string,
    quality: 'ultra' | 'balanced' | 'low'
  ): Promise<MediaStream> {
    const maxFps = quality === 'low' ? 30 : 60;
    const maxWidth = quality === 'low' ? 1920 : 3840;
    const maxHeight = quality === 'low' ? 1080 : 2160;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minFrameRate: 30,
          maxFrameRate: maxFps,
          maxWidth,
          maxHeight,
        },
      } as any,
    });

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      applyContentHint(videoTrack, quality);
    }
    return stream;
  }

  /**
   * Chromium (Electron 33) ignores RTCRtpSendParameters.degradationPreference, so contentHint is what
   * decides what WebRTC sacrifices under CPU/bandwidth pressure:
   * 'detail' keeps native resolution (drops FPS), 'motion' keeps FPS (drops resolution).
   */
  function applyContentHint(track: MediaStreamTrack, quality: 'ultra' | 'balanced' | 'low'): void {
    if ('contentHint' in track) {
      track.contentHint = quality === 'ultra' ? 'detail' : 'motion';
    }
  }

  /**
   * Electron encodes screen content in software (H.264 = OpenH264, not the GPU), so pick the fastest
   * software screen codec. Measured on 2560x1600 full-screen motion: VP9 ~56 FPS, AV1 ~57, VP8 ~35-45,
   * H.264 only ~15 FPS. VP9 is preferred over AV1 since it is mature and hardware-decoded almost everywhere.
   */
  const SCREEN_CODEC_ORDER = ['video/vp9', 'video/av1', 'video/vp8', 'video/h264'];

  function preferFastScreenCodec(pc: RTCPeerConnection, sender: RTCRtpSender): void {
    const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
    const capabilities = RTCRtpReceiver.getCapabilities('video');
    if (!transceiver || !capabilities || typeof transceiver.setCodecPreferences !== 'function') return;

    const rank = (codec: RTCRtpCodec): number => {
      const idx = SCREEN_CODEC_ORDER.indexOf(codec.mimeType.toLowerCase());
      // RTX / RED / FEC keep their relative order after the media codecs
      return idx === -1 ? SCREEN_CODEC_ORDER.length : idx;
    };
    const sorted = capabilities.codecs
      .map((codec, idx) => ({ codec, idx }))
      .sort((a, b) => rank(a.codec) - rank(b.codec) || a.idx - b.idx)
      .map((entry) => entry.codec);
    try {
      transceiver.setCodecPreferences(sorted);
    } catch (err) {
      console.warn('[HostWebRTC] Could not set codec preferences:', err);
    }
  }

  /**
   * Downscale factor that fits the captured frame inside the viewer's max resolution, keeping the
   * aspect ratio and never upscaling. HiDPI screens are captured in physical pixels (a Mac "looking
   * like 2560x1440" on a 4K panel streams 3840x2160), which is often far more than the viewer needs.
   */
  function resolutionScale(track: MediaStreamTrack | undefined, maxRes: MaxResolution | null): number {
    if (!track || !maxRes) return 1;
    const { width, height } = track.getSettings();
    if (!width || !height) return 1;
    return Math.max(1, width / maxRes.width, height / maxRes.height);
  }

  async function tuneSenderEncoding(peer: HostPeerSession): Promise<void> {
    const sender = peer.videoSender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const bitrateMap = {
        ultra: 25_000_000, // 25 Mbps for crystal-clear 2560x1440 / 4K at 60FPS
        balanced: 10_000_000, // 10 Mbps
        low: 3_500_000, // 3.5 Mbps
      };
      params.encodings[0].maxBitrate = bitrateMap[peer.quality] || 20_000_000;
      params.encodings[0].maxFramerate = peer.quality === 'low' ? 30 : 60;
      params.encodings[0].scaleResolutionDownBy = resolutionScale(
        peer.stream?.getVideoTracks()[0],
        peer.maxResolution
      );
      await sender.setParameters(params);
    } catch (err) {
      console.warn('[HostWebRTC] Could not set sender encoding parameters:', err);
    }
  }

  function bindHostDataChannel(channel: RTCDataChannel, sessionId: string): void {
    // Viewer vanished without a clean disconnect (network drop, crash): never leave keys held down
    channel.onclose = () => swiftdesk.releaseHostInputs();
    channel.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'dc-ping') {
          if (channel.readyState === 'open') {
            channel.send(JSON.stringify({ type: 'dc-pong', ts: msg.ts }));
          }
          return;
        }
        if (msg.type === 'input' && msg.event) {
          const peer = hostPeers.get(sessionId);
          // 'input-fast' is unordered: drop a mousemove older than the last pointer event applied,
          // otherwise a late packet yanks the cursor back to a stale position
          if (peer && typeof msg.event.seq === 'number') {
            if (msg.event.type === 'mousemove' && msg.event.seq <= peer.lastPointerSeq) return;
            peer.lastPointerSeq = Math.max(peer.lastPointerSeq, msg.event.seq);
          }
          msg.event.displayId = peer?.activeDisplayId || msg.event.displayId;
          swiftdesk.sendHostInputEvent(msg.event);
        }
      } catch {}
    };
  }

  // Frame relay (used only when WebRTC P2P cannot connect) travels through the cloud broker, where
  // a round trip costs ~0.5s. Keep a few frames in flight so FPS isn't capped at 1 / RTT.
  const RELAY_MAX_IN_FLIGHT = 3;
  const RELAY_ACK_TIMEOUT_MS = 1500;
  const RELAY_REFRESH_MS = 1000;

  function startHostFrameRelayFallback(peer: HostPeerSession): void {
    if (peer.frameRelayTimer || !peer.stream) return;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = peer.stream;
    video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });

    peer.relayVideoEl = video;
    peer.relayCanvas = canvas;
    peer.relayInFlight = 0;
    peer.relayLastAckAt = performance.now();
    peer.relayLastDataUrl = '';

    peer.frameRelayTimer = window.setInterval(() => {
      if (!video.videoWidth || !video.videoHeight || !ctx) return;
      const now = performance.now();
      if (peer.relayInFlight >= RELAY_MAX_IN_FLIGHT) {
        // Flow-control: never queue up frames or lag ping, but recover if an ack was lost (QoS 0)
        if (now - peer.relayLastAckAt < RELAY_ACK_TIMEOUT_MS) return;
        peer.relayInFlight = 0;
      }

      // JPEG relay is bandwidth-bound: cap at 1920 (1280 for low), and at the viewer's max resolution
      const targetW = Math.min(peer.quality === 'low' ? 1280 : 1920, peer.maxResolution?.width ?? Infinity);
      const targetH = peer.maxResolution?.height ?? Infinity;
      const scale = Math.min(1, targetW / video.videoWidth, targetH / video.videoHeight);
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const jpegQuality = peer.quality === 'ultra' ? 0.7 : peer.quality === 'balanced' ? 0.6 : 0.5;
      const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);

      // Static screen: skip identical frames so bandwidth goes to frames that actually changed
      if (dataUrl === peer.relayLastDataUrl && now - peer.relayLastSentAt < RELAY_REFRESH_MS) return;
      peer.relayLastDataUrl = dataUrl;
      peer.relayLastSentAt = now;
      peer.relayInFlight++;
      swiftdesk.sendSignalToClient(peer.sessionId, {
        type: 'video-frame',
        frameId: ++peer.relayFrameId,
        dataUrl,
        width: w,
        height: h,
      });
    }, 50);
  }

  function stopHostFrameRelay(peer: HostPeerSession): void {
    if (peer.frameRelayTimer) {
      clearInterval(peer.frameRelayTimer);
      peer.frameRelayTimer = null;
    }
    if (peer.relayVideoEl) {
      peer.relayVideoEl.srcObject = null;
      peer.relayVideoEl = null;
    }
    peer.relayCanvas = null;
    peer.relayLastDataUrl = '';
  }

  async function startHostWebRTCSession(data: {
    sessionId: string;
    sourceId: string;
    displayId: string;
    quality: 'ultra' | 'balanced' | 'low';
    maxResolution?: MaxResolution | null;
  }): Promise<void> {
    const { sessionId, sourceId, displayId, quality } = data;
    cleanupHostSession(sessionId);

    try {
      const stream = await captureDisplayStream(sourceId, quality);
      const pc = new RTCPeerConnection(RTC_CONFIG);

      // Host MUST create DataChannels BEFORE createOffer so SDP includes m=application SCTP!
      const fastChannel = pc.createDataChannel('input-fast', {
        ordered: false,
        maxRetransmits: 0,
      });
      const reliableChannel = pc.createDataChannel('input-reliable', {
        ordered: true,
      });
      bindHostDataChannel(fastChannel, sessionId);
      bindHostDataChannel(reliableChannel, sessionId);

      pc.ondatachannel = (event) => {
        bindHostDataChannel(event.channel, sessionId);
      };

      const sendIce = (candidate: RTCIceCandidateInit) =>
        swiftdesk.sendSignalToClient(sessionId, { type: 'webrtc-ice', candidate });
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendIce(event.candidate.toJSON());
          advertiseUpnpCandidate(`host:${sessionId}`, event.candidate, sendIce);
        }
      };

      const videoTrack = stream.getVideoTracks()[0];
      const videoSender = pc.addTrack(videoTrack, stream);
      preferFastScreenCodec(pc, videoSender);

      const peerSession: HostPeerSession = {
        sessionId,
        pc,
        stream,
        videoSender,
        fastChannel,
        reliableChannel,
        pendingIce: [],
        remoteDescSet: false,
        activeDisplayId: displayId,
        quality,
        frameRelayTimer: null,
        relayInFlight: 0,
        relayLastAckAt: 0,
        relayLastSentAt: 0,
        relayLastDataUrl: '',
        relayFrameId: 0,
        relayVideoEl: null,
        relayCanvas: null,
        lastPointerSeq: 0,
        statsTimer: null,
        maxResolution: data.maxResolution || null,
      };
      hostPeers.set(sessionId, peerSession);
      await tuneSenderEncoding(peerSession);

      // Share encoder health with the viewer so it can tell CPU/bandwidth limits from network issues
      peerSession.statsTimer = window.setInterval(async () => {
        if (reliableChannel.readyState !== 'open') return;
        try {
          const stats = await pc.getStats();
          stats.forEach((r: any) => {
            if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
            const codec = r.codecId ? (stats as any).get(r.codecId) : null;
            const src = peerSession.stream?.getVideoTracks()[0]?.getSettings();
            reliableChannel.send(
              JSON.stringify({
                type: 'host-stats',
                fps: r.framesPerSecond || 0,
                width: r.frameWidth || 0,
                height: r.frameHeight || 0,
                srcWidth: src?.width || 0,
                srcHeight: src?.height || 0,
                limit: r.qualityLimitationReason || 'none',
                encoder: r.encoderImplementation || '',
                codec: codec?.mimeType || '',
              })
            );
          });
        } catch {}
      }, 2000);

      pc.onconnectionstatechange = () => {
        console.log(`[HostWebRTC] ${sessionId} connection state: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
          stopHostFrameRelay(peerSession);
        }
      };

      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);

      swiftdesk.sendSignalToClient(sessionId, {
        type: 'webrtc-offer',
        sdp: toPlainSdp(pc.localDescription),
        displayId,
      });
    } catch (err) {
      console.error('[HostWebRTC] Failed to start capture:', err);
    }
  }

  async function handleHostSignalFromClient(msg: any): Promise<void> {
    const peer = hostPeers.get(msg.sessionId);
    if (!peer) return;

    if (msg.type === 'webrtc-answer') {
      if (!isValidSdp(msg.sdp)) {
        console.error('[HostWebRTC] Received empty/invalid answer SDP:', msg.sdp);
        return;
      }
      try {
        await peer.pc.setRemoteDescription({
          type: msg.sdp.type,
          sdp: boostSdpVideoBitrate(msg.sdp.sdp || '', peer.quality),
        });
      } catch (err) {
        console.error('[HostWebRTC] setRemoteDescription(answer) failed:', err);
        return;
      }
      peer.remoteDescSet = true;
      for (const cand of peer.pendingIce) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch {}
      }
      peer.pendingIce = [];
    } else if (msg.type === 'webrtc-ice' && msg.candidate) {
      if (!peer.remoteDescSet) {
        peer.pendingIce.push(msg.candidate);
      } else {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch {}
      }
    } else if (msg.type === 'frame-ack') {
      peer.relayInFlight = Math.max(0, peer.relayInFlight - 1);
      peer.relayLastAckAt = performance.now();
    } else if (msg.type === 'request-frame-relay') {
      startHostFrameRelayFallback(peer);
    } else if (msg.type === 'switch-display' && msg.sourceId) {
      try {
        const newStream = await captureDisplayStream(msg.sourceId, peer.quality);
        const newTrack = newStream.getVideoTracks()[0];
        if (peer.videoSender && newTrack) {
          await peer.videoSender.replaceTrack(newTrack);
        }
        peer.relayLastDataUrl = '';
        if (peer.relayVideoEl) {
          peer.relayVideoEl.srcObject = newStream;
        }
        if (peer.stream) {
          peer.stream.getTracks().forEach((t) => t.stop());
        }
        peer.stream = newStream;
        peer.activeDisplayId = String(msg.displayId || '');
        // The new display may have a different capture size: recompute the downscale
        await tuneSenderEncoding(peer);
      } catch (err) {
        console.error('[HostWebRTC] Error switching display:', err);
      }
    } else if (msg.type === 'change-quality' && msg.quality) {
      peer.quality = msg.quality;
      const track = peer.stream?.getVideoTracks()[0];
      if (track) {
        applyContentHint(track, msg.quality);
      }
      await tuneSenderEncoding(peer);
    } else if (msg.type === 'change-resolution') {
      peer.maxResolution = msg.maxResolution || null;
      peer.relayLastDataUrl = '';
      await tuneSenderEncoding(peer);
    }
  }

  function cleanupHostSession(sessionId: string): void {
    const peer = hostPeers.get(sessionId);
    if (!peer) return;
    stopHostFrameRelay(peer);
    if (peer.statsTimer) {
      clearInterval(peer.statsTimer);
      peer.statsTimer = null;
    }
    swiftdesk.releaseUdpMappings(`host:${sessionId}`);
    if (peer.stream) {
      peer.stream.getTracks().forEach((t) => t.stop());
    }
    try {
      peer.pc.close();
    } catch {}
    hostPeers.delete(sessionId);
  }

  // ============================================================================
  // PART 2: CLIENT VIEWER ENGINE (Cloud ID Over Internet & Direct IP)
  // ============================================================================

  function generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function connectViaCloudId(options: {
    targetDeviceId: string;
    password?: string;
    trustToken?: string;
  }): void {
    disconnectClientViewer(false);

    const formattedId = formatDeviceIdDisplay(options.targetDeviceId);
    clientTransport = 'cloud';
    clientTargetDeviceId = formattedId;
    clientSessionId = generateUuid();
    clientQuality = (elRemoteQualitySelect.value as 'ultra' | 'balanced' | 'low') || 'ultra';
    activeRemoteTargetLabel = `ID: ${formattedId}`;
    activeRemoteIp = formattedId;
    activeRemotePort = 0;

    const existingSaved = currentConfig.savedDevices.find(
      (d) =>
        d.id === formattedId ||
        d.deviceId === formattedId ||
        d.ip === formattedId
    );
    const trustTokenToUse = options.trustToken || existingSaved?.trustToken || '';
    const passwordToUse = options.password || existingSaved?.savedPassword || '';
    clientUsedPassword = passwordToUse;

    elConnectStatusMsg.textContent = `Đang kết nối tới Mã ID ${formattedId}...`;
    elBtnConnectNow.disabled = true;

    swiftdesk.startClientCloudSession(clientSessionId);

    if (clientConnectTimer) clearTimeout(clientConnectTimer);
    clientConnectTimer = window.setTimeout(() => {
      elBtnConnectNow.disabled = false;
      elConnectStatusMsg.textContent = `Không tìm thấy thiết bị ${formattedId}. Hãy chắc chắn máy đích đang mở SwiftDesk.`;
      showToast(`Thiết bị ${formattedId} hiện không phản hồi`, 'error');
      swiftdesk.stopClientCloudSession(clientTargetDeviceId, clientSessionId);
    }, 7500);

    swiftdesk.sendClientCloudMessage(formattedId, {
      type: 'auth-request',
      sessionId: clientSessionId,
      controllerId: currentConfig.deviceId,
      controllerName: currentConfig.deviceName,
      platform: currentPlatform,
      password: passwordToUse,
      trustToken: trustTokenToUse,
      quality: clientQuality,
    });
  }

  function connectViaDirectIp(options: {
    ip: string;
    port: number;
    password?: string;
    trustToken?: string;
  }): void {
    disconnectClientViewer(false);

    const { ip, port } = options;
    clientTransport = 'ws';
    clientQuality = (elRemoteQualitySelect.value as 'ultra' | 'balanced' | 'low') || 'ultra';
    activeRemoteIp = ip;
    activeRemotePort = port;
    activeRemoteTargetLabel = `${ip}:${port}`;

    const existingSaved = currentConfig.savedDevices.find(
      (d) => d.ip === ip && d.port === port
    );
    const trustTokenToUse = options.trustToken || existingSaved?.trustToken || '';
    const passwordToUse = options.password || existingSaved?.savedPassword || '';
    clientUsedPassword = passwordToUse;

    elConnectStatusMsg.textContent = `Đang kết nối tới ${ip}:${port}...`;
    elBtnConnectNow.disabled = true;

    const ws = new WebSocket(`ws://${ip}:${port}`);
    clientWs = ws;

    if (clientConnectTimer) clearTimeout(clientConnectTimer);
    clientConnectTimer = window.setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close();
        elBtnConnectNow.disabled = false;
        elConnectStatusMsg.textContent = `Không thể kết nối tới ${ip}:${port}. Bạn có thể nhập Mã ID 9 số của máy đích.`;
        showToast(`Không phản hồi từ ${ip}:${port}`, 'error');
      }
    }, 6000);

    ws.onopen = () => {
      if (clientConnectTimer) clearTimeout(clientConnectTimer);
      elConnectStatusMsg.textContent = 'Đang xác thực bảo mật...';
      ws.send(
        JSON.stringify({
          type: 'auth-request',
          controllerId: currentConfig.deviceId,
          controllerName: currentConfig.deviceName,
          platform: currentPlatform,
          password: passwordToUse,
          trustToken: trustTokenToUse,
          quality: clientQuality,
        })
      );
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await handleClientSignalingMessage(msg);
      } catch (err) {
        console.error('[ClientViewer] WS Message error:', err);
      }
    };

    ws.onclose = () => {
      if (clientConnectTimer) clearTimeout(clientConnectTimer);
      elBtnConnectNow.disabled = false;
      if (!elViewerOverlay.classList.contains('hidden') && clientTransport === 'ws') {
        showToast('Phiên điều khiển từ xa đã kết thúc', 'info');
        disconnectClientViewer(false);
      }
    };

    ws.onerror = () => {
      if (clientConnectTimer) clearTimeout(clientConnectTimer);
      elBtnConnectNow.disabled = false;
    };
  }

  async function handleClientSignalingMessage(msg: any): Promise<void> {
    if (clientConnectTimer) {
      clearTimeout(clientConnectTimer);
      clientConnectTimer = null;
    }

    if (msg.type === 'pong' && msg.ts) {
      currentPingMs = Math.max(1, Date.now() - msg.ts);
      elStatPing.textContent = `${currentPingMs} ms`;
      return;
    }

    if (msg.type === 'video-frame' && msg.dataUrl) {
      sendClientSignaling({ type: 'frame-ack', frameId: msg.frameId });
      if (!clientHasWebRtcVideo) {
        elViewerLoading.classList.add('hidden');
        elRemoteVideo.classList.add('hidden');
        elRemoteCanvas.classList.remove('hidden');

        const img = new Image();
        img.onload = () => {
          if (elRemoteCanvas.width !== img.width || elRemoteCanvas.height !== img.height) {
            elRemoteCanvas.width = img.width;
            elRemoteCanvas.height = img.height;
            elStatRes.textContent = `${img.width}x${img.height}`;
          }
          const ctx = elRemoteCanvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
          }
        };
        img.src = msg.dataUrl;
        relayFramesCount++;
      }
      return;
    }

    if (msg.type === 'auth-failed') {
      elBtnConnectNow.disabled = false;
      elConnectStatusMsg.textContent = msg.message || 'Xác thực thất bại';
      showToast(msg.message || 'Sai mật khẩu máy đích', 'error');

      if (msg.reason === 'TOKEN_EXPIRED_OR_INVALID') {
        elRemoteIpInput.value =
          clientTransport === 'cloud'
            ? clientTargetDeviceId
            : `${activeRemoteIp}:${activeRemotePort}`;
        elRemotePassInput.focus();
      }
      disconnectClientViewer(true);
      return;
    }

    if (msg.type === 'auth-success') {
      elBtnConnectNow.disabled = false;
      elConnectStatusMsg.textContent = '';

      const hostInfo = msg.hostInfo || {};

      // CRITICAL: Initialize WebRTC synchronously BEFORE any async await so we NEVER miss webrtc-offer!
      openViewerOverlay(hostInfo, msg.displays || [], clientQuality);
      setupClientWebRTC();
      // Before client-webrtc-ready, so the host applies it from the very first frame
      sendResolutionToHost();
      sendClientSignaling({ type: 'client-webrtc-ready' });

      // Save device asynchronously in background
      const isCloud = clientTransport === 'cloud';
      const savedId = isCloud
        ? hostInfo.deviceId || clientTargetDeviceId
        : hostInfo.deviceId || `${activeRemoteIp}:${activeRemotePort}`;

      swiftdesk
        .upsertSavedDevice({
          id: savedId,
          deviceId: hostInfo.deviceId || (isCloud ? clientTargetDeviceId : undefined),
          name: hostInfo.deviceName || activeRemoteIp,
          ip: isCloud ? hostInfo.deviceId || clientTargetDeviceId : activeRemoteIp,
          port: isCloud ? hostInfo.port || 9876 : activeRemotePort,
          connectionMode: isCloud ? 'cloud-id' : 'direct-ip',
          platform: hostInfo.platform || 'unknown',
          trustToken: msg.trustToken || '',
          savedPassword: clientUsedPassword || undefined,
          online: true,
        })
        .then((updatedSaved: SavedDevice[]) => {
          currentConfig.savedDevices = updatedSaved;
          renderSavedDevices(updatedSaved);
        });
      return;
    }

    if (msg.type === 'webrtc-offer') {
      if (!isValidSdp(msg.sdp)) {
        console.error('[ClientViewer] Received empty/invalid offer SDP:', msg.sdp);
        return;
      }
      if (!clientPc) {
        setupClientWebRTC();
      }
      const pc = clientPc!;
      if (msg.displayId) {
        activeRemoteDisplayId = String(msg.displayId);
      }
      try {
        await pc.setRemoteDescription(msg.sdp);
        clientRemoteDescSet = true;

        // Flush any ICE candidates that arrived before setRemoteDescription
        for (const cand of clientPendingIce) {
          try {
            await pc.addIceCandidate(cand);
          } catch {}
        }
        clientPendingIce = [];

        await pc.setLocalDescription(await pc.createAnswer());
        sendClientSignaling({
          type: 'webrtc-answer',
          sdp: toPlainSdp(pc.localDescription),
        });
      } catch (err) {
        console.error('[ClientViewer] WebRTC offer/answer failed:', err);
        requestFrameRelayNow();
      }
    } else if (msg.type === 'webrtc-ice' && msg.candidate) {
      if (!clientPc || !clientRemoteDescSet) {
        clientPendingIce.push(msg.candidate);
      } else {
        try {
          await clientPc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch {}
      }
    } else if (msg.type === 'session-closed') {
      showToast(msg.reason || 'Máy chủ đã đóng kết nối', 'info');
      disconnectClientViewer(false);
    }
  }

  function bindClientDataChannel(ch: RTCDataChannel): void {
    if (ch.label === 'input-fast') {
      clientFastChannel = ch;
    } else if (ch.label === 'input-reliable') {
      clientReliableChannel = ch;
    }
    ch.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'dc-pong' && data.ts) {
          currentPingMs = Math.max(1, Date.now() - data.ts);
          elStatPing.textContent = `${currentPingMs} ms`;
        } else if (data.type === 'host-stats') {
          const srcChanged =
            data.srcWidth !== lastHostStats?.srcWidth || data.srcHeight !== lastHostStats?.srcHeight;
          lastHostStats = data;
          if (srcChanged) renderResolutionSelect(); // "Gốc" label shows the real capture size
        }
      } catch {}
    };
  }

  function setupClientWebRTC(): void {
    if (clientPc) {
      try {
        clientPc.close();
      } catch {}
    }
    clientHasWebRtcVideo = false;
    clientRemoteDescSet = false;
    clientPendingIce = [];
    lastHostStats = null;
    elRemoteVideo.classList.remove('hidden');
    elRemoteCanvas.classList.add('hidden');

    const pc = new RTCPeerConnection(RTC_CONFIG);
    clientPc = pc;
    if (clientNatOwner) swiftdesk.releaseUdpMappings(clientNatOwner);
    const natOwner = `client:${generateUuid()}`;
    clientNatOwner = natOwner;

    // Receive DataChannels created by Host
    pc.ondatachannel = (ev) => {
      bindClientDataChannel(ev.channel);
    };

    const sendIce = (candidate: RTCIceCandidateInit) => {
      if (pc === clientPc) sendClientSignaling({ type: 'webrtc-ice', candidate });
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        sendIce(ev.candidate.toJSON());
        advertiseUpnpCandidate(natOwner, ev.candidate, sendIce);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc !== clientPc) return;
      console.log(`[ClientViewer] WebRTC connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        // P2P impossible (e.g. symmetric NAT without TURN) or dropped: switch to frame relay now
        clientHasWebRtcVideo = false;
        requestFrameRelayNow();
      }
    };

    pc.ontrack = (ev) => {
      const receiver = ev.receiver as any;
      if (receiver) {
        if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
        if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
      }

      if (ev.streams && ev.streams[0]) {
        elRemoteVideo.srcObject = ev.streams[0];
        elRemoteVideo.play().catch(() => {});
        elRemoteVideo.onloadedmetadata = () => {
          clientHasWebRtcVideo = true;
          if (clientWebRtcFallbackTimer) {
            clearTimeout(clientWebRtcFallbackTimer);
            clientWebRtcFallbackTimer = null;
          }
          elRemoteCanvas.classList.add('hidden');
          elRemoteVideo.classList.remove('hidden');
          elViewerLoading.classList.add('hidden');
          elViewerStage.focus();
          if (elRemoteVideo.videoWidth && elRemoteVideo.videoHeight) {
            elStatRes.textContent = `${elRemoteVideo.videoWidth}x${elRemoteVideo.videoHeight}`;
          }
        };
      }
    };

    // Only fall back to frame relay if WebRTC genuinely fails after 8 seconds
    if (clientWebRtcFallbackTimer) clearTimeout(clientWebRtcFallbackTimer);
    clientWebRtcFallbackTimer = window.setTimeout(() => {
      clientWebRtcFallbackTimer = null;
      if (!clientHasWebRtcVideo) {
        requestFrameRelayNow();
      }
    }, 8000);
  }

  function requestFrameRelayNow(): void {
    if (clientWebRtcFallbackTimer) {
      clearTimeout(clientWebRtcFallbackTimer);
      clientWebRtcFallbackTimer = null;
    }
    if (!elViewerOverlay.classList.contains('hidden')) {
      sendClientSignaling({ type: 'request-frame-relay' });
    }
  }

  function openViewerOverlay(
    hostInfo: any,
    displays: DisplaySourceInfo[],
    quality: 'ultra' | 'balanced' | 'low'
  ): void {
    elViewerHostName.textContent = hostInfo.deviceName || activeRemoteTargetLabel;
    elViewerHostIp.textContent = activeRemoteTargetLabel;
    // The name is truncated on narrow windows: keep the full name + ID one hover away
    elViewerHostName.parentElement!.title = `${hostInfo.deviceName || ''} — ${activeRemoteTargetLabel}`;
    activeRemotePlatform = String(hostInfo.platform || '');
    renderCtrlCmdToggle();
    elViewerQualitySelect.value = quality;
    elViewerLoadingText.textContent = 'Đang thiết lập đường truyền P2P 60FPS độ phân giải gốc...';
    elViewerLoading.classList.remove('hidden');
    elViewerOverlay.classList.remove('hidden');
    elStatFps.textContent = '-- FPS';
    elStatPing.textContent = '-- ms';
    elStatRes.textContent = '--';
    setStatPath('--', '');
    elViewerStats.classList.remove('limited');
    lastDiagnostics = '';
    closeToolbarPopups();

    activeRemoteDisplays = displays || [];
    elViewerDisplaySelect.innerHTML = '';
    activeRemoteDisplays.forEach((d, idx) => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ sourceId: d.id, displayId: d.displayId });
      // Size first: it stays readable when the select is truncated on narrow windows
      opt.textContent =
        activeRemoteDisplays.length > 1
          ? `${d.width}×${d.height} · Màn hình ${idx + 1}${d.isPrimary ? ' (chính)' : ''}`
          : `${d.width}×${d.height}`;
      opt.title = d.name;
      if (d.isPrimary || idx === 0) {
        opt.selected = true;
        activeRemoteDisplayId = d.displayId;
      }
      elViewerDisplaySelect.appendChild(opt);
    });
    renderResolutionSelect();

    if (clientPingTimer) clearInterval(clientPingTimer);
    clientPingTimer = window.setInterval(() => {
      // Measure real P2P latency over WebRTC DataChannel when open!
      if (clientReliableChannel && clientReliableChannel.readyState === 'open') {
        clientReliableChannel.send(JSON.stringify({ type: 'dc-ping', ts: Date.now() }));
      } else {
        sendClientSignaling({ type: 'ping', ts: Date.now() });
      }
    }, 1500);

    if (clientStatsTimer) clearInterval(clientStatsTimer);
    lastFramesDecoded = 0;
    relayFramesCount = 0;
    lastStatsTime = performance.now();

    clientStatsTimer = window.setInterval(async () => {
      const reports = new Map<string, any>();
      if (clientPc) {
        try {
          (await clientPc.getStats()).forEach((r: any) => reports.set(r.id, r));
        } catch {}
      }
      const iceSummary =
        `ice=${clientPc?.iceConnectionState || 'none'} ` +
        `local[${summarizeCandidates(reports, 'local-candidate')}] ` +
        `remote[${summarizeCandidates(reports, 'remote-candidate')}]`;

      if (!clientHasWebRtcVideo) {
        if (relayFramesCount > 0) {
          elStatFps.textContent = `${relayFramesCount} FPS`;
          setStatPath('Relay', 'relay');
        }
        lastDiagnostics = `path=Relay (P2P failed) fps=${relayFramesCount} ping=${currentPingMs}ms | ${iceSummary}`;
        relayFramesCount = 0;
        elViewerStats.title = `${lastDiagnostics}\n(Nhấn để sao chép thông tin chẩn đoán)`;
        return;
      }

      let pair: any = null;
      let inbound: any = null;
      for (const r of reports.values()) {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = reports.get(r.selectedCandidatePairId);
        if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
      }
      if (!pair) {
        pair = [...reports.values()].find((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
      }
      if (!inbound) return;
      const pathLabel = describeIcePath(
        pair ? reports.get(pair.localCandidateId) : null,
        pair ? reports.get(pair.remoteCandidateId) : null
      );

      const now = performance.now();
      const elapsedSec = Math.max(0.1, (now - lastStatsTime) / 1000);
      const frames = inbound.framesDecoded || 0;
      const fps = Math.round((frames - lastFramesDecoded) / elapsedSec);
      lastFramesDecoded = frames;
      lastStatsTime = now;

      // ⚠ = the host's encoder is throttled by its CPU or by bandwidth, not by the network path
      elViewerStats.classList.toggle('limited', !!lastHostStats && lastHostStats.limit !== 'none');
      setStatPath(pathLabel, pathLabel === 'TURN' ? 'turn' : 'p2p');
      if (fps > 0 && fps <= 144) {
        elStatFps.textContent = `${fps} FPS`;
      }
      if (elRemoteVideo.videoWidth && elRemoteVideo.videoHeight) {
        elStatRes.textContent = `${elRemoteVideo.videoWidth}×${elRemoteVideo.videoHeight}`;
      }

      const codec = inbound.codecId ? reports.get(inbound.codecId)?.mimeType || '' : '';
      const h = lastHostStats;
      lastDiagnostics =
        `path=${pathLabel} fps=${fps} ping=${currentPingMs}ms ` +
        `rtt=${Math.round((pair?.currentRoundTripTime || 0) * 1000)}ms ` +
        `recv=${inbound.frameWidth || 0}x${inbound.frameHeight || 0} codec=${codec} ` +
        `decoder=${inbound.decoderImplementation || '?'} lost=${inbound.packetsLost || 0} | ` +
        (h
          ? `host: ${h.fps}fps ${h.width}x${h.height} (src ${h.srcWidth || '?'}x${h.srcHeight || '?'}) ` +
            `${h.codec} encoder=${h.encoder} limit=${h.limit} | `
          : 'host: ? | ') +
        iceSummary;
      elViewerStats.title = `${lastDiagnostics}\n(Nhấn để sao chép thông tin chẩn đoán)`;
    }, 1000);
  }

  function disconnectClientViewer(notifyRemote = true): void {
    // Must run while the channels are still open
    releaseHeldRemoteInputs();
    if (clientConnectTimer) {
      clearTimeout(clientConnectTimer);
      clientConnectTimer = null;
    }
    if (clientWebRtcFallbackTimer) {
      clearTimeout(clientWebRtcFallbackTimer);
      clientWebRtcFallbackTimer = null;
    }
    if (clientPingTimer) {
      clearInterval(clientPingTimer);
      clientPingTimer = null;
    }
    if (clientStatsTimer) {
      clearInterval(clientStatsTimer);
      clientStatsTimer = null;
    }
    if (mouseSettleTimer) {
      clearTimeout(mouseSettleTimer);
      mouseSettleTimer = null;
    }
    pendingMouseMove = null;
    if (clientFastChannel) {
      try {
        clientFastChannel.close();
      } catch {}
      clientFastChannel = null;
    }
    if (clientReliableChannel) {
      try {
        clientReliableChannel.close();
      } catch {}
      clientReliableChannel = null;
    }
    if (clientPc) {
      try {
        clientPc.close();
      } catch {}
      clientPc = null;
    }
    if (clientNatOwner) {
      swiftdesk.releaseUdpMappings(clientNatOwner);
      clientNatOwner = '';
    }
    if (clientWs) {
      try {
        clientWs.close();
      } catch {}
      clientWs = null;
    }
    if (clientTransport === 'cloud' && clientTargetDeviceId) {
      swiftdesk.stopClientCloudSession(
        notifyRemote ? clientTargetDeviceId : undefined,
        notifyRemote ? clientSessionId : undefined
      );
    }
    elRemoteVideo.srcObject = null;
    elViewerOverlay.classList.add('hidden');
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  function sendClientSignaling(payload: Record<string, unknown>): void {
    if (clientTransport === 'ws') {
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    } else if (clientTransport === 'cloud' && clientTargetDeviceId) {
      swiftdesk.sendClientCloudMessage(clientTargetDeviceId, {
        sessionId: clientSessionId,
        ...payload,
      });
    }
  }

  let pointerSeq = 0;

  function sendRemoteInput(event: Record<string, unknown>, isFastMove = false): void {
    event.displayId = activeRemoteDisplayId;
    if (event.type === 'mousemove' || event.type === 'mousedown' || event.type === 'mouseup') {
      // Monotonic sequence lets the host drop moves reordered by the unordered 'input-fast' channel
      event.seq = ++pointerSeq;
    }
    const packet = JSON.stringify({ type: 'input', event });

    if (isFastMove && clientFastChannel && clientFastChannel.readyState === 'open') {
      clientFastChannel.send(packet);
      return;
    }
    if (clientReliableChannel && clientReliableChannel.readyState === 'open') {
      clientReliableChannel.send(packet);
      return;
    }
    sendClientSignaling({ type: 'input', event });
  }

  // ============================================================================
  // PART 3: HIGH-PRECISION MOUSE & KEYBOARD CAPTURE ON VIEWER STAGE
  // ============================================================================

  function getNormalizedVideoCoords(clientX: number, clientY: number): { x: number; y: number } | null {
    const activeEl = !elRemoteCanvas.classList.contains('hidden') ? elRemoteCanvas : elRemoteVideo;
    const rect = activeEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const vw =
      activeEl === elRemoteCanvas
        ? elRemoteCanvas.width || rect.width
        : elRemoteVideo.videoWidth || rect.width;
    const vh =
      activeEl === elRemoteCanvas
        ? elRemoteCanvas.height || rect.height
        : elRemoteVideo.videoHeight || rect.height;

    if (isOriginalScale) {
      const x = (clientX - rect.left) / rect.width;
      const y = (clientY - rect.top) / rect.height;
      return {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
      };
    }

    const videoRatio = vw / vh;
    const boxRatio = rect.width / rect.height;

    let renderW = rect.width;
    let renderH = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (boxRatio > videoRatio) {
      renderW = rect.height * videoRatio;
      offsetX = (rect.width - renderW) / 2;
    } else {
      renderH = rect.width / videoRatio;
      offsetY = (rect.height - renderH) / 2;
    }

    const relX = (clientX - (rect.left + offsetX)) / renderW;
    const relY = (clientY - (rect.top + offsetY)) / renderH;

    return {
      x: Math.max(0, Math.min(1, relX)),
      y: Math.max(0, Math.min(1, relY)),
    };
  }

  // Cloud relay (no DataChannel) is slow, so mouse moves are capped at ~30/s there
  const RELAY_MOUSE_INTERVAL_MS = 33;
  // 'input-fast' may drop the last move, so the resting position is re-sent reliably once the mouse stops
  const MOUSE_SETTLE_DELAY_MS = 80;

  let pendingMouseMove: { x: number; y: number } | null = null;
  let mouseFlushScheduled = false;
  let lastMouseMoveSentAt = 0;
  let lastMouseCoords = { x: 0.5, y: 0.5 };
  let mouseSettleTimer: number | null = null;
  const stageButtonsDown = new Set<number>();

  function isInputChannelOpen(): boolean {
    return (
      clientFastChannel?.readyState === 'open' || clientReliableChannel?.readyState === 'open'
    );
  }

  function flushMouseMove(): void {
    mouseFlushScheduled = false;
    if (!pendingMouseMove) return;

    if (!isInputChannelOpen() && clientTransport === 'cloud') {
      const waitMs = RELAY_MOUSE_INTERVAL_MS - (performance.now() - lastMouseMoveSentAt);
      if (waitMs > 0) {
        // Throttled: schedule a trailing send instead of dropping the move, otherwise the
        // remote cursor stays behind wherever the last unthrottled move left it
        mouseFlushScheduled = true;
        window.setTimeout(flushMouseMove, waitMs);
        return;
      }
    }

    const coords = pendingMouseMove;
    pendingMouseMove = null;
    lastMouseMoveSentAt = performance.now();
    sendRemoteInput({ type: 'mousemove', x: coords.x, y: coords.y }, true);

    if (mouseSettleTimer) clearTimeout(mouseSettleTimer);
    mouseSettleTimer = window.setTimeout(() => {
      mouseSettleTimer = null;
      if (clientFastChannel?.readyState === 'open') {
        sendRemoteInput({ type: 'mousemove', x: coords.x, y: coords.y });
      }
    }, MOUSE_SETTLE_DELAY_MS);
  }

  window.addEventListener('mousemove', (e) => {
    if (elViewerOverlay.classList.contains('hidden')) return;
    // Outside the stage, keep tracking only while dragging with a button pressed on the stage
    if (!elViewerStage.contains(e.target as Node) && stageButtonsDown.size === 0) return;
    const coords = getNormalizedVideoCoords(e.clientX, e.clientY);
    if (!coords) return;
    lastMouseCoords = coords;
    pendingMouseMove = coords;
    if (!mouseFlushScheduled) {
      mouseFlushScheduled = true;
      requestAnimationFrame(flushMouseMove);
    }
  });

  function mapMouseButton(btn: number): 'left' | 'middle' | 'right' {
    if (btn === 1) return 'middle';
    if (btn === 2) return 'right';
    return 'left';
  }

  elViewerStage.addEventListener('mousedown', (e) => {
    e.preventDefault();
    elViewerStage.focus();
    const coords = getNormalizedVideoCoords(e.clientX, e.clientY);
    if (!coords) return;
    stageButtonsDown.add(e.button);
    lastMouseCoords = coords;
    sendRemoteInput({
      type: 'mousedown',
      button: mapMouseButton(e.button),
      x: coords.x,
      y: coords.y,
      ...remoteModifiers(e),
    });
  });

  // Listen on window so releasing the button outside the stage never leaves it stuck down remotely
  window.addEventListener('mouseup', (e) => {
    if (!stageButtonsDown.delete(e.button)) return;
    e.preventDefault();
    const coords = getNormalizedVideoCoords(e.clientX, e.clientY) || lastMouseCoords;
    sendRemoteInput({
      type: 'mouseup',
      button: mapMouseButton(e.button),
      x: coords.x,
      y: coords.y,
      ...remoteModifiers(e),
    });
  });

  elViewerStage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  elViewerStage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      sendRemoteInput({
        type: 'wheel',
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      });
    },
    { passive: false }
  );

  // Keys held on the viewer; their keyup is never delivered if the OS steals focus mid-press
  // (Win key opens Start, Alt+Tab, Ctrl+Alt+Del...), so they're released explicitly on blur
  const pressedKeys = new Map<string, { key: string; keyCode: number }>();
  // Set when a keydown carried no usable key: its character is delivered by the following keypress
  let awaitingKeypressText = false;

  // Windows virtual-key code -> DOM code (letters, digits, numpad and F-keys are computed)
  const KEYCODE_TO_DOM_CODE: Record<number, string> = {
    8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'ShiftLeft', 17: 'ControlLeft', 18: 'AltLeft',
    19: 'Pause', 20: 'CapsLock', 27: 'Escape', 32: 'Space', 33: 'PageUp', 34: 'PageDown',
    35: 'End', 36: 'Home', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
    44: 'PrintScreen', 45: 'Insert', 46: 'Delete', 91: 'MetaLeft', 92: 'MetaRight', 93: 'ContextMenu',
    106: 'NumpadMultiply', 107: 'NumpadAdd', 109: 'NumpadSubtract', 110: 'NumpadDecimal',
    111: 'NumpadDivide', 144: 'NumLock', 145: 'ScrollLock', 186: 'Semicolon', 187: 'Equal',
    188: 'Comma', 189: 'Minus', 190: 'Period', 191: 'Slash', 192: 'Backquote', 219: 'BracketLeft',
    220: 'Backslash', 221: 'BracketRight', 222: 'Quote',
  };

  /**
   * Vietnamese IME tools (EVKey, Unikey) swallow letter keys and re-inject them without a hardware
   * scan code, so Chromium reports an empty `code` — the Mac host then had no key to press (only
   * digits, which Telex leaves alone, got through). Recover the key from the virtual-key code.
   */
  function resolveDomCode(e: KeyboardEvent): string {
    if (e.code && e.code !== 'Unidentified') return e.code;
    const kc = e.keyCode;
    if (kc >= 65 && kc <= 90) return `Key${String.fromCharCode(kc)}`;
    if (kc >= 48 && kc <= 57) return `Digit${kc - 48}`;
    if (kc >= 96 && kc <= 105) return `Numpad${kc - 96}`;
    if (kc >= 112 && kc <= 123) return `F${kc - 111}`;
    return KEYCODE_TO_DOM_CODE[kc] || '';
  }

  function isSingleCharacter(key: string): boolean {
    return [...key].length === 1; // 'Unidentified', 'Process', 'Dead'... are names, not characters
  }

  const CTRL_CMD_SWAP: Record<string, { code: string; keyCode: number }> = {
    ControlLeft: { code: 'MetaLeft', keyCode: 91 },
    ControlRight: { code: 'MetaRight', keyCode: 92 },
    MetaLeft: { code: 'ControlLeft', keyCode: 17 },
    MetaRight: { code: 'ControlRight', keyCode: 17 },
  };

  function isCtrlCmdSwapActive(): boolean {
    return !!currentConfig?.mapCtrlToCmd && activeRemotePlatform === 'darwin' && currentPlatform !== 'darwin';
  }

  /** Modifier state as the remote should see it (Ctrl and Win/⌘ swapped when controlling a Mac). */
  function remoteModifiers(e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }) {
    const swap = isCtrlCmdSwapActive();
    return {
      ctrlKey: swap ? e.metaKey : e.ctrlKey,
      metaKey: swap ? e.ctrlKey : e.metaKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    };
  }

  function sendKeyEvent(type: 'keydown' | 'keyup', e: KeyboardEvent, code: string): void {
    let keyCode = e.keyCode;
    if (isCtrlCmdSwapActive() && CTRL_CMD_SWAP[code]) {
      ({ code, keyCode } = CTRL_CMD_SWAP[code]);
    }
    if (type === 'keydown') pressedKeys.set(code, { key: e.key, keyCode });
    else pressedKeys.delete(code);
    sendRemoteInput({ type, key: e.key, code, keyCode, ...remoteModifiers(e) });
  }

  elViewerStage.addEventListener('keydown', (e) => {
    if (elViewerOverlay.classList.contains('hidden')) return;
    e.stopPropagation();
    const code = resolveDomCode(e);
    if (!code) {
      // No key behind it at all: a character injected as a Unicode packet (EVKey's "â", "ệ"...)
      if (isSingleCharacter(e.key)) {
        e.preventDefault();
        sendRemoteInput({ type: 'text', text: e.key });
      } else {
        awaitingKeypressText = true; // let the browser deliver the character via keypress
      }
      return;
    }
    e.preventDefault();
    sendKeyEvent('keydown', e, code);
  });

  elViewerStage.addEventListener('keypress', (e) => {
    if (elViewerOverlay.classList.contains('hidden')) return;
    e.preventDefault();
    if (awaitingKeypressText && isSingleCharacter(e.key)) {
      sendRemoteInput({ type: 'text', text: e.key });
    }
    awaitingKeypressText = false;
  });

  elViewerStage.addEventListener('keyup', (e) => {
    if (elViewerOverlay.classList.contains('hidden')) return;
    e.preventDefault();
    e.stopPropagation();
    const code = resolveDomCode(e);
    if (code) sendKeyEvent('keyup', e, code);
  });

  /** Keys menu content depends on the remote OS (⌘Tab / Spotlight on a Mac, Ctrl→⌘ only for Mac hosts). */
  function renderCtrlCmdToggle(): void {
    const remoteMac = activeRemotePlatform === 'darwin';
    const relevant = remoteMac && currentPlatform !== 'darwin';
    const on = !!currentConfig?.mapCtrlToCmd;
    elBtnViewerCtrlCmd.classList.toggle('hidden', !relevant);
    elBtnViewerCtrlCmd.classList.toggle('on', on);
    elBtnViewerCtrlCmd.setAttribute('aria-checked', String(on));
    elKbdAltTab.textContent = remoteMac ? '⌘ + Tab' : 'Alt + Tab';
    elKbdWinKey.textContent = remoteMac ? '⌘' : 'Win';
  }

  elBtnViewerCtrlCmd.addEventListener('click', async () => {
    releaseHeldRemoteInputs(); // never leave a key pressed under one mapping and released under the other
    const res = await swiftdesk.updateSettings({ mapCtrlToCmd: !currentConfig.mapCtrlToCmd });
    if (res.config) currentConfig = res.config;
    renderCtrlCmdToggle();
    showToast(
      currentConfig.mapCtrlToCmd
        ? 'Ctrl trên máy này = ⌘ Command trên Mac (Ctrl+C/V/Z → ⌘C/⌘V/⌘Z)'
        : 'Đã tắt chuyển Ctrl → ⌘ (giữ nguyên phím)',
      'info'
    );
  });

  // --- Toolbar popups (keys menu, custom resolution) ---
  function closeToolbarPopups(): void {
    elViewerKeysMenu.classList.add('hidden');
    elResPopover.classList.add('hidden');
  }

  elBtnViewerKeys.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = elViewerKeysMenu.classList.contains('hidden');
    closeToolbarPopups();
    elViewerKeysMenu.classList.toggle('hidden', !willOpen);
  });

  document.addEventListener('mousedown', (e) => {
    const target = e.target as Node;
    if (elViewerKeysMenu.contains(target) || elBtnViewerKeys.contains(target)) return;
    if (elResPopover.contains(target) || elViewerResSelect.contains(target)) return;
    if (!elResPopover.classList.contains('hidden')) renderResolutionSelect(); // dismissing = cancel
    closeToolbarPopups();
  });

  function setStatPath(label: string, kind: '' | 'p2p' | 'relay' | 'turn'): void {
    elStatPath.textContent = label;
    elStatPath.className = `stat-path ${kind}`.trim();
  }

  // --- Stream resolution ---
  const RESOLUTION_PRESETS = ['2560x1440', '1920x1080', '1600x900', '1280x720'];

  function parseResolution(value: string): MaxResolution | null {
    const m = /^(\d{3,5})x(\d{3,5})$/.exec(value);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  function activeDisplayInfo(): DisplaySourceInfo | undefined {
    return activeRemoteDisplays.find((d) => d.displayId === activeRemoteDisplayId) || activeRemoteDisplays[0];
  }

  /** Concrete max size for the host; null = native capture size. */
  function resolveMaxResolution(): MaxResolution | null {
    const choice = currentConfig?.viewerResolution || 'display';
    if (choice === 'native') return null;
    if (choice === 'display') {
      // The display's logical size (e.g. 2560x1440 on a 4K HiDPI panel), not its physical pixels
      const d = activeDisplayInfo();
      return d ? { width: d.width, height: d.height } : null;
    }
    return parseResolution(choice);
  }

  function sendResolutionToHost(): void {
    const res = resolveMaxResolution();
    sendClientSignaling({ type: 'change-resolution', maxWidth: res?.width || 0, maxHeight: res?.height || 0 });
  }

  function renderResolutionSelect(): void {
    const choice = currentConfig?.viewerResolution || 'display';
    const d = activeDisplayInfo();
    const src = lastHostStats?.srcWidth ? `${lastHostStats.srcWidth}×${lastHostStats.srcHeight}` : '';
    const opt = (value: string) => elViewerResSelect.querySelector<HTMLOptionElement>(`option[value="${value}"]`);
    opt('display')!.textContent = d ? `${d.width}×${d.height} · Theo màn hình` : 'Theo màn hình';
    opt('native')!.textContent = src ? `${src} · Gốc` : 'Gốc (tối đa)';

    // A custom size gets its own option so the select can show it
    elViewerResSelect.querySelector('option[data-custom-value]')?.remove();
    if (parseResolution(choice) && !RESOLUTION_PRESETS.includes(choice)) {
      const custom = document.createElement('option');
      custom.value = choice;
      custom.dataset.customValue = '1';
      custom.textContent = `${choice.replace('x', '×')} · Tuỳ chỉnh`;
      elViewerResSelect.insertBefore(custom, opt('custom'));
    }
    elViewerResSelect.value = choice;
  }

  async function applyResolutionChoice(choice: string): Promise<void> {
    const res = await swiftdesk.updateSettings({ viewerResolution: choice });
    if (res.config) currentConfig = res.config;
    renderResolutionSelect();
    sendResolutionToHost();
    const r = resolveMaxResolution();
    showToast(r ? `Độ phân giải truyền tối đa: ${r.width} × ${r.height}` : 'Độ phân giải truyền: gốc', 'info');
    elViewerStage.focus();
  }

  elViewerResSelect.addEventListener('change', () => {
    if (elViewerResSelect.value !== 'custom') {
      applyResolutionChoice(elViewerResSelect.value);
      return;
    }
    const current = resolveMaxResolution() || { width: 1920, height: 1080 };
    elResCustomW.value = String(current.width);
    elResCustomH.value = String(current.height);
    closeToolbarPopups();
    elResPopover.classList.remove('hidden');
    elResCustomW.focus();
    elResCustomW.select();
  });

  function submitCustomResolution(): void {
    const w = Math.round(Number(elResCustomW.value));
    const h = Math.round(Number(elResCustomH.value));
    if (!(w >= 320 && w <= 7680 && h >= 240 && h <= 4320)) {
      showToast('Kích thước hợp lệ: rộng 320–7680, cao 240–4320', 'error');
      return;
    }
    elResPopover.classList.add('hidden');
    applyResolutionChoice(`${w}x${h}`);
  }

  elBtnResCustomApply.addEventListener('click', submitCustomResolution);
  elBtnResCustomCancel.addEventListener('click', () => {
    elResPopover.classList.add('hidden');
    renderResolutionSelect();
    elViewerStage.focus();
  });
  for (const input of [elResCustomW, elResCustomH]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitCustomResolution();
      if (e.key === 'Escape') elBtnResCustomCancel.click();
    });
  }

  /** Release every key / mouse button still held remotely (focus lost, window hidden, disconnect). */
  function releaseHeldRemoteInputs(): void {
    for (const [code, k] of pressedKeys) {
      sendRemoteInput({
        type: 'keyup',
        key: k.key,
        code,
        keyCode: k.keyCode,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      });
    }
    pressedKeys.clear();
    for (const btn of stageButtonsDown) {
      sendRemoteInput({
        type: 'mouseup',
        button: mapMouseButton(btn),
        x: lastMouseCoords.x,
        y: lastMouseCoords.y,
      });
    }
    stageButtonsDown.clear();
  }

  window.addEventListener('blur', releaseHeldRemoteInputs);
  elViewerStage.addEventListener('blur', releaseHeldRemoteInputs);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseHeldRemoteInputs();
  });

  // --- Viewer Toolbar Controls ---
  elViewerDisplaySelect.addEventListener('change', () => {
    try {
      const parsed = JSON.parse(elViewerDisplaySelect.value);
      activeRemoteDisplayId = parsed.displayId;
      sendClientSignaling({
        type: 'switch-display',
        sourceId: parsed.sourceId,
        displayId: parsed.displayId,
      });
      // "Theo màn hình" follows the newly selected display's size
      renderResolutionSelect();
      sendResolutionToHost();
    } catch {}
  });

  elViewerQualitySelect.addEventListener('change', () => {
    clientQuality = elViewerQualitySelect.value as 'ultra' | 'balanced' | 'low';
    sendClientSignaling({
      type: 'change-quality',
      quality: clientQuality,
    });
    showToast(`Đã chuyển chế độ truyền hình ảnh sang ${clientQuality.toUpperCase()}`, 'info');
  });

  elBtnViewerScale.addEventListener('click', () => {
    isOriginalScale = !isOriginalScale;
    elRemoteVideo.classList.toggle('scale-original', isOriginalScale);
    elRemoteCanvas.classList.toggle('scale-original', isOriginalScale);
    elBtnViewerScale.classList.toggle('active', isOriginalScale);
    elBtnViewerScale.title = isOriginalScale
      ? 'Đang: tỉ lệ 1:1. Nhấn để vừa khung hình'
      : 'Đang: vừa khung hình. Nhấn để xem tỉ lệ 1:1';
  });

  elBtnViewerClipboard.addEventListener('click', async () => {
    const text = await swiftdesk.readClipboard();
    if (text) {
      sendRemoteInput({
        type: 'clipboard-set',
        text,
      });
      showToast('Đã đồng bộ Clipboard sang máy đích', 'success');
    } else {
      showToast('Clipboard hiện tại đang trống', 'info');
    }
  });

  elViewerStats.addEventListener('click', async () => {
    if (!lastDiagnostics) return;
    await swiftdesk.writeClipboard(lastDiagnostics);
    showToast('Đã sao chép thông tin chẩn đoán kết nối', 'success');
  });

  elBtnViewerAltTab.addEventListener('click', () => {
    sendRemoteInput({ type: 'special-combo', combo: 'alt-tab' });
    closeToolbarPopups();
    elViewerStage.focus();
  });

  elBtnViewerWinKey.addEventListener('click', () => {
    sendRemoteInput({ type: 'special-combo', combo: 'win-key' });
    closeToolbarPopups();
    elViewerStage.focus();
  });

  elBtnViewerFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      elViewerOverlay.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  elBtnViewerDisconnect.addEventListener('click', () => {
    disconnectClientViewer(true);
  });

  // ============================================================================
  // PART 4: UI EVENT LISTENERS & INITIALIZATION
  // ============================================================================

  elBtnCopyCloudId.addEventListener('click', async () => {
    if (!currentConfig?.deviceId) return;
    await swiftdesk.writeClipboard(currentConfig.deviceId);
    showToast(`Đã sao chép Mã ID: ${currentConfig.deviceId}`, 'success');
  });

  elBtnTogglePass.addEventListener('click', () => {
    const isPass = elHostPassInput.type === 'password';
    elHostPassInput.type = isPass ? 'text' : 'password';
    elBtnTogglePass.textContent = isPass ? 'Ẩn' : 'Hiện';
  });

  elBtnRandomPass.addEventListener('click', async () => {
    const res = await swiftdesk.generatePassword();
    if (res.success) {
      currentConfig = res.config;
      elHostPassInput.value = res.password;
      elHostPassInput.type = 'text';
      elBtnTogglePass.textContent = 'Ẩn';
      showToast('Đã tạo và lưu mật khẩu ngẫu nhiên mới', 'success');
    }
  });

  elBtnSavePass.addEventListener('click', async () => {
    const val = elHostPassInput.value.trim();
    if (val.length < 4) {
      showToast('Mật khẩu cần ít nhất 4 ký tự', 'error');
      return;
    }
    const res = await swiftdesk.setPassword(val);
    if (res.success) {
      currentConfig = res.config;
      showToast('Đã cập nhật mật khẩu máy chủ thành công', 'success');
    }
  });

  elChkAutostart.addEventListener('change', async () => {
    const res = await swiftdesk.updateSettings({ autoStart: elChkAutostart.checked });
    if (res.config) {
      currentConfig = res.config;
      renderConfigUI();
      showToast(
        elChkAutostart.checked
          ? 'Đã bật tự động khởi động cùng Windows / macOS'
          : 'Đã tắt tự động khởi động',
        'success'
      );
    }
  });

  elChkMinimizeTray.addEventListener('change', async () => {
    const res = await swiftdesk.updateSettings({ minimizeToTray: elChkMinimizeTray.checked });
    if (res.config) currentConfig = res.config;
  });

  elChkClipboardSync.addEventListener('change', async () => {
    const res = await swiftdesk.updateSettings({ allowClipboardSync: elChkClipboardSync.checked });
    if (res.config) currentConfig = res.config;
  });

  elBtnSaveHostCfg.addEventListener('click', async () => {
    const deviceName = elInputDeviceName.value.trim() || 'My Computer';
    const listenPort = parseInt(elInputListenPort.value, 10) || 9876;
    const res = await swiftdesk.updateSettings({ deviceName, listenPort });
    if (!res.success && res.error) {
      showToast(res.error, 'error');
      return;
    }
    currentConfig = res.config;
    renderConfigUI();
    showToast(`Đã áp dụng cấu hình (Port ${currentConfig.listenPort})`, 'success');
  });

  elBtnRefreshNet.addEventListener('click', async () => {
    localNetworks = await swiftdesk.getNetworks();
    renderNetworks();
    showToast('Đã làm mới danh sách địa chỉ IP mạng', 'info');
  });

  elConnectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const rawTarget = elRemoteIpInput.value.trim();
    if (!rawTarget) return;
    const password = elRemotePassInput.value.trim();

    if (isCloudDeviceId(rawTarget)) {
      connectViaCloudId({
        targetDeviceId: rawTarget,
        password,
      });
    } else {
      const { ip, port } = parseIpPort(rawTarget, 9876);
      connectViaDirectIp({ ip, port, password });
    }
  });

  async function refreshSavedDevicesOnlineStatus(): Promise<void> {
    if (!currentConfig?.savedDevices?.length) return;
    const probed = await swiftdesk.probeSavedDevices();
    currentConfig.savedDevices = probed;
    renderSavedDevices(probed);
  }

  elBtnPingSaved.addEventListener('click', async () => {
    await refreshSavedDevicesOnlineStatus();
    showToast('Đã kiểm tra trạng thái Online của các thiết bị đã lưu', 'info');
  });

  elBtnMacPermissions.addEventListener('click', async () => {
    const perms = await swiftdesk.checkMacPermissions(true);
    if (perms.accessibility && perms.screen) {
      elMacBanner.classList.add('hidden');
      showToast('Đã cấp đủ quyền trên macOS!', 'success');
    } else {
      showToast('Vui lòng bật quyền trong System Settings > Privacy & Security', 'info');
    }
  });

  // --- Register IPC Listeners from Main Process ---
  swiftdesk.onStartHostWebRTC((data: any) => {
    startHostWebRTCSession(data);
  });

  swiftdesk.onSignalFromClient((data: any) => {
    handleHostSignalFromClient(data);
  });

  swiftdesk.onPeerDisconnected((data: { sessionId: string }) => {
    cleanupHostSession(data.sessionId);
  });

  swiftdesk.onSessionsUpdated((data: any) => {
    renderActiveIncomingSessions(data.sessions || []);
    if (data.trustedControllers && currentConfig) {
      currentConfig.trustedControllers = data.trustedControllers;
      renderTrustedControllers(data.trustedControllers);
    }
  });

  swiftdesk.onConfigUpdated((cfg: AppConfig) => {
    currentConfig = cfg;
    renderConfigUI();
  });

  swiftdesk.onClientCloudMessage((msg: any) => {
    handleClientSignalingMessage(msg);
  });

  swiftdesk.onCloudStatus((status: { online: boolean; deviceId: string }) => {
    elCloudStatusText.textContent = status.online
      ? `🌐 Cloud ID Online (${status.deviceId})`
      : 'Đang kết nối lại Cloud ID...';
  });

  // --- Bootstrap on Load ---
  async function init(): Promise<void> {
    const boot = await swiftdesk.getBootstrap();
    currentConfig = boot.config;
    currentPlatform = boot.platform;
    localNetworks = boot.networks || [];

    if (boot.cloudOnline) {
      elCloudStatusText.textContent = `🌐 Cloud ID Online (${currentConfig.deviceId})`;
    }

    if (
      boot.platform === 'darwin' &&
      (!boot.macPermissions?.accessibility || !boot.macPermissions?.screen)
    ) {
      elMacBanner.classList.remove('hidden');
    }

    renderConfigUI();
    renderActiveIncomingSessions(boot.activeSessions || []);

    setTimeout(refreshSavedDevicesOnlineStatus, 1200);
    setInterval(refreshSavedDevicesOnlineStatus, 15000);
  }

  init();
})();
