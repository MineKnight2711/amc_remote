import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { app } from 'electron';
import { AppConfig, SavedDevice, TrustedController } from '../shared/types';

export function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 10000, 32, 'sha256').toString('hex');
}

export function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function generateRandomPassword(length = 8): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

export function generateDeviceId(): string {
  // Format: XXX-XXX-XXX numeric or alphanumeric ID for easy identification
  const num = Math.floor(100000000 + Math.random() * 900000000).toString();
  return `${num.slice(0, 3)}-${num.slice(3, 6)}-${num.slice(6, 9)}`;
}

export class ConfigStore {
  private filePath: string;
  private config: AppConfig;

  constructor() {
    const userDataPath = app.getPath('userData');
    fs.mkdirSync(userDataPath, { recursive: true });
    this.filePath = path.join(userDataPath, 'swiftdesk-config.json');
    this.config = this.loadOrInit();
  }

  private loadOrInit(): AppConfig {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<AppConfig>;
        const hostSecret = parsed.hostSecret || crypto.randomBytes(32).toString('hex');
        const password = parsed.password || generateRandomPassword(8);
        return {
          deviceId: parsed.deviceId || generateDeviceId(),
          deviceName: parsed.deviceName || os.hostname() || 'My Computer',
          listenPort: parsed.listenPort || 9876,
          password,
          passwordHash: parsed.passwordHash || hashPassword(password, hostSecret),
          hostSecret,
          autoStart: parsed.autoStart !== undefined ? parsed.autoStart : true,
          minimizeToTray: parsed.minimizeToTray !== undefined ? parsed.minimizeToTray : true,
          defaultQuality: parsed.defaultQuality || 'ultra',
          allowClipboardSync: parsed.allowClipboardSync !== undefined ? parsed.allowClipboardSync : true,
          savedDevices: Array.isArray(parsed.savedDevices) ? parsed.savedDevices : [],
          trustedControllers: Array.isArray(parsed.trustedControllers) ? parsed.trustedControllers : [],
        };
      } catch (err) {
        console.error('Failed to read config, initializing defaults:', err);
      }
    }

    const hostSecret = crypto.randomBytes(32).toString('hex');
    const initialPassword = generateRandomPassword(8);
    const defaultConfig: AppConfig = {
      deviceId: generateDeviceId(),
      deviceName: os.hostname() || 'My Computer',
      listenPort: 9876,
      password: initialPassword,
      passwordHash: hashPassword(initialPassword, hostSecret),
      hostSecret,
      autoStart: true,
      minimizeToTray: true,
      defaultQuality: 'ultra',
      allowClipboardSync: true,
      savedDevices: [],
      trustedControllers: [],
    };
    this.save(defaultConfig);
    return defaultConfig;
  }

  public get(): AppConfig {
    return this.config;
  }

  public save(newConfig?: Partial<AppConfig>): AppConfig {
    if (newConfig) {
      this.config = { ...this.config, ...newConfig };
    }
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error saving config:', err);
    }
    return this.config;
  }

  public setPassword(newPassword: string): AppConfig {
    const clean = newPassword.trim();
    if (!clean) {
      throw new Error('Mật khẩu không được để trống');
    }
    this.config.password = clean;
    this.config.passwordHash = hashPassword(clean, this.config.hostSecret);
    return this.save();
  }

  public verifyPassword(candidate: string): boolean {
    if (!candidate) return false;
    return candidate === this.config.password ||
      hashPassword(candidate, this.config.hostSecret) === this.config.passwordHash;
  }

  /**
   * Issues a persistent Trust Token for a remote controller that successfully authenticated via password.
   * Subsequent connections from this controller can use this token without re-entering the password.
   */
  public issueTrustToken(controllerId: string, controllerName: string, platform: string): string {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    const now = Date.now();

    const existingIdx = this.config.trustedControllers.findIndex(
      (c) => c.controllerId === controllerId
    );
    const entry: TrustedController = {
      controllerId,
      controllerName,
      platform,
      tokenHash,
      createdAt: existingIdx >= 0 ? this.config.trustedControllers[existingIdx].createdAt : now,
      lastUsedAt: now,
    };

    if (existingIdx >= 0) {
      this.config.trustedControllers[existingIdx] = entry;
    } else {
      this.config.trustedControllers.push(entry);
    }
    this.save();
    return rawToken;
  }

  public verifyTrustToken(controllerId: string, rawToken: string): boolean {
    if (!controllerId || !rawToken) return false;
    const tokenHash = sha256(rawToken);
    const found = this.config.trustedControllers.find(
      (c) => c.controllerId === controllerId && c.tokenHash === tokenHash
    );
    if (found) {
      found.lastUsedAt = Date.now();
      this.save();
      return true;
    }
    return false;
  }

  public revokeTrustedController(controllerId: string): AppConfig {
    this.config.trustedControllers = this.config.trustedControllers.filter(
      (c) => c.controllerId !== controllerId
    );
    return this.save();
  }

  /**
   * Saves or updates a remote device after connecting once so the user can connect with 1 click next time.
   */
  public upsertSavedDevice(device: Omit<SavedDevice, 'lastConnectedAt'> & { lastConnectedAt?: number }): SavedDevice[] {
    const now = device.lastConnectedAt || Date.now();
    const idx = this.config.savedDevices.findIndex(
      (d) => (device.id && d.id === device.id) || (d.ip === device.ip && d.port === device.port)
    );

    const updated: SavedDevice = {
      id: device.id || `${device.ip}:${device.port}`,
      name: device.name || device.ip,
      ip: device.ip,
      port: device.port,
      platform: device.platform || 'unknown',
      trustToken: device.trustToken || (idx >= 0 ? this.config.savedDevices[idx].trustToken : ''),
      savedPassword: device.savedPassword ?? (idx >= 0 ? this.config.savedDevices[idx].savedPassword : undefined),
      lastConnectedAt: now,
    };

    if (idx >= 0) {
      // Preserve custom alias if user renamed it
      this.config.savedDevices[idx] = {
        ...this.config.savedDevices[idx],
        ...updated,
      };
    } else {
      this.config.savedDevices.unshift(updated);
    }

    this.save();
    return this.config.savedDevices;
  }

  public renameSavedDevice(id: string, newName: string): SavedDevice[] {
    const dev = this.config.savedDevices.find((d) => d.id === id);
    if (dev && newName.trim()) {
      dev.name = newName.trim();
      this.save();
    }
    return this.config.savedDevices;
  }

  public removeSavedDevice(id: string): SavedDevice[] {
    this.config.savedDevices = this.config.savedDevices.filter((d) => d.id !== id);
    this.save();
    return this.config.savedDevices;
  }
}
