# JLPT 模擬試験 (cá nhân)

Web làm đề thi thử JLPT N2/N1 — **https://jlpt.phonglab.uk** (dự phòng: jlpt-test.trieuphong965.workers.dev). Một Cloudflare Worker duy nhất:
static assets (`public/`) + API (`/api/*`) + audio R2 (`/audio/*`) + cron sinh audio 聴解 bằng ElevenLabs.

```
public/            SPA (index.html + app.js) và đề (exams/*.json)
src/index.js       router: Access JWT → /api, /audio (Range), scheduled()
src/tts.js         đồng bộ đề → hàng đợi D1, gọi ElevenLabs, lưu R2, kiểm credit
src/exam.js        trích audio unit từ đề, hash nội dung
src/access.js      xác thực JWT Cloudflare Access
migrations/        schema D1
tools/validate.py  kiểm tra đề (schema, phân bố đáp án, ước tính credit)
tools/build_corpus.py  cập nhật data/corpus.json (mục đã dùng)
```

## Tài nguyên Cloudflare (đã tạo)
- D1 `jlpt` (`dedc3db2-6c5a-4cae-b781-c4e251b21cc9`), schema đã áp dụng
- R2 `jlpt-audio`

## Thiết lập (một lần, trên dashboard)
1. **Deploy từ GitHub** — Workers & Pages → Create → *Import a repository* → `Jlpt-Test`.
   Build command: để trống · Deploy command: `npx wrangler deploy` · Production branch: `main`.
2. **Cloudflare Access** — Worker `jlpt-test` → Settings → Domains & Routes → `workers.dev` → *Enable Cloudflare Access*
   (hoặc Zero Trust → Access → Applications cho custom domain). Lấy **Application Audience (AUD) tag** và team domain
   (`<team>.cloudflareaccess.com`) điền vào `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` trong `wrangler.jsonc`.
   Chưa điền thì `/api` và `/audio` trả 401 (cố ý).
3. **ElevenLabs** — tạo API key với quyền *Text to Speech* + *User: Read* →
   Worker → Settings → Variables and Secrets → Secret `ELEVENLABS_API_KEY`.
4. **Voice** — gói Free **không gọi được voice của Voice Library qua API**. Dùng voice mặc định, hoặc tạo 3 voice
   tiếng Nhật bằng Voice Design (Free có 3 slot): narrator (N), nam (M), nữ (F). Điền ID vào `VOICES`.
   M2/F2 dùng cho hội thoại 3 người, có thể trỏ trùng voice khác. Đổi voice ⇒ hash đổi ⇒ sinh lại toàn bộ.

## Hàng đợi TTS
- Cron `17 */4 * * *`: đồng bộ đề (chỉ khi file đề đổi) → lấy tối đa `MAX_JOBS_PER_RUN` đoạn `pending` theo thứ tự
  đề → câu → đoạn → trước mỗi đoạn kiểm `remaining − cost ≥ CREDIT_RESERVE`, thiếu thì dừng, lượt sau thử lại.
- `GET /v1/user/subscription` chỉ gọi 1 lần/lượt; sau đó trừ cục bộ theo `ceil(ký tự × 0.5)`.
- 401/429/quota → dừng cả lượt. Lỗi khác → thử lại tối đa 3 lần rồi đánh dấu `error`.
- Khóa nội dung `sha256(model|voice|format|text)` ⇒ câu dẫn dùng chung ("問題1", "1番"…) chỉ sinh 1 lần cho mọi đề.
- Theo dõi: `GET /api/tts/status?live` · Chạy tay: `POST /api/tts/run?n=5`.

## Schema 聴解
Mondai `section: "聴解"`. Segment: `{sp: "N"|"M"|"F"|"M2"|"F2", text}` hoặc `{pause: giây}`.
- `mondai.script`: lời dẫn đầu 問題 · `group.script`: bài nghe dùng chung nhiều câu (統合理解 3番) · `item.script`: bài nghe của câu.
- Câu chỉ có audio: bỏ `opts`, đặt `n` (3 hoặc 4). `q` dạng `"L1-1"`, nhãn hiển thị ở `no` (`"1番"`).
- Câu chưa đủ audio → web hiện script thay thế.

## Kiểm tra trước khi push đề mới
```
python3 tools/validate.py && python3 tools/build_corpus.py
```

## Dev local
`npm i && npx wrangler d1 migrations apply jlpt --local && npx wrangler dev`
(`.dev.vars`: `DEV_NO_AUTH=1` bỏ qua Access — chỉ local, không đặt trên production).
