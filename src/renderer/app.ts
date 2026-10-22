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

  // Host WebRTC & Frame Relay Sessions (when other machines control this computer)
  interface HostPeerSession {
    sessionId: string;
    pc: RTCPeerConnection;
    stream: MediaStream | null;
    videoSender: RTCRtpSender | null;
    activeDisplayId: string;
    quality: 'ultra' | 'balanced' | 'low';
    frameRelayTimer: number | null;
    relayVideoEl: HTMLVideoElement | null;
    relayCanvas: HTMLCanvasElement | null;
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
  let clientUsedPassword = '';
  let clientQuality: 'ultra' | 'balanced' | 'low' = 'ultra';
  let clientConnectTimer: number | null = null;
  let clientWebRtcFallbackTimer: number | null = null;
  let clientHasWebRtcVideo = false;

  let activeRemoteDisplayId = '';
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

  // RTC Configuration with STUN + Public TURN Servers (UDP, TCP, TLS 443) for Cross-Network Internet P2P
  const RTC_CONFIG: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };

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
  const elStatFps = document.getElementById('stat-fps')!;
  const elStatPing = document.getElementById('stat-ping')!;
  const elStatRes = document.getElementById('stat-res')!;
  const elViewerDisplaySelect = document.getElementById('viewer-display-select') as HTMLSelectElement;
  const elViewerQualitySelect = document.getElementById('viewer-quality-select') as HTMLSelectElement;
  const elBtnViewerScale = document.getElementById('btn-viewer-scale')!;
  const elBtnViewerClipboard = document.getElementById('btn-viewer-clipboard')!;
  const elBtnViewerAltTab = document.getElementById('btn-viewer-alttab')!;
  const elBtnViewerWinKey = document.getElementById('btn-viewer-winkey')!;
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
      const isCloud = dev.connectionMode === 'cloud-id' || isCloudDeviceId(dev.ip) || isCloudDeviceId(dev.id);
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
  // PART 1: HOST WEBRTC & FRAME STREAM ENGINE (Streams This Machine's Screen)
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
    if (videoTrack && 'contentHint' in videoTrack) {
      videoTrack.contentHint = 'motion';
    }
    return stream;
  }

  async function tuneSenderEncoding(
    sender: RTCRtpSender,
    quality: 'ultra' | 'balanced' | 'low'
  ): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const bitrateMap = {
        ultra: 12_000_000,
        balanced: 5_500_000,
        low: 2_200_000,
      };
      params.encodings[0].maxBitrate = bitrateMap[quality] || 10_000_000;
      params.encodings[0].maxFramerate = quality === 'low' ? 30 : 60;
      (params as any).degradationPreference = 'maintain-framerate';
      await sender.setParameters(params);
    } catch (err) {
      console.warn('[HostWebRTC] Could not set sender encoding parameters:', err);
    }
  }

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

    const intervalMs = peer.quality === 'low' ? 95 : 55; // ~18 FPS smooth relay over Cloud Broker
    peer.frameRelayTimer = window.setInterval(() => {
      if (!video.videoWidth || !video.videoHeight || !ctx) return;
      const targetW = peer.quality === 'low' ? 1152 : 1440;
      const scale = Math.min(1, targetW / video.videoWidth);
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', peer.quality === 'low' ? 0.55 : 0.68);
      swiftdesk.sendSignalToClient(peer.sessionId, {
        type: 'video-frame',
        dataUrl,
        width: w,
        height: h,
      });
    }, intervalMs);
  }

  async function startHostWebRTCSession(data: {
    sessionId: string;
    sourceId: string;
    displayId: string;
    quality: 'ultra' | 'balanced' | 'low';
  }): Promise<void> {
    const { sessionId, sourceId, displayId, quality } = data;
    cleanupHostSession(sessionId);

    try {
      const stream = await captureDisplayStream(sourceId, quality);
      const pc = new RTCPeerConnection(RTC_CONFIG);

      pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'input' && msg.event) {
              msg.event.displayId = hostPeers.get(sessionId)?.activeDisplayId || displayId;
              swiftdesk.sendHostInputEvent(msg.event);
            }
          } catch {}
        };
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          swiftdesk.sendSignalToClient(sessionId, {
            type: 'webrtc-ice',
            candidate: event.candidate,
          });
        }
      };

      const videoTrack = stream.getVideoTracks()[0];
      const videoSender = pc.addTrack(videoTrack, stream);
      await tuneSenderEncoding(videoSender, quality);

      const peerSession: HostPeerSession = {
        sessionId,
        pc,
        stream,
        videoSender,
        activeDisplayId: displayId,
        quality,
        frameRelayTimer: null,
        relayVideoEl: null,
        relayCanvas: null,
      };
      hostPeers.set(sessionId, peerSession);

      // Stop frame relay automatically if WebRTC direct P2P/TURN connects!
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected' && peerSession.frameRelayTimer) {
          clearInterval(peerSession.frameRelayTimer);
          peerSession.frameRelayTimer = null;
        }
      };

      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);

      swiftdesk.sendSignalToClient(sessionId, {
        type: 'webrtc-offer',
        sdp: pc.localDescription,
        displayId,
      });
    } catch (err) {
      console.error('[HostWebRTC] Failed to start capture:', err);
    }
  }

  async function handleHostSignalFromClient(msg: any): Promise<void> {
    const peer = hostPeers.get(msg.sessionId);
    if (!peer) return;

    if (msg.type === 'webrtc-answer' && msg.sdp) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } else if (msg.type === 'webrtc-ice' && msg.candidate) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      } catch {}
    } else if (msg.type === 'request-frame-relay') {
      startHostFrameRelayFallback(peer);
    } else if (msg.type === 'switch-display' && msg.sourceId) {
      try {
        const newStream = await captureDisplayStream(msg.sourceId, peer.quality);
        const newTrack = newStream.getVideoTracks()[0];
        if (peer.videoSender && newTrack) {
          await peer.videoSender.replaceTrack(newTrack);
        }
        if (peer.relayVideoEl) {
          peer.relayVideoEl.srcObject = newStream;
        }
        if (peer.stream) {
          peer.stream.getTracks().forEach((t) => t.stop());
        }
        peer.stream = newStream;
        peer.activeDisplayId = String(msg.displayId || '');
      } catch (err) {
        console.error('[HostWebRTC] Error switching display:', err);
      }
    } else if (msg.type === 'change-quality' && msg.quality) {
      peer.quality = msg.quality;
      if (peer.videoSender) {
        await tuneSenderEncoding(peer.videoSender, msg.quality);
      }
    }
  }

  function cleanupHostSession(sessionId: string): void {
    const peer = hostPeers.get(sessionId);
    if (!peer) return;
    if (peer.frameRelayTimer) {
      clearInterval(peer.frameRelayTimer);
      peer.frameRelayTimer = null;
    }
    if (peer.relayVideoEl) {
      peer.relayVideoEl.srcObject = null;
      peer.relayVideoEl = null;
    }
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

  /**
   * Connects to a remote machine anywhere on the Internet using its 9-digit Cloud Device ID!
   */
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

    elConnectStatusMsg.textContent = `Đang tìm thiết bị Mã ID ${formattedId} qua Internet...`;
    elBtnConnectNow.disabled = true;

    swiftdesk.startClientCloudSession(clientSessionId);

    if (clientConnectTimer) clearTimeout(clientConnectTimer);
    clientConnectTimer = window.setTimeout(() => {
      elBtnConnectNow.disabled = false;
      elConnectStatusMsg.textContent = `Không tìm thấy thiết bị ${formattedId}. Hãy chắc chắn máy đích đang mở SwiftDesk và có kết nối Internet.`;
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

  /**
   * Connects to a remote machine via Direct IP:Port (LAN or VPN).
   */
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
        elConnectStatusMsg.textContent = `Không thể kết nối tới ${ip}:${port}. Bạn có thể nhập Mã ID 9 số của máy đích để kết nối qua Internet.`;
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
      // Fallback frame relay rendering when strict firewall blocks UDP WebRTC
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
      const isCloud = clientTransport === 'cloud';
      const savedId = isCloud
        ? hostInfo.deviceId || clientTargetDeviceId
        : hostInfo.deviceId || `${activeRemoteIp}:${activeRemotePort}`;

      const updatedSaved = await swiftdesk.upsertSavedDevice({
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
      });
      currentConfig.savedDevices = updatedSaved;
      renderSavedDevices(updatedSaved);

      openViewerOverlay(hostInfo, msg.displays || [], clientQuality);
      setupClientWebRTC();
      return;
    }

    if (msg.type === 'webrtc-offer' && msg.sdp && clientPc) {
      if (msg.displayId) {
        activeRemoteDisplayId = String(msg.displayId);
      }
      await clientPc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await clientPc.createAnswer();
      await clientPc.setLocalDescription(answer);
      sendClientSignaling({
        type: 'webrtc-answer',
        sdp: clientPc.localDescription,
      });
    } else if (msg.type === 'webrtc-ice' && msg.candidate && clientPc) {
      try {
        await clientPc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      } catch {}
    } else if (msg.type === 'session-closed') {
      showToast(msg.reason || 'Máy chủ đã đóng kết nối', 'info');
      disconnectClientViewer(false);
    }
  }

  function setupClientWebRTC(): void {
    if (clientPc) {
      try {
        clientPc.close();
      } catch {}
    }
    clientHasWebRtcVideo = false;
    elRemoteVideo.classList.remove('hidden');
    elRemoteCanvas.classList.add('hidden');

    const pc = new RTCPeerConnection(RTC_CONFIG);
    clientPc = pc;

    clientFastChannel = pc.createDataChannel('input-fast', {
      ordered: false,
      maxRetransmits: 0,
    });

    clientReliableChannel = pc.createDataChannel('input-reliable', {
      ordered: true,
    });

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        sendClientSignaling({
          type: 'webrtc-ice',
          candidate: ev.candidate,
        });
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
        elRemoteVideo.onloadeddata = () => {
          clientHasWebRtcVideo = true;
          elRemoteCanvas.classList.add('hidden');
          elRemoteVideo.classList.remove('hidden');
          elViewerLoading.classList.add('hidden');
          elViewerStage.focus();
        };
      }
    };

    // If WebRTC UDP/TURN takes > 2.6s across strict NATs, automatically request Cloud Frame Relay so screen still shows immediately!
    if (clientWebRtcFallbackTimer) clearTimeout(clientWebRtcFallbackTimer);
    clientWebRtcFallbackTimer = window.setTimeout(() => {
      if (!clientHasWebRtcVideo && !elViewerOverlay.classList.contains('hidden')) {
        sendClientSignaling({ type: 'request-frame-relay' });
      }
    }, 2600);
  }

  function openViewerOverlay(
    hostInfo: any,
    displays: DisplaySourceInfo[],
    quality: 'ultra' | 'balanced' | 'low'
  ): void {
    elViewerHostName.textContent = hostInfo.deviceName || activeRemoteTargetLabel;
    elViewerHostIp.textContent = activeRemoteTargetLabel;
    elViewerQualitySelect.value = quality;
    elViewerLoadingText.textContent = 'Đang đồng bộ hình ảnh màn hình từ xa...';
    elViewerLoading.classList.remove('hidden');
    elViewerOverlay.classList.remove('hidden');

    elViewerDisplaySelect.innerHTML = '';
    if (displays && displays.length > 0) {
      displays.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify({ sourceId: d.id, displayId: d.displayId });
        opt.textContent = `${d.name} (${d.width}x${d.height})`;
        if (d.isPrimary || idx === 0) {
          opt.selected = true;
          activeRemoteDisplayId = d.displayId;
        }
        elViewerDisplaySelect.appendChild(opt);
      });
    }

    if (clientPingTimer) clearInterval(clientPingTimer);
    clientPingTimer = window.setInterval(() => {
      sendClientSignaling({ type: 'ping', ts: Date.now() });
    }, 1800);

    if (clientStatsTimer) clearInterval(clientStatsTimer);
    lastFramesDecoded = 0;
    relayFramesCount = 0;
    lastStatsTime = performance.now();

    clientStatsTimer = window.setInterval(async () => {
      if (!clientHasWebRtcVideo) {
        if (relayFramesCount > 0) {
          elStatFps.textContent = `${relayFramesCount} FPS (Relay)`;
          relayFramesCount = 0;
        }
        return;
      }
      if (!clientPc) return;
      try {
        const stats = await clientPc.getStats();
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            const now = performance.now();
            const elapsedSec = Math.max(0.1, (now - lastStatsTime) / 1000);
            const frames = report.framesDecoded || 0;
            const fps = Math.round((frames - lastFramesDecoded) / elapsedSec);
            lastFramesDecoded = frames;
            lastStatsTime = now;

            if (fps > 0 && fps <= 144) {
              elStatFps.textContent = `${fps} FPS`;
            }
            if (elRemoteVideo.videoWidth && elRemoteVideo.videoHeight) {
              elStatRes.textContent = `${elRemoteVideo.videoWidth}x${elRemoteVideo.videoHeight}`;
            }
          }
        });
      } catch {}
    }, 1000);
  }

  function disconnectClientViewer(notifyRemote = true): void {
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

  function sendRemoteInput(event: Record<string, unknown>, isFastMove = false): void {
    event.displayId = activeRemoteDisplayId;
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

  let pendingMouseMove: { x: number; y: number } | null = null;
  let rafMouseScheduled = false;
  let lastCloudMoveSent = 0;

  elViewerStage.addEventListener('mousemove', (e) => {
    const coords = getNormalizedVideoCoords(e.clientX, e.clientY);
    if (!coords) return;
    pendingMouseMove = coords;
    if (!rafMouseScheduled) {
      rafMouseScheduled = true;
      requestAnimationFrame(() => {
        rafMouseScheduled = false;
        if (!pendingMouseMove) return;

        // If DataChannel isn't open yet and using Cloud signaling, cap mousemove rate to ~30Hz
        const dcOpen = clientFastChannel && clientFastChannel.readyState === 'open';
        const now = performance.now();
        if (!dcOpen && clientTransport === 'cloud' && now - lastCloudMoveSent < 32) {
          return;
        }
        lastCloudMoveSent = now;

        sendRemoteInput(
          {
            type: 'mousemove',
            x: pendingMouseMove.x,
            y: pendingMouseMove.y,
          },
          true
        );
        pendingMouseMove = null;
      });
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
    sendRemoteInput({
      type: 'mousedown',
      button: mapMouseButton(e.button),
      x: coords.x,
      y: coords.y,
    });
  });

  elViewerStage.addEventListener('mouseup', (e) => {
    e.preventDefault();
    const coords = getNormalizedVideoCoords(e.clientX, e.clientY);
    if (!coords) return;
    sendRemoteInput({
      type: 'mouseup',
      button: mapMouseButton(e.button),
      x: coords.x,
      y: coords.y,
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

  elViewerStage.addEventListener('keydown', (e) => {
    if (elViewerOverlay.classList.contains('hidden')) return;
    e.preventDefault();
    e.stopPropagation();

    sendRemoteInput({
      type: 'keydown',
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    });
  });

  elViewerStage.addEventListener('keyup', (e) => {
    if (elViewerOverlay.classList.contains('hidden')) return;
    e.preventDefault();
    e.stopPropagation();

    sendRemoteInput({
      type: 'keyup',
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    });
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
    } catch {}
  });

  elViewerQualitySelect.addEventListener('change', () => {
    sendClientSignaling({
      type: 'change-quality',
      quality: elViewerQualitySelect.value,
    });
    showToast(`Đã chuyển chế độ truyền hình ảnh sang ${elViewerQualitySelect.value.toUpperCase()}`, 'info');
  });

  elBtnViewerScale.addEventListener('click', () => {
    isOriginalScale = !isOriginalScale;
    elRemoteVideo.classList.toggle('scale-original', isOriginalScale);
    elRemoteCanvas.classList.toggle('scale-original', isOriginalScale);
    elBtnViewerScale.textContent = isOriginalScale ? 'Tỉ lệ 1:1' : 'Vừa màn hình';
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

  elBtnViewerAltTab.addEventListener('click', () => {
    sendRemoteInput({ type: 'special-combo', combo: 'alt-tab' });
  });

  elBtnViewerWinKey.addEventListener('click', () => {
    sendRemoteInput({ type: 'special-combo', combo: 'win-key' });
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
