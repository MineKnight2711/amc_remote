import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import { app } from 'electron';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let logFilePath = '';

/**
 * Mirror console.* into a log file. On macOS the app is launched through LaunchServices (`open -a`),
 * so stdout goes nowhere: without this file there is no way to see why a session died.
 * macOS: ~/Library/Logs/SwiftDesk/swiftdesk.log — Windows: %APPDATA%\SwiftDesk\logs\swiftdesk.log
 */
export function initFileLogger(): string {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, 'swiftdesk.log');
    if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > MAX_LOG_BYTES) {
      fs.renameSync(logFilePath, `${logFilePath}.old`);
    }
  } catch {
    logFilePath = '';
    return '';
  }

  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      writeLine(level.toUpperCase(), util.format(...args));
    };
  }
  writeLine('INFO', `===== SwiftDesk started (pid ${process.pid}, ${process.platform} ${process.arch}, Electron ${process.versions.electron}) =====`);
  return logFilePath;
}

export function writeLine(level: string, message: string): void {
  if (!logFilePath) return;
  try {
    fs.appendFileSync(logFilePath, `${new Date().toISOString()} [${level}] ${message}\n`);
  } catch {}
}
