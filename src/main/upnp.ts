import * as dgram from 'dgram';
import * as http from 'http';
import * as os from 'os';

/**
 * Minimal UPnP IGD client used to open the router's UDP port for a WebRTC host candidate.
 * This turns a NAT'd host into a directly reachable one, so P2P works even when the OTHER side
 * is behind a symmetric / carrier-grade NAT (where STUN-only hole punching always fails).
 */

interface Gateway {
  controlUrl: string;
  serviceType: string;
  localAddress: string; // Our LAN IPv4 on the interface facing the gateway
  externalIp: string;
}

export interface UdpMapping {
  externalIp: string;
  externalPort: number;
}

const SSDP_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const DISCOVERY_TIMEOUT_MS = 4000;
const HTTP_TIMEOUT_MS = 3000;
const LEASE_SECONDS = 3600; // Router drops the mapping by itself if the app crashes
const RETRY_FAILED_DISCOVERY_MS = 60_000;
const REFRESH_GATEWAY_MS = 10 * 60_000; // Network may change (laptop moved, router replaced)

/** Private, CGNAT (100.64/10) or empty addresses mean the router itself sits behind another NAT. */
export function isNonPublicIpv4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return true;
  return (
    o[0] === 0 ||
    o[0] === 10 ||
    o[0] === 127 ||
    (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ||
    (o[0] === 169 && o[1] === 254) ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 168)
  );
}

function xmlTag(xml: string, tag: string): string {
  const m = new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

/** Plain node:http (lenient parser): embedded router web servers often break fetch()'s strict parser. */
function httpRequest(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string> = {},
  body = ''
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: body ? { ...headers, 'Content-Length': String(Buffer.byteLength(body)) } : headers,
        timeout: HTTP_TIMEOUT_MS,
        insecureHTTPParser: true,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body || undefined);
  });
}

function lanIpv4Addresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

export class UpnpPortMapper {
  private gatewayPromise: Promise<Gateway | null> | null = null;
  private gatewayExpiresAt = 0;
  private mappings = new Map<string, { owner: string; externalPort: number }>();

  /** Discover the gateway ahead of time so the first session doesn't wait for SSDP. */
  public warmUp(): void {
    this.getGateway().catch(() => {});
  }

  public async mapUdp(owner: string, internalIp: string, internalPort: number): Promise<UdpMapping | null> {
    const gw = await this.getGateway();
    // Only the interface that actually faces the gateway can be forwarded to
    if (!gw || gw.localAddress !== internalIp) return null;

    const key = `${internalIp}:${internalPort}`;
    const existing = this.mappings.get(key);
    if (existing) return { externalIp: gw.externalIp, externalPort: existing.externalPort };

    // Prefer the same external port, then a few random ones if it's taken (error 718)
    const candidatesPorts = [internalPort, ...[0, 1, 2].map(() => 20000 + Math.floor(Math.random() * 40000))];
    for (const externalPort of candidatesPorts) {
      const result = await this.addMapping(gw, externalPort, internalIp, internalPort);
      if (result === 'ok') {
        this.mappings.set(key, { owner, externalPort });
        console.log(`[UPnP] Mapped UDP ${gw.externalIp}:${externalPort} -> ${key}`);
        return { externalIp: gw.externalIp, externalPort };
      }
      if (result !== 'conflict') break;
    }
    return null;
  }

  public async releaseOwner(owner: string): Promise<void> {
    const gw = this.gatewayPromise ? await this.gatewayPromise : null;
    const tasks: Promise<unknown>[] = [];
    for (const [key, m] of this.mappings) {
      if (m.owner !== owner) continue;
      this.mappings.delete(key);
      if (gw) tasks.push(this.deleteMapping(gw, m.externalPort));
    }
    await Promise.all(tasks);
  }

  public async releaseAll(): Promise<void> {
    const owners = new Set([...this.mappings.values()].map((m) => m.owner));
    await Promise.all([...owners].map((o) => this.releaseOwner(o)));
  }

  private getGateway(): Promise<Gateway | null> {
    if (this.gatewayPromise && Date.now() < this.gatewayExpiresAt) {
      return this.gatewayPromise;
    }
    this.gatewayExpiresAt = Number.MAX_SAFE_INTEGER; // Share the in-flight discovery
    this.gatewayPromise = this.discover().then((gw) => {
      this.gatewayExpiresAt = Date.now() + (gw ? REFRESH_GATEWAY_MS : RETRY_FAILED_DISCOVERY_MS);
      return gw;
    });
    return this.gatewayPromise;
  }

