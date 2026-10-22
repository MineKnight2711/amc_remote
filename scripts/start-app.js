const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const rootDir = path.join(__dirname, '..');

if (process.platform !== 'darwin') {
  // On Windows / Linux: launch Electron normally
  const electronBinary = require('electron');
  const child = spawn(electronBinary, [rootDir, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  child.on('close', (code) => {
    process.exit(code || 0);
  });
} else {
  // On macOS: Build & launch a real standalone "SwiftDesk.app" via LaunchServices (`open -a`)
  // so macOS TCC (Accessibility & Screen Recording) attributes permissions to "SwiftDesk"
  // instead of "Visual Studio Code" or "Terminal"!
  const electronDistApp = path.join(rootDir, 'node_modules', 'electron', 'dist', 'Electron.app');
  const macBuildDir = path.join(rootDir, 'dist', 'mac');
  const swiftDeskApp = path.join(macBuildDir, 'SwiftDesk.app');
  const resourcesDir = path.join(swiftDeskApp, 'Contents', 'Resources');
  const appBundleDir = path.join(resourcesDir, 'app');
  const infoPlist = path.join(swiftDeskApp, 'Contents', 'Info.plist');

  if (!fs.existsSync(electronDistApp)) {
    console.error('[SwiftDesk] Electron.app not found. Run npm run build first.');
    process.exit(1);
  }

  fs.mkdirSync(macBuildDir, { recursive: true });

  const isFirstBuild = !fs.existsSync(swiftDeskApp);
  if (isFirstBuild) {
    console.log('[SwiftDesk macOS] Creating standalone SwiftDesk.app bundle...');
    execSync(`cp -R "${electronDistApp}" "${swiftDeskApp}"`, { stdio: 'inherit' });

    const defaultAsar = path.join(resourcesDir, 'default_app.asar');
    if (fs.existsSync(defaultAsar)) {
      fs.unlinkSync(defaultAsar);
    }
  }

  fs.mkdirSync(appBundleDir, { recursive: true });

  // Copy package.json and compiled dist/{main,preload,renderer,shared}
  fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(appBundleDir, 'package.json'));

  const distTarget = path.join(appBundleDir, 'dist');
  fs.mkdirSync(distTarget, { recursive: true });
  for (const sub of ['main', 'preload', 'renderer', 'shared']) {
    const srcSub = path.join(rootDir, 'dist', sub);
    const destSub = path.join(distTarget, sub);
    if (fs.existsSync(srcSub)) {
      execSync(`rsync -a --delete "${srcSub}/" "${destSub}/"`);
    }
  }

  // Sync lightweight runtime node_modules (excluding heavy electron & typescript dev packages)
  const nmTarget = path.join(appBundleDir, 'node_modules');
  fs.mkdirSync(nmTarget, { recursive: true });
  execSync(
    `rsync -a --delete --exclude='electron' --exclude='@electron' --exclude='typescript' --exclude='@types' --exclude='.bin' --exclude='*.zip' "${path.join(
      rootDir,
      'node_modules'
    )}/" "${nmTarget}/"`
  );

  // Patch Info.plist so macOS recognizes the app as "SwiftDesk" (com.swiftdesk.remote)
  const plistCommands = [
    'Set :CFBundleName SwiftDesk',
    'Set :CFBundleDisplayName SwiftDesk',
    'Set :CFBundleIdentifier com.swiftdesk.remote',
  ];
  for (const cmd of plistCommands) {
    try {
      execSync(`/usr/libexec/PlistBuddy -c "${cmd}" "${infoPlist}"`, { stdio: 'ignore' });
    } catch {}
  }

  const descriptions = [
    [
      'NSScreenCaptureUsageDescription',
      'SwiftDesk cần quyền Ghi màn hình để truyền hình ảnh máy tính khi điều khiển từ xa.',
    ],
    [
      'NSAppleEventsUsageDescription',
      'SwiftDesk cần quyền Trợ năng (Accessibility) để điều khiển chuột và bàn phím từ xa.',
    ],
  ];
  for (const [key, desc] of descriptions) {
    try {
      execSync(`/usr/libexec/PlistBuddy -c "Delete :${key}" "${infoPlist}"`, { stdio: 'ignore' });
    } catch {}
    try {
      execSync(`/usr/libexec/PlistBuddy -c "Add :${key} string '${desc}'" "${infoPlist}"`, {
        stdio: 'ignore',
      });
    } catch {}
  }

  if (isFirstBuild) {
    console.log('[SwiftDesk macOS] Signing SwiftDesk.app bundle...');
    try {
      execSync(`xattr -cr "${swiftDeskApp}"`, { stdio: 'ignore' });
      execSync(`codesign --force --deep --sign - "${swiftDeskApp}"`, { stdio: 'ignore' });
    } catch (err) {
      console.warn('[SwiftDesk macOS] codesign warning:', err.message);
    }
  }

  console.log('[SwiftDesk macOS] Launching standalone SwiftDesk.app via macOS LaunchServices...');
  console.log(
    '[SwiftDesk macOS] Quyền Accessibility & Screen Recording sẽ được cấp riêng cho app "SwiftDesk" (không phải VS Code)!'
  );

  // Launch via `open -a` so macOS WindowServer/launchd owns the process, NOT VS Code!
  execSync(`open -a "${swiftDeskApp}"`, { stdio: 'inherit' });
}
