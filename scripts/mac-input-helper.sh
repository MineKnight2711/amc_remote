#!/bin/bash
# Build + install the SwiftDesk privileged input helper (macOS), so SwiftDesk can type at the login
# window / lock screen the way RustDesk does (a root LaunchDaemon posting keystrokes).
#
#   sudo bash scripts/mac-input-helper.sh install
#   sudo bash scripts/mac-input-helper.sh uninstall
#   sudo bash scripts/mac-input-helper.sh status
set -euo pipefail

LABEL="com.swiftdesk.inputhelper"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
DEST_DIR="/Library/Application Support/SwiftDesk"
BIN="${DEST_DIR}/swiftdesk-input-helper"
SOCK="/var/run/com.swiftdesk.inputhelper.sock"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${REPO_DIR}/native/mac-input-helper/main.swift"

die() { echo "✖ $*" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "Chỉ dùng trên macOS."
[[ $EUID -eq 0 ]] || die "Cần quyền admin: sudo bash scripts/mac-input-helper.sh ${1:-install}"

case "${1:-install}" in
  install)
    command -v swiftc >/dev/null 2>&1 || die "Thiếu swiftc. Cài Xcode Command Line Tools: xcode-select --install"
    [[ -f "$SRC" ]] || die "Không tìm thấy mã nguồn: $SRC"

    echo "→ Biên dịch helper..."
    mkdir -p "$DEST_DIR" "/Library/Logs/SwiftDesk"
    swiftc -O -o "$BIN" "$SRC"
    chown root:wheel "$BIN"
    chmod 755 "$BIN"

    echo "→ Tạo LaunchDaemon ${PLIST}"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BIN}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardErrorPath</key>
  <string>/Library/Logs/SwiftDesk/inputhelper.err</string>
  <key>StandardOutPath</key>
  <string>/Library/Logs/SwiftDesk/inputhelper.out</string>
</dict>
</plist>
EOF
    chown root:wheel "$PLIST"
    chmod 644 "$PLIST"
    plutil -lint "$PLIST" >/dev/null || die "plist không hợp lệ"

    launchctl bootout system "$PLIST" 2>/dev/null || true
    launchctl bootstrap system "$PLIST"
    sleep 1

    echo "✓ Đã cài và chạy helper."
    cat <<TXT

QUAN TRỌNG — cấp quyền Trợ năng (một lần):
  Helper vừa tự thêm mình vào danh sách, nên KHÔNG cần tìm nút "+":
    1. Mở  System Settings › Privacy & Security › Accessibility
    2. Tìm dòng  "swiftdesk-input-helper"  trong danh sách và BẬT công tắc của nó.
    3. Áp dụng quyền:   npm run mac:helper:restart
  (Nếu chưa thấy dòng đó, chạy  npm run mac:helper  một lần nữa rồi mở lại danh sách.)

Kiểm tra:
  npm start -- --force-helper
  rồi điều khiển từ Windows và thử gõ. Bấm thanh FPS để xem dòng chẩn đoán (helper=on, viaHelper tăng).

Log helper (có dòng "accessibility trusted = true/false"):  /Library/Logs/SwiftDesk/inputhelper.err
TXT
    ;;

  restart)
    launchctl kickstart -k "system/${LABEL}" 2>/dev/null || { launchctl bootout system "$PLIST" 2>/dev/null || true; launchctl bootstrap system "$PLIST"; }
    echo "✓ Đã khởi động lại helper (áp dụng quyền vừa cấp)."
    ;;

  uninstall)
    launchctl bootout system "$PLIST" 2>/dev/null || true
    rm -f "$PLIST" "$BIN" "$SOCK"
    echo "✓ Đã gỡ helper."
    ;;

  status)
    echo "Binary:  $( [[ -x "$BIN" ]] && echo "có ($BIN)" || echo "chưa cài" )"
    echo "Socket:  $( [[ -S "$SOCK" ]] && echo "đang mở ($SOCK)" || echo "không thấy" )"
    launchctl print "system/${LABEL}" 2>/dev/null | grep -E "state =|pid =" || echo "Daemon: chưa chạy"
    ;;

  *)
    die "Dùng: sudo bash scripts/mac-input-helper.sh [install|uninstall|status]"
    ;;
esac
