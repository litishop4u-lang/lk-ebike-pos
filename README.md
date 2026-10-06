# POS Xe đạp điện — Cloudflare Pages + Workers + D1

## 1. Backend (Worker + D1)
```bash
cd worker
npx wrangler d1 create ebike-pos            # copy database_id vào wrangler.toml
npx wrangler d1 execute ebike-pos --remote --file=../schema.sql
npx wrangler dev                            # dev local (http://localhost:8787)
npx wrangler deploy                         # deploy
```
Dev local: thêm `--local` khi chạy `d1 execute` để tạo DB cục bộ.

## 2. Frontend (Pages)
```bash
cd web
cp .env.example .env     # đặt VITE_API_URL = URL Worker đã deploy
npm install && npm run dev
npm run build
npx wrangler pages deploy dist --project-name ebike-pos-web
```
Sau khi có domain Pages, đặt `ALLOWED_ORIGIN` trong `wrangler.toml` thành domain đó.
