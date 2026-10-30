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
- Auto PvP: kiếm, rìu, end crystal, totem, ăn, giáp (xem mục bên dưới)
- Anti-AFK, tự đánh mob, tự chuột phải, tự kết nối lại tăng dần

## Auto PvP (nút "⚔ PvP" trên mỗi bot, lưu xong có hiệu lực ngay)
Chia theo 6 mục, mỗi mục bật/tắt riêng:
1. **Chung**: bật PvP, đánh mọi người chơi hoặc chỉ người vừa đánh mình, tầm phát hiện/tầm đánh, danh sách tên bỏ qua (bạn bè), né ngang (strafe). Tự bỏ qua người chơi creative/spectator và NPC giả.
2. **Kiếm / Rìu**: tự cầm vũ khí tốt nhất trong túi, chờ hồi chiêu đúng từng loại (kiếm 0.625s, rìu 0.9-1.25s tuỳ chất liệu, server 1.8 thì đánh nhanh), đòn chí mạng (nhảy rồi đánh lúc rơi), tự đổi sang rìu khi đối thủ cầm khiên.
3. **End Crystal**: đặt end_crystal lên obsidian/bedrock gần đối thủ rồi đập nổ. Chỉ chọn vị trí đặt nằm trong tầm đập, tính sát thương tự gánh (ước lượng thô theo khoảng cách và số mảnh giáp), không đặt khi máu thấp. Tuỳ chọn tự đặt obsidian làm đế.
4. **Auto Totem**: luôn giữ Totem of Undying ở tay trái, vỡ cái nào thay cái mới ngay, ghi log mỗi lần vỡ.
5. **Ăn & Giáp**: tự ăn khi đói (không ăn lúc đang đánh nhau), ăn táo vàng khi máu thấp (máu rất thấp thì ưu tiên táo vàng phép), tự mặc giáp tốt nhất.
6. **An toàn**: chạy lui khi máu thấp, tự thoát server khi máu thấp hơn ngưỡng (không tự vào lại).

### Tiết kiệm RAM (gói 512MB)
- PvP tự viết, không dùng pathfinder nên không tốn thêm RAM đáng kể.
- Mặc định mineflayer tải tầm nhìn 12 chunk rất tốn RAM; bản này mặc định **4 chunk** (đổi trong "Sửa cấu hình").
- `NODE_OPTIONS=--max-old-space-size=384` đã được đặt sẵn trong `render.yaml`, `mc-bot.service`, `Dockerfile`, `start.sh`.
- Đo thực tế: launcher + 2 bot trên tầm nhìn 4 chunk khoảng 130MB RSS. Gói 512MB nên chạy khoảng 2-4 bot.

### Giới hạn cần biết
- Bot không dò đường: chỉ chạy thẳng tới mục tiêu và nhảy khi vướng, nên không vượt được địa hình phức tạp.
- Crystal PvP chỉ dùng được khi quanh đối thủ đã có obsidian/bedrock (hoặc bật tự đặt obsidian). Số liệu sát thương chỉ là ước lượng.
- Nhiều server cấm bot/PvP tự động và có anti-cheat có thể ban IP hoặc tài khoản. Chỉ dùng nơi được phép.

## Phiên bản Minecraft mới
    npm install mineflayer@latest
    npm update minecraft-data minecraft-protocol

## Bảo mật
Mật khẩu AuthMe lưu dạng chữ thường trong `profiles.json`. Dùng `APP_PASSWORD` dài, và chỉ truy cập qua HTTPS
(Render có sẵn). Đừng chia sẻ `profiles.json` hay `PROFILES_JSON`.
