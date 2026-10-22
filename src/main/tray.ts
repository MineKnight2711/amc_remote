import { Tray, Menu, nativeImage, app } from 'electron';
import * as zlib from 'zlib';

/**
 * Generates a crisp 16x16 RGBA PNG buffer in memory for the System Tray icon
 * so the app does not depend on external image files that could go missing.
 */
function createTrayPngBuffer(active = true): Buffer {
  const width = 16;
  const height = 16;
  const rawData = Buffer.alloc(height * (1 + width * 4));

  // Modern teal/blue accent when idle, emerald green when actively streaming
  const primary = active ? [16, 185, 129, 255] : [59, 130, 246, 255];
  const inner = [255, 255, 255, 255];

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    rawData[rowStart] = 0; // No PNG filter
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      // Draw a monitor bezel shape
      const inScreen = x >= 1 && x <= 14 && y >= 2 && y <= 11;
      const inInner = x >= 3 && x <= 12 && y >= 4 && y <= 9;
      const inStand = (x >= 6 && x <= 9 && y >= 12 && y <= 13) || (x >= 4 && x <= 11 && y === 14);

      if (inInner) {
        // Inner screen glow with a small center dot
        if (x >= 6 && x <= 9 && y >= 6 && y <= 7) {
          rawData[px] = inner[0];
          rawData[px + 1] = inner[1];
          rawData[px + 2] = inner[2];
          rawData[px + 3] = 255;
        } else {
          rawData[px] = primary[0];
          rawData[px + 1] = primary[1];
          rawData[px + 2] = primary[2];
          rawData[px + 3] = 210;
        }
      } else if (inScreen || inStand) {
        rawData[px] = primary[0];
        rawData[px + 1] = primary[1];
        rawData[px + 2] = primary[2];
        rawData[px + 3] = 255;
      } else {
        rawData[px] = 0;
        rawData[px + 1] = 0;
        rawData[px + 2] = 0;
        rawData[px + 3] = 0;
      }
    }
  }

  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = zlib.deflateSync(rawData);
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

export class TrayManager {
  private tray: Tray | null = null;

  constructor(
    private onShowWindow: () => void,
    private onQuitApp: () => void,
    private getStatusInfo: () => { port: number; activeCount: number; autoStart: boolean },
    private onToggleAutoStart: (enabled: boolean) => void
  ) {}

  public init(): void {
    try {
      const iconBuf = createTrayPngBuffer(false);
      const image = nativeImage.createFromBuffer(iconBuf);
      this.tray = new Tray(image);
      this.tray.setToolTip('SwiftDesk Remote Desktop');
      this.tray.on('click', () => this.onShowWindow());
      this.tray.on('double-click', () => this.onShowWindow());
      this.refreshMenu();
    } catch (err) {
      console.warn('[TrayManager] Could not initialize system tray:', err);
    }
  }

  public refreshMenu(): void {
    if (!this.tray) return;
    const status = this.getStatusInfo();
    const iconBuf = createTrayPngBuffer(status.activeCount > 0);
    this.tray.setImage(nativeImage.createFromBuffer(iconBuf));

    const statusLabel =
      status.activeCount > 0
        ? `🟢 Đang có ${status.activeCount} thiết bị điều khiển (Port ${status.port})`
        : `⚡ Sẵn sàng kết nối (Port ${status.port})`;

    const menu = Menu.buildFromTemplate([
      {
        label: 'SwiftDesk Remote Desktop',
        enabled: false,
      },
      {
        label: statusLabel,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Mở bảng điều khiển',
        click: () => this.onShowWindow(),
      },
      {
        label: 'Khởi động cùng Windows / macOS',
        type: 'checkbox',
        checked: status.autoStart,
        click: (item) => this.onToggleAutoStart(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Thoát hoàn toàn',
        click: () => {
          this.onQuitApp();
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(menu);
  }
}
