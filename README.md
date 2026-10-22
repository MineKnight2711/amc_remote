# SwiftDesk — Remote Desktop 60FPS Qua Mã ID & IP (Windows & macOS)

Ứng dụng điều khiển máy tính từ xa 2 chiều tốc độ cao được xây dựng bằng **Electron + TypeScript + Cloud ID Signaling + WebRTC P2P/TURN Hardware Acceleration** kết hợp với **Native C FFI (`koffi` -> `user32.dll` trên Windows & `CoreGraphics/Quartz` trên macOS)** cho độ trễ thao tác chuột/phím dưới `0.1ms`.

---

## ✨ Tính năng nổi bật

1. **Kết nối xuyên mạng Internet bằng Mã ID 9 số (`XXX-XXX-XXX` — Không cần cài VPN/Tailscale)**:
   - Mỗi máy được cấp một **Mã ID 9 số cố định** (ví dụ: `482-910-375`).
   - Chỉ cần nhập **Mã ID 9 số** + **Mật khẩu** của máy đích là kết nối điều khiển được từ **bất kỳ mạng Internet nào** (khác Wi-Fi, khác thành phố, 4G) mà không cần cài Tailscale hay mở Port Modem.
   - Tích hợp sẵn **WebRTC P2P + STUN/TURN Relay** cùng chế độ **Cloud Frame Stream Fallback** tự động khi gặp tường lửa chặn UDP.
2. **Khởi động tự động cùng Windows & macOS**:
   - Tự động đăng ký vào **Windows Registry (`HKCU\...\Run`)**, **macOS LaunchAgents (`~/Library/LaunchAgents`)** và Login Items của hệ điều hành.
   - Chạy ngầm ở **System Tray (Khay hệ thống / Menu Bar)** ngay khi mở máy, luôn sẵn sàng nhận kết nối 24/7.
3. **Cài đặt mật khẩu & Lưu thiết bị kết nối 1-Chạm**:
   - Khi bạn nhập đúng mật khẩu ở lần kết nối đầu tiên, máy chủ sẽ cấp một **Trusted Device Token** (lưu bảo mật bằng `SHA-256`).
   - Từ lần thứ 2 trở đi, chỉ cần nhấn **⚡ Kết nối ngay** tại mục **Thiết bị đã lưu** mà không cần nhập lại mật khẩu.
   - Tự động kiểm tra trạng thái **Online / Offline** và độ trễ (`ms`) của các máy đã lưu qua Cloud ID và LAN.

---

## 🚀 Cách chạy và cập nhật trên Windows & macOS

### Nếu mới tải lần đầu:
```bash
git clone https://github.com/MineKnight2711/amc_remote.git
cd amc_remote
npm install
npm start
```

### Nếu đã clone trước đó (Cập nhật bản mới nhất):
```bash
git pull origin main
npm install
npm start
```

---

## 🌐 Cách kết nối giữa 2 máy (Windows ↔ macOS)

1. Mở ứng dụng trên cả 2 máy.
2. Ở cột bên trái (**Máy tính của bạn**), xem ô **🌐 MÃ ID KẾT NỐI QUA INTERNET** (dạng `XXX-XXX-XXX`) và **Mật khẩu cố định**.
3. Trên máy điều khiển, nhập **Mã ID 9 số** đó (ví dụ: `482-910-375`) và **Mật khẩu** vào ô **Điều khiển thiết bị khác** → Nhấn **Kết nối & Điều khiển ngay**.
4. Từ lần sau, máy đó sẽ nằm sẵn trong mục **Thiết bị đã lưu (Kết nối 1-Chạm)** — chỉ cần nhấn **⚡ Kết nối ngay** là vào thẳng màn hình từ xa.
