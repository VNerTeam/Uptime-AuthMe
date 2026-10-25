# MC Bot Launcher (Linux / VPS / Render)

Bot Minecraft (mineflayer) có giao diện web. Chạy được trên máy cá nhân, VPS Linux, Docker và Render.

## 1. Chạy trên Linux / máy cá nhân
    npm install
    ./start.sh              # hoặc: npm start
Mở http://localhost:3000. Chạy cục bộ thì không cần mật khẩu, chỉ nghe 127.0.0.1.

## 2. Chạy trên VPS (Ubuntu/Debian)
    sudo apt install -y nodejs npm        # cần Node 20+ (khuyên dùng 22): xem nodesource nếu bản apt cũ
    sudo cp -r mc-bot-launcher /opt/ && cd /opt/mc-bot-launcher && npm install --omit=dev
    # sửa User, WorkingDirectory, APP_PASSWORD trong mc-bot.service
    sudo cp mc-bot.service /etc/systemd/system/
    sudo systemctl daemon-reload && sudo systemctl enable --now mc-bot
Truy cập http://IP-VPS:3000 (mở cổng 3000 ở firewall). Muốn có HTTPS thì đặt Nginx/Caddy phía trước,
nhớ bật chuyển tiếp WebSocket (Upgrade header).

## 3. Triển khai lên Render
1. Đẩy thư mục này lên một repo GitHub (đã có `.gitignore` loại `profiles.json`, `.env`).
2. Render → New → Web Service (hoặc Blueprint, dùng `render.yaml`) → chọn repo.
3. Build Command `npm install`, Start Command `node server.js`, Health Check Path `/health`.
4. Thêm biến môi trường **APP_PASSWORD** (bắt buộc, nếu thiếu server sẽ không chịu chạy).
5. Mở URL `https://ten-app.onrender.com`, đăng nhập, thêm bot.

### Lưu ý quan trọng với Render
- **Gói free tự "ngủ"** sau một thời gian không có truy cập HTTP, khi ngủ thì bot cũng rớt. Cách xử lý: dùng gói trả
  phí, hoặc dùng dịch vụ ping (UptimeRobot, cron-job.org...) gọi `/health` vài phút một lần. Hãy kiểm tra lại
  chính sách và hạn mức giờ chạy hiện hành của Render.
- **Ổ đĩa không giữ dữ liệu** trên gói free: mỗi lần redeploy/restart, `profiles.json` mất. Hai cách:
  - Gói trả phí + Persistent Disk, đặt `DATA_DIR=/var/data` (đồng thời giữ được đăng nhập Microsoft).
  - Gói free: đặt biến `PROFILES_JSON` = nội dung `profiles.json` để nạp lại mỗi lần khởi động.
- Bật tuỳ chọn **"Tự kết nối khi server khởi động lại"** cho từng bot để bot tự vào lại sau khi Render restart.
- Một số server Minecraft chặn IP của datacenter/cloud hoặc giới hạn số kết nối cùng IP.

## Biến môi trường
| Biến | Ý nghĩa |
|---|---|
| `APP_PASSWORD` | Mật khẩu vào web. Bắt buộc khi mở ra Internet |
| `PORT` | Cổng (Render tự đặt) |
| `HOST` | Địa chỉ nghe. Mặc định 127.0.0.1; tự thành 0.0.0.0 khi có `PORT`/`RENDER` |
| `DATA_DIR` | Nơi lưu `profiles.json` và `auth-cache` |
| `PROFILES_JSON` | Nạp sẵn danh sách bot nếu chưa có `profiles.json` |
| `SESSION_SECRET` | (tuỳ chọn) khoá ký cookie đăng nhập |
| `ALLOWED_ORIGINS` | (tuỳ chọn) origin khác được phép nối WebSocket |
| `NO_OPEN` | Đặt `1` để không tự mở trình duyệt |

Đăng xuất: truy cập `/logout`.

## Tính năng
- Nhiều bot cùng lúc, lưu cấu hình vào `profiles.json`
- Offline/crack hoặc Microsoft (mã đăng nhập hiện trong log)
- AuthMe 6.x kiểu hộp thoại và kiểu chat, tự /register, /login
- Gõ chat/lệnh, lệnh tự chạy sau khi vào server, điều khiển W A S D, nhảy, đánh, chuột phải
- Anti-AFK, tự đánh mob, tự chuột phải, tự kết nối lại tăng dần

## Phiên bản Minecraft mới
    npm install mineflayer@latest
    npm update minecraft-data minecraft-protocol

## Bảo mật
Mật khẩu AuthMe lưu dạng chữ thường trong `profiles.json`. Dùng `APP_PASSWORD` dài, và chỉ truy cập qua HTTPS
(Render có sẵn). Đừng chia sẻ `profiles.json` hay `PROFILES_JSON`.
