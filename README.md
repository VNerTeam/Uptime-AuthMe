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
- Tuỳ chọn **Chấp nhận resource pack của server** (Sửa cấu hình, mặc định bật). Tắt thì bot trả lời "từ chối"; nếu server bắt buộc pack và kick, log sẽ báo và bot không tự vào lại. Bật thì bot báo "đã tải xong" mà không thật sự tải gói về (tiết kiệm RAM/mạng)
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
- Bot không dò đường: chỉ chạy thẳng tới mục tiêu, tự nhảy bậc và tự thoát kẹt cục bộ (xem mục Di chuyển), nên không đi vòng được địa hình phức tạp.
- Crystal PvP chỉ dùng được khi quanh đối thủ đã có obsidian/bedrock (hoặc bật tự đặt obsidian). Số liệu sát thương chỉ là ước lượng.
- Nhiều server cấm bot/PvP tự động và có anti-cheat có thể ban IP hoặc tài khoản. Chỉ dùng nơi được phép.

## Di chuyển, knockback, thoát kẹt (nút "🧭 Di chuyển")
- **Knockback:** mineflayer vẫn nhận cú đẩy từ server như bình thường. Lỗi "bot không bị đẩy" thường do chính phím điều khiển của bot (PvP luôn giữ đi tới + chạy nhanh nên kéo bot quay lại ngay). Bản này nhả các phím đó 350ms sau mỗi cú đẩy hoặc vụ nổ, và bù tick vật lý khi máy yếu (`maxCatchupTicks`). Bật "Ghi log mỗi lần nhận knockback": nếu bị đánh mà không có dòng `Knockback` nào thì server không gửi cú đẩy cho bot (plugin hoặc anti-cheat), phía bot không sửa được.
- **Tự nhảy:** gặp bậc cao 1 block (có chỗ trống phía trên) thì tự nhảy, cả khi đi thường lẫn khi đánh nhau. Slab/bậc thấp tự bước, tường cao hơn thì không nhảy.
- **Thoát kẹt:** chỉ chạy khi bot đang nhấn đi tới mà đứng yên và có vật cản ngay trước mặt (nên không bị kích hoạt oan khi chưa đăng nhập AuthMe hay bị plugin giữ chân). Thứ tự:
  1. Nhảy và đặt block ngay dưới chân (cần cobblestone, dirt, netherrack... trong túi), lặp tối đa 6 lần để trụ qua tường cao, rồi đi tiếp.
  2. Không đặt được block (hết block, trần thấp) mà còn kẽ hở: cầm ender pearl ném qua kẽ hở. Bot mô phỏng quỹ đạo pearl, chỉ ném khi điểm rơi nằm phía trước vật cản và an toàn (không dung nham, không rơi quá 5 block).
  3. Kín hết (hoặc không có pearl): cầm cúp tốt nhất đào 2 block (ngang chân và ngang đầu) phía trước rồi đi tiếp. Không đào rương, thùng, shulker, lò, spawner, và không đào khi có dung nham gần đó.
- Tất cả có công tắc riêng. Bước đặt block và đào sẽ thay đổi thế giới, hãy tắt ở nơi có luật cấm.

## Lệnh khi hồi sinh
Trong "Sửa cấu hình" có ô **Lệnh chạy mỗi khi vừa hồi sinh** (mỗi dòng một lệnh, cách nhau 1.5s) và số giây chờ. Chỉ chạy sau khi bot chết rồi hồi sinh, không chạy khi đổi chiều không gian.

## Phiên bản Minecraft mới
    npm install mineflayer@latest
    npm update minecraft-data minecraft-protocol

## Bảo mật
Mật khẩu AuthMe lưu dạng chữ thường trong `profiles.json`. Dùng `APP_PASSWORD` dài, và chỉ truy cập qua HTTPS
(Render có sẵn). Đừng chia sẻ `profiles.json` hay `PROFILES_JSON`.
