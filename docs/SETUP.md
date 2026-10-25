# SwiftDesk — Cách setup & các vấn đề cần lưu ý

Tài liệu ngắn gọn để cài đặt và những điểm cần xử lý/ghi nhớ về sau.

## 1. Cài đặt nhanh

Yêu cầu chung: Node.js, và chạy `npm install` một lần trong thư mục dự án.
`npm start` sẽ tự build (`tsc` + copy assets) rồi mở app.

### Máy Windows (thường là máy điều khiển)

```bash
npm start
```

- Lần đầu chạy sẽ tạo shortcut **SwiftDesk** trên Desktop và Start Menu → sau này mở bằng shortcut, không cần terminal.
- Mở lại khi app đang chạy: app tự khởi động lại vào bản build mới nhất.
- **Bắt toàn bộ bàn phím** bật sẵn: Win, Alt+Tab, Win+C… được gửi sang máy đích. Bấm chuột ra ngoài cửa sổ để nhả. Tắt trong menu ⌨ nếu cần.

### Máy Mac (thường là máy được điều khiển)

```bash
npm start
```

Để điều khiển được **cả khi chưa đăng nhập / màn hình khoá**, cài thêm 2 thành phần (mỗi cái 1 lần):

**a) Agent màn hình đăng nhập** — để SwiftDesk tự chạy ở màn hình đăng nhập sau khi khởi động lại:

```bash
npm run mac:loginwindow
```

Sau khi cài, `npm start` sẽ cập nhật và chạy bản ở `/Applications/SwiftDesk.app`.

**b) Helper gõ phím (quan trọng cho màn hình khoá/đăng nhập)** — tiến trình native quyền root, giống cơ chế RustDesk:

```bash
npm run mac:helper            # build (cần Xcode CLT: xcode-select --install) + cài LaunchDaemon
```

Rồi **cấp quyền** (một lần):

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
```

- macOS mới gọi mục này là **"Device Control and Data Access"**.
- Bấm **＋** cuối danh sách → `Cmd+Shift+G` → dán `/Library/Application Support/SwiftDesk/swiftdesk-input-helper` → Open → **bật công tắc**.
- Áp dụng: `npm run mac:helper:restart`

Lệnh tiện ích: `npm run mac:helper:status`, `npm run mac:helper:uninstall`, `npm run mac:loginwindow:uninstall`.

## 2. Dùng khi điều khiển Mac từ Windows

- **Ctrl trái** = ⌘ (copy/dán/undo). **Ctrl phải** = Control thật (dừng lệnh Terminal: Ctrl phải + C). Có nút "Dừng lệnh Terminal" trong menu ⌨.
- **Clipboard** tự đồng bộ khi copy; dán bằng Ctrl trái + V.
- **Gõ tiếng Việt:** bật bộ gõ **trên Mac**, TẮT bộ gõ trên Windows (bật cả hai sẽ lỗi dấu).
- **Độ phân giải:** chọn "Theo màn hình" (vd 2560×1440) thay vì "Gốc" (4K) để FPS cao hơn.
- **Chẩn đoán:** bấm vào thanh FPS/ping trên toolbar để copy một dòng thông tin (path P2P/Relay, FPS, helper=…, v.v.).

## 3. Các vấn đề / việc cần xử lý về sau

- **Cấp lại quyền helper sau khi build lại:** helper ký ad-hoc, mỗi lần `npm run mac:helper` (biên dịch lại) đổi chữ ký → quyền trong "Device Control and Data Access" có thể mất → phải xoá dòng cũ và **thêm + bật lại**. (Hướng giải quyết lâu dài: ký bằng Developer ID để quyền giữ nguyên qua các bản build.)
- **FileVault:** đang TẮT trên máy này. Nếu bật, sau khi **khởi động lại** sẽ có màn hình mở khoá FileVault TRƯỚC khi hệ thống chạy → không phần mềm nào vào được ở bước đó (dùng `sudo fdesetup authrestart` khi cần restart).
- **Tắt nguồn hẳn = không vào được từ xa.** Nên dùng Sleep thay vì Shut Down. `sudo bash scripts/mac-loginwindow.sh power` bật tự khởi động lại khi có điện + Wake-on-LAN.
- **Kết nối P2P thất bại → Relay ~3–6 FPS** (qua MQTT công cộng). Xảy ra khi cả hai mạng đều không có đường trực tiếp (IPv6 / UPnP). Hướng cải thiện: dựng TURN server riêng (coturn).
- **Alt+Tab** gửi sang Mac ở dạng phím thô (không phải trình chuyển app của macOS là ⌘Tab) — dùng nút trên toolbar để chuyển app.
- **Bảo mật:** giữ mật khẩu khoá màn hình + KHÔNG bật tự động đăng nhập; socket của helper mở quyền 0666 (chấp nhận được với máy cá nhân, nhưng là điểm cần cân nhắc nếu nhiều người dùng chung máy).
- **Electron trên Node mới (v26):** script tự tải binary Electron nếu thiếu.

## 4. Kiến trúc (tóm tắt)

- Truyền hình: WebRTC P2P (codec VP9), tự hạ xuống Relay (JPEG qua MQTT) khi P2P fail.
- Kết nối: Mã ID 9 số qua MQTT broker công cộng (không cần VPN), hoặc IP LAN trực tiếp.
- Input: `src/main/input-controller.ts` (koffi FFI → user32 trên Windows, CoreGraphics trên macOS).
- Bắt bàn phím Windows: `src/main/keyboard-capture.ts` (SetWindowsHookEx WH_KEYBOARD_LL).
- Helper macOS: `native/mac-input-helper/main.swift` (root LaunchDaemon) + `src/main/input-helper-client.ts`.
- Log: Windows `%APPDATA%\SwiftDesk\logs`, macOS `~/Library/Logs/SwiftDesk` và `/Library/Logs/SwiftDesk` (helper + login-window).
