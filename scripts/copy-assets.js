const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const srcRenderer = path.join(__dirname, '..', 'src', 'renderer');
const distRenderer = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(distRenderer, { recursive: true });

for (const file of ['index.html', 'styles.css']) {
  const srcFile = path.join(srcRenderer, file);
  const destFile = path.join(distRenderer, file);
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, destFile);
  }
}

console.log('Static assets copied to dist/renderer.');

/**
 * Self-healing check for Electron binary (fixes Node v25/v26 @electron/get install failure on macOS/Windows)
 */
function ensureElectronBinary() {
  const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
  if (!fs.existsSync(electronDir)) return;

  const pkgPath = path.join(electronDir, 'package.json');
  const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

  const platform = process.platform;
  const platformPath =
    platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : platform === 'win32'
      ? 'electron.exe'
      : 'electron';

  const pathTxtFile = path.join(electronDir, 'path.txt');
  const distDir = path.join(electronDir, 'dist');
  const binaryFullPath = path.join(distDir, platformPath);

  if (fs.existsSync(pathTxtFile) && fs.existsSync(binaryFullPath)) {
    return; // Already installed and ready
  }

  let arch = process.arch;
  if (platform === 'darwin' && arch === 'x64') {
    try {
      const translated = execSync('sysctl -in sysctl.proc_translated').toString().trim();
      if (translated === '1') arch = 'arm64';
    } catch {
      // ignore
    }
  }

  const zipName = `electron-v${version}-${platform}-${arch}.zip`;
  const zipPath = path.join(electronDir, zipName);
  const githubUrl = `https://github.com/electron/electron/releases/download/v${version}/${zipName}`;
  const mirrorUrl = `https://npmmirror.com/mirrors/electron/v${version}/${zipName}`;

  console.log(`[SwiftDesk] Downloading Electron v${version} binary for ${platform}-${arch}...`);
  fs.mkdirSync(distDir, { recursive: true });

  try {
    try {
      execSync(`curl -L --fail --retry 2 -o "${zipPath}" "${githubUrl}"`, { stdio: 'inherit' });
    } catch {
      console.log('[SwiftDesk] Retrying via mirror...');
      execSync(`curl -L --fail --retry 2 -o "${zipPath}" "${mirrorUrl}"`, { stdio: 'inherit' });
    }

    console.log('[SwiftDesk] Extracting Electron binary...');
    if (platform === 'win32') {
      execSync(`tar -xf "${zipPath}" -C "${distDir}"`, { stdio: 'inherit' });
    } else {
      execSync(`unzip -q -o "${zipPath}" -d "${distDir}"`, { stdio: 'inherit' });
    }

    fs.writeFileSync(pathTxtFile, platformPath, 'utf-8');
    try {
      fs.unlinkSync(zipPath);
    } catch {}
    console.log('[SwiftDesk] Electron binary installed successfully!');
  } catch (err) {
    console.error('[SwiftDesk] Failed to auto-install Electron binary:', err.message);
  }
}

ensureElectronBinary();
