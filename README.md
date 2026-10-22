# SwiftDesk — Remote Desktop 60FPS (Windows & macOS)

Ứng dụng điều khiển máy tính từ xa 2 chiều tốc độ cao được xây dựng bằng **Electron + TypeScript + WebRTC P2P Hardware Acceleration** kết hợp với **Native C FFI (`koffi` -> `user32.dll` trên Windows & `CoreGraphics/Quartz` trên macOS)** cho độ trễ thao tác chuột/phím dưới `0.1ms`.

---

## ✨ Tính năng nổi bật

1. **Khởi động tự động cùng Windows & macOS**:
   - Tự động đăng ký vào **Windows Registry (`HKCU\...\Run`)**, **macOS LaunchAgents (`~/Library/LaunchAgents`)** và Login Items của hệ điều hành.
   - Chạy ngầm ở **System Tray (Khay hệ thống / Menu Bar)** ngay khi mở máy, luôn sẵn sàng nhận kết nối 24/7.
2. **Điều khiển qua Internet & Nội bộ (Direct IP / Mesh VPN)**:
   - Tự động nhận diện địa chỉ IP từ **Tailscale (`100.x.x.x`)**, **ZeroTier**, **WireGuard**, **Radmin VPN** cũng như mạng **LAN / Wi-Fi**.
   - Tắt cơ chế ẩn IP mDNS của Chromium (`WebRtcHideLocalIpsWithMdns`) để thiết lập đường truyền P2P trực tiếp giữa 2 thiết bị qua VPN/LAN trong `< 50ms`.
3. **Cài đặt mật khẩu & Lưu thiết bị kết nối 1-Chạm**:
   - Mỗi máy có mật khẩu bảo vệ cố định (có thể tự đặt hoặc tạo ngẫu nhiên).
   - **Lưu máy sau lần kết nối đầu tiên**: Khi bạn nhập đúng mật khẩu ở lần kết nối đầu tiên, máy chủ sẽ cấp một **Trusted Device Token** (lưu bảo mật bằng `SHA-256`).
   - Từ lần thứ 2 trở đi, chỉ cần nhấn **⚡ Kết nối ngay** tại mục **Thiết bị đã lưu** mà không cần nhập lại mật khẩu.
   - Tự động ping kiểm tra trạng thái **Online / Offline** và độ trễ (`ms`) của các máy đã lưu.
4. **Tốc độ 60 FPS & Phản hồi tức thì**:
   - Luồng hình ảnh WebRTC 60 FPS với `contentHint = 'motion'`, `degradationPreference = 'maintain-framerate'`, bitrate lên tới `12 Mbps`.
   - Bộ nhận hình ảnh loại bỏ hoàn toàn độ trễ bộ đệm (`playoutDelayHint = 0`, `jitterBufferTarget = 0`).
   - Giữ nguyên tốc độ 60 FPS ngay cả khi cửa sổ máy chủ đang thu nhỏ dưới System Tray (`backgroundThrottling: false`).
   - Điều khiển chuột truyền qua kênh UDP `RTCDataChannel` (`ordered: false, maxRetransmits: 0`) đồng bộ theo `requestAnimationFrame`.

---

## 🚀 Cách chạy dự án

### 1. Cài đặt thư viện
```bash
npm install
```

### 2. Biên dịch và khởi chạy ứng dụng
```bash
npm start
```

---

## 🌐 Hướng dẫn kết nối giữa 2 máy (Windows ↔ macOS) qua Internet

1. **Cài đặt Mesh VPN miễn phí (Khuyên dùng Tailscale hoặc ZeroTier)** trên cả 2 máy:
   - Tải [Tailscale](https://tailscale.com/) trên máy Windows và macOS, đăng nhập cùng 1 tài khoản.
2. **Mở SwiftDesk trên cả 2 máy**:
   - Ở cột bên trái (**Máy tính của bạn**), ứng dụng sẽ tự động hiển thị địa chỉ IP **Tailscale Mesh VPN** (ví dụ: `100.85.12.34:9876`) và **Mật khẩu cố định**.
3. **Kết nối lần đầu**:
   - Trên máy điều khiển, nhập `100.85.12.34:9876` và mật khẩu của máy đích, nhấn **Kết nối & Điều khiển ngay**.
4. **Kết nối các lần sau (1-Chạm)**:
   - Máy đích đã được lưu vào danh sách **Thiết bị đã lưu (Kết nối 1-Chạm)** kèm trạng thái `● Online`. Bạn chỉ cần bấm **⚡ Kết nối ngay** để vào thẳng màn hình từ xa.

---

## 🍎 Lưu ý quyền hệ thống trên macOS

Khi chạy trên macOS, để cho phép điều khiển chuột/bàn phím và quay màn hình, hãy vào:
- **System Settings → Privacy & Security → Accessibility**: Bật quyền cho SwiftDesk / Electron.
- **System Settings → Privacy & Security → Screen Recording**: Bật quyền cho SwiftDesk / Electron.
*(Trong giao diện ứng dụng trên macOS cũng có nút **Kiểm tra & Cấp quyền** để mở nhanh cửa sổ cấp quyền).*
