#!/bin/bash
# SwiftDesk login-window agent for macOS.
#
# Without it, SwiftDesk only starts after someone logs in, so after a restart the Mac is unreachable.
# This installs a LaunchAgent limited to the LoginWindow session: macOS starts it (as root) whenever
# the login screen is shown, so you can connect with the same Cloud ID and type the Mac's password
# remotely. As soon as a user logs in it exits and that user's own SwiftDesk takes over (the viewer
# reconnects by itself).
#
#   sudo bash scripts/mac-loginwindow.sh install     # or: npm run mac:loginwindow
#   sudo bash scripts/mac-loginwindow.sh uninstall
#   sudo bash scripts/mac-loginwindow.sh power       # optional: auto power-on after a power cut, wake on LAN
set -euo pipefail

LABEL="com.swiftdesk.remote.loginwindow"
PLIST="/Library/LaunchAgents/${LABEL}.plist"
APP_DEST="/Applications/SwiftDesk.app"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_SRC="${REPO_DIR}/dist/mac/SwiftDesk.app"

die() { echo "✖ $*" >&2; exit 1; }
xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

[[ "$(uname)" == "Darwin" ]] || die "Chỉ dùng trên macOS."
[[ $EUID -eq 0 ]] || die "Cần quyền admin: sudo bash scripts/mac-loginwindow.sh ${1:-install}"
TARGET_USER="${SUDO_USER:-}"
[[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]] || die "Hãy chạy bằng sudo từ tài khoản của bạn (không phải root)."
USER_HOME="$(dscl . -read "/Users/${TARGET_USER}" NFSHomeDirectory | awk '{print $2}')"
CONFIG_FILE="${USER_HOME}/Library/Application Support/SwiftDesk/swiftdesk-config.json"

check_filevault() {
  if fdesetup status 2>/dev/null | grep -q "FileVault is On"; then
    cat <<'TXT'

⚠ FileVault đang BẬT.
  Sau khi khởi động lại/tắt nguồn, ổ đĩa bị khoá và màn hình mở khoá FileVault xuất hiện TRƯỚC khi macOS
  chạy: không phần mềm nào (kể cả SwiftDesk) có thể chạy ở bước đó để điều khiển từ xa.
  Lựa chọn:
   • Khi tự khởi động lại máy: dùng  sudo fdesetup authrestart  (lần khởi động kế tiếp tự mở khoá FileVault
     và dừng ở màn hình đăng nhập, nơi SwiftDesk hoạt động).
   • Hoặc tắt FileVault (System Settings › Privacy & Security › FileVault) nếu chấp nhận đánh đổi bảo mật.
TXT
  else
    echo "✓ FileVault đang tắt: sau khi khởi động lại, SwiftDesk sẽ chạy ở màn hình đăng nhập."
  fi
}

case "${1:-install}" in
  install)
    [[ -d "$APP_SRC" ]] || die "Chưa có ${APP_SRC}. Chạy 'npm start' một lần trước."
    [[ -f "$CONFIG_FILE" ]] || die "Chưa có cấu hình SwiftDesk của ${TARGET_USER}. Mở SwiftDesk một lần trước."

    echo "→ Cài SwiftDesk vào ${APP_DEST}"
    # Same signed bundle = same identity, so the Screen Recording / Accessibility permissions already
    # granted to SwiftDesk apply. Owned by the user so 'npm start' keeps it updated without sudo.
    # (Never kill the running SwiftDesk here: this script is typically run through a remote session.)
    rsync -a --delete "${APP_SRC}/" "${APP_DEST}/"
    chown -R "${TARGET_USER}:admin" "${APP_DEST}"
    xattr -cr "${APP_DEST}" 2>/dev/null || true
    EXEC_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${APP_DEST}/Contents/Info.plist")"

    mkdir -p "/Library/Logs/SwiftDesk" "/Library/Application Support/SwiftDesk/loginwindow"

    echo "→ Tạo ${PLIST}"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>LimitLoadToSessionType</key>
  <array>
    <string>LoginWindow</string>
  </array>
  <key>ProgramArguments</key>
  <array>
    <string>${APP_DEST}/Contents/MacOS/${EXEC_NAME}</string>
    <string>--login-window</string>
    <string>--no-sandbox</string>
    <string>--config-file=$(printf '%s' "$CONFIG_FILE" | xml_escape)</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>/Library/Logs/SwiftDesk/loginwindow.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Library/Logs/SwiftDesk/loginwindow.stderr.log</string>
</dict>
</plist>
EOF
    chown root:wheel "$PLIST"
    chmod 644 "$PLIST"
    plutil -lint "$PLIST" >/dev/null || die "plist không hợp lệ"

    echo "✓ Đã cài. Agent tự chạy mỗi khi màn hình đăng nhập xuất hiện (sau khi khởi động lại hoặc Log Out)."
    check_filevault
    cat <<TXT

Từ giờ 'npm start' sẽ cập nhật và chạy bản ở ${APP_DEST}.
Thử ngay: Apple menu › Log Out (không cần khởi động lại), rồi từ Windows kết nối Mã ID như bình thường,
gõ mật khẩu Mac để đăng nhập; viewer sẽ tự kết nối lại vào phiên của bạn.
Log ở màn hình đăng nhập: /Library/Logs/SwiftDesk/swiftdesk.log
TXT
    ;;

  uninstall)
    launchctl bootout loginwindow "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ Đã gỡ agent màn hình đăng nhập (giữ nguyên ${APP_DEST})."
    ;;

  power)
    # A shut-down Mac cannot be reached by any software: the only way back is power. These make the
    # Mac turn itself on when power returns (pair with a smart plug) and wake from sleep over the network.
    pmset -a autorestart 1
    pmset -a womp 1
    echo "✓ Bật: tự khởi động khi có điện trở lại, đánh thức qua mạng (Wake on LAN)."
    echo "  Mẹo: đừng Shut Down máy cần điều khiển. Khi SwiftDesk đang chạy, máy không tự ngủ nên luôn kết nối được."
    check_filevault
    ;;

  *)
    die "Dùng: sudo bash scripts/mac-loginwindow.sh [install|uninstall|power]"
    ;;
esac
