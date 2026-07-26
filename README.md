# openzca-leave-groups — Web UI (nhiều người dùng, đăng nhập bằng QR Zalo)

Giao diện web để chọn và rời nhiều nhóm Zalo cùng lúc, dùng chung được cho nhiều người qua 1 link. **Không có tài khoản/username/password riêng cho web app** — mỗi người chỉ cần quét mã QR để đăng nhập chính tài khoản Zalo của họ, hoàn toàn tách biệt với người khác. Backend gọi CLI [openzca](https://github.com/darkamenosa/openzca) làm nền.

## Cách hoạt động (cách ly giữa mọi người)

- Khi 1 trình duyệt/thiết bị mở link lần đầu, server tự tạo 1 session (cookie) và gán ngầm 1 mã định danh nội bộ ngẫu nhiên — người dùng **không nhìn thấy hay thao tác gì với khái niệm này**.
- Người dùng chỉ thấy và chỉ cần làm 1 việc: bấm **"Quét QR đăng nhập Zalo"**.
- Mọi dữ liệu (nhóm, tag) đều gắn với session cookie của trình duyệt đó — 1 trình duyệt = 1 tài khoản Zalo = cách ly hoàn toàn với trình duyệt khác.
- ⚠️ **Bắt buộc chạy sau HTTPS nếu deploy cho nhiều người qua mạng thật** (không chỉ localhost) — dùng reverse proxy có TLS (Nginx + Certbot, Caddy tự động HTTPS, Cloudflare Tunnel) hoặc nền tảng hosting có sẵn HTTPS (Render, Railway, Fly.io...). Không có HTTPS, session cookie đi qua mạng ở dạng không mã hoá — ai chặn được mạng có thể giả làm phiên của người khác.
- Session dùng bộ nhớ RAM (`MemoryStore`) — đơn giản, phù hợp quy mô nhỏ/nhóm bạn bè. Nếu restart server, mọi người phải quét QR đăng nhập lại; không nên dùng cho quy mô lớn.
- Nếu muốn dùng tài khoản Zalo khác trên cùng 1 trình duyệt (ví dụ máy dùng chung), xoá cookie của trang hoặc dùng chế độ ẩn danh để có phiên mới.

## Cài đặt & chạy local

```bash
# 1. Cài openzca (nếu chưa có) — vẫn cần cho việc gọi API Zalo
npm install -g openzca@latest

# 2. Cài dependency
npm install

# 3. (tuỳ chọn) copy .env.example thành .env và chỉnh lại
cp .env.example .env

# 4. Chạy
node server.js
```

Mở **http://localhost:4545**, bấm "Quét QR đăng nhập Zalo".

## Push lên GitHub

Trong thư mục project:

```bash
git init
git add .
git commit -m "Initial commit: openzca leave-groups web UI"
git branch -M main
git remote add origin https://github.com/<username-cua-ban>/<ten-repo>.git
git push -u origin main
```

(Thay `<username-cua-ban>/<ten-repo>` bằng repo bạn đã tạo trên github.com/new.)

`.gitignore` đã loại `node_modules/`, `.env`, `dist/` nên sẽ không bị đẩy nhầm lên.

## Deploy để nhiều người cùng dùng qua 1 link

Bất kỳ nền tảng chạy được Node.js đều dùng được (Render, Railway, Fly.io, VPS riêng...). Ý chính:

1. Clone/deploy code lên server.
2. `npm install --production`
3. Cài `openzca` global trên chính server đó (`npm install -g openzca@latest`).
4. Đặt biến môi trường:
   - `PORT` — cổng lắng nghe (nhiều nền tảng tự set biến này).
   - `TRUST_PROXY=1` — nếu chạy sau reverse proxy/hosting có HTTPS.
   - `COOKIE_SECURE=1` — bắt buộc nếu chạy sau HTTPS.
5. Đảm bảo có HTTPS phía trước (hầu hết nền tảng PaaS tự cấp; nếu tự dùng VPS, đặt Nginx/Caddy làm reverse proxy).
6. Chạy `node server.js` (hoặc dùng `pm2` để tự khởi động lại khi crash).

Gửi link cho mọi người — mỗi người tự mở link và quét QR Zalo của họ, không cần đăng ký gì cả.

## Tính năng

- **Đăng nhập duy nhất qua QR Zalo**, không có lớp tài khoản web app nào khác. Mỗi trình duyệt tự động có phiên riêng, cách ly hoàn toàn với người khác.
- Chấm trạng thái (xanh/đỏ) kèm tên tài khoản Zalo (`openzca me info`) khi đã đăng nhập.
- **Danh sách nhóm**: tự động tải qua `openzca group list --json`, hiện tên, số thành viên, id, tag.
- **Lọc theo tên** và **lọc theo tag** cùng lúc.
- **Chọn tất cả / Bỏ chọn**, **Shift-click** chọn nhanh nhiều nhóm liên tiếp.
- **Gán tag** riêng theo từng phiên (lưu tại `~/.openzca-leave-groups/tags/<mã-phiên>.json` trên server).
- **Rời hàng loạt** với log tiến trình real-time, **delay ngẫu nhiên** giữa các lần rời để tránh bị Zalo flag spam, và **dry-run** để xem trước.

## Cấu trúc

```
openzca-web/
├── server.js         # Express backend — session tự động, gọi openzca CLI, SSE stream
├── public/
│   └── index.html    # Toàn bộ frontend
├── package.json
├── .env.example
├── .gitignore
└── LICENSE
```

## Lưu ý quan trọng

- `openzca` dùng thư viện Zalo cá nhân không chính thức (`zca-js`), không phải API chính thức của Zalo — có rủi ro vi phạm điều khoản dịch vụ và bị khoá tài khoản nếu thao tác quá nhanh/nhiều. Giữ delay tối thiểu vài giây giữa các lần rời.
- Zalo không có cơ chế "rời nhóm im lặng" — các thành viên còn lại vẫn thấy thông báo hệ thống khi ai đó rời nhóm.
- Server gọi lệnh `openzca` theo tài liệu chính thức (`auth login`, `auth logout`, `auth status`, `me info`, `group list`, `group leave`). Nếu bản CLI bạn cài khác, sửa các hằng số ở đầu `server.js`.
- Đây là công cụ cho nhóm nhỏ/bạn bè tin tưởng nhau — không phải SaaS thương mại.# zalo-tools
