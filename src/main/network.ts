import * as os from 'os';
import * as http from 'http';
import { NetworkInterfaceInfo, HostPublicInfo, SavedDevice } from '../shared/types';

export function getLocalNetworkInterfaces(): NetworkInterfaceInfo[] {
  const nets = os.networkInterfaces();
  const results: NetworkInterfaceInfo[] = [];

  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;

      const lowerName = name.toLowerCase();
      const ip = addr.address;

      let type: 'vpn' | 'lan' | 'other' = 'other';
      let label = name;

      // Detect Tailscale / CGNAT Mesh VPN range (100.64.0.0/10) or interface names
      const octets = ip.split('.').map(Number);
      const isTailscaleRange = octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;

      if (lowerName.includes('tailscale') || isTailscaleRange) {
        type = 'vpn';
        label = 'Tailscale Mesh VPN';
      } else if (lowerName.includes('zerotier') || lowerName.startsWith('zt')) {
        type = 'vpn';
        label = 'ZeroTier VPN';
      } else if (
        lowerName.includes('wireguard') ||
        lowerName.includes('wg') ||
        lowerName.includes('radmin') ||
        lowerName.includes('hamachi') ||
        lowerName.includes('tun') ||
        lowerName.includes('tap')
      ) {
        type = 'vpn';
        label = `VPN (${name})`;
      } else if (
        octets[0] === 192 ||
        octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      ) {
        type = 'lan';
        label = `LAN / Wi-Fi (${name})`;
      }

      results.push({
        name,
        address: ip,
        type,
        label,
      });
    }
  }

  // Sort VPNs first (ideal for Internet remote control), then LAN IPs
  results.sort((a, b) => {
    const order = { vpn: 0, lan: 1, other: 2 };
    return order[a.type] - order[b.type];
  });

  return results;
}

export function probeRemoteHost(
  ip: string,
  port: number,
  timeoutMs = 1800
): Promise<{ online: boolean; latencyMs?: number; info?: HostPublicInfo }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.get(
      {
        host: ip,
        port,
        path: '/ping',
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ online: false });
          return;
        }
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const latencyMs = Math.max(1, Date.now() - start);
          try {
            const info = JSON.parse(body) as HostPublicInfo;
            resolve({ online: true, latencyMs, info });
          } catch {
            resolve({ online: true, latencyMs });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ online: false });
    });

    req.on('error', () => {
      resolve({ online: false });
    });
  });
}

export async function probeSavedDevices(devices: SavedDevice[]): Promise<SavedDevice[]> {
  return Promise.all(
    devices.map(async (dev) => {
      const res = await probeRemoteHost(dev.ip, dev.port, 1500);
      return {
        ...dev,
        online: res.online,
        latencyMs: res.latencyMs,
        name: res.info?.deviceName || dev.name,
        platform: res.info?.platform || dev.platform,
      };
    })
  );
}