  private discover(): Promise<Gateway | null> {
    return new Promise((resolve) => {
      // One socket per interface: the OS default multicast route often points at a VPN adapter
      // (Radmin, Tailscale...), so a single unbound socket never reaches the real router.
      const sockets: dgram.Socket[] = [];
      const tried = new Set<string>();
      let done = false;
      const finish = (gw: Gateway | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const s of sockets) {
          try {
            s.close();
          } catch {}
        }
        if (!gw) console.log('[UPnP] No usable Internet Gateway Device found');
        resolve(gw);
      };
      const timer = setTimeout(() => finish(null), DISCOVERY_TIMEOUT_MS);

      for (const localAddress of lanIpv4Addresses()) {
        const sock = dgram.createSocket('udp4');
        sockets.push(sock);
        sock.on('error', () => {});
        sock.on('message', (msg) => {
          const loc = /^location:\s*(.+)$/im.exec(msg.toString());
          const location = loc?.[1].trim();
          if (!location || tried.has(location)) return;
          tried.add(location);
          this.inspectGateway(location, localAddress)
            .then((gw) => gw && finish(gw))
            .catch(() => {});
        });
        sock.bind(0, localAddress, () => {
          try {
            sock.setMulticastInterface(localAddress);
          } catch {}
          // Multicast over Wi-Fi is lossy: send the search twice
          for (const delay of [0, 400]) {
            setTimeout(() => {
              if (done) return;
              for (const st of SSDP_TARGETS) {
                const req = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`;
                sock.send(req, 1900, '239.255.255.250');
              }
            }, delay);
          }
        });
      }
    });
  }

  private async inspectGateway(location: string, localAddress: string): Promise<Gateway | null> {
    const xml = (await httpRequest(location, 'GET')).body;
    const service = /<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d)<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/i.exec(xml);
    if (!service) return null;

    const gw: Gateway = {
      serviceType: service[1],
      controlUrl: new URL(service[2].trim(), location).toString(),
      localAddress,
      externalIp: '',
    };
    const ext = await this.soap(gw, 'GetExternalIPAddress', '');
    gw.externalIp = xmlTag(ext.body, 'NewExternalIPAddress');
    if (isNonPublicIpv4(gw.externalIp)) {
      // Router WAN is itself behind the ISP's CGNAT: forwarding a port would be useless
      console.log(`[UPnP] Gateway WAN IP ${gw.externalIp || '(none)'} is not public (CGNAT), skipping`);
      return null;
    }
    console.log(`[UPnP] Gateway found, public IP ${gw.externalIp}, LAN ${gw.localAddress}`);
    return gw;
  }

  private async addMapping(
    gw: Gateway,
    externalPort: number,
    internalIp: string,
    internalPort: number
  ): Promise<'ok' | 'conflict' | 'error'> {
    for (const lease of [LEASE_SECONDS, 0]) {
      const args =
        `<NewRemoteHost></NewRemoteHost><NewExternalPort>${externalPort}</NewExternalPort>` +
        `<NewProtocol>UDP</NewProtocol><NewInternalPort>${internalPort}</NewInternalPort>` +
        `<NewInternalClient>${internalIp}</NewInternalClient><NewEnabled>1</NewEnabled>` +
        `<NewPortMappingDescription>SwiftDesk WebRTC</NewPortMappingDescription>` +
        `<NewLeaseDuration>${lease}</NewLeaseDuration>`;
      try {
        const res = await this.soap(gw, 'AddPortMapping', args);
        if (res.status === 200) return 'ok';
        const code = xmlTag(res.body, 'errorCode');
        if (code === '725') continue; // OnlyPermanentLeasesSupported: retry with lease 0
        if (code === '718') return 'conflict';
        console.warn(`[UPnP] AddPortMapping failed (${res.status} ${code})`);
        return 'error';
      } catch (err) {
        console.warn('[UPnP] AddPortMapping error:', (err as Error).message);
        return 'error';
      }
    }
    return 'error';
  }

  private async deleteMapping(gw: Gateway, externalPort: number): Promise<void> {
    const args = `<NewRemoteHost></NewRemoteHost><NewExternalPort>${externalPort}</NewExternalPort><NewProtocol>UDP</NewProtocol>`;
    try {
      await this.soap(gw, 'DeletePortMapping', args);
    } catch {}
  }

  private async soap(gw: Gateway, action: string, args: string): Promise<{ status: number; body: string }> {
    const body =
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
      `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
      `<u:${action} xmlns:u="${gw.serviceType}">${args}</u:${action}></s:Body></s:Envelope>`;
    return httpRequest(
      gw.controlUrl,
      'POST',
      { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${gw.serviceType}#${action}"` },
      body
    );
  }
}
