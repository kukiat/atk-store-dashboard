# API Spec — atk-store-dashboard

สเปค + curl cheat sheet ของ API (`apps/api` — Elysia บน Bun, port 3004)

- Base URL: `http://localhost:3004`
- Swagger docs (interactive): `http://localhost:3004/swagger`
- Health check: `curl http://localhost:3004/health`

## Response envelope

ทุก business route (users/shelfs/groups/crowd) ตอบด้วยซองเดียวกัน — `{ data, error, success }`:

- สำเร็จ: `{ "data": <payload>, "error": null, "success": true }`
- พลาด: `{ "data": null, "error": { "message": "..." }, "success": false }`

HTTP status code ยังมีความหมายเหมือนเดิม (`success` แค่สะท้อน `res.ok`). **ยกเว้น** SSE (`/*/events`) กับ `/health` ที่ไม่ห่อ. รายละเอียด + ตัวอย่างดูใน [users.md](users.md#response-envelope). ฝั่ง server: `apps/api/src/envelope.ts` (`envelope()` / `ok()` / `envelopeError`). ฝั่ง web: `apps/web/src/api.js` (`apiFetch`).

## วิธีรัน

demo เต็มรูปแบบต้องเปิด 2 process:

```bash
# terminal 1 — API
cd apps/api && bun dev

# terminal 2 — web dashboard
cd apps/web && bun dev
```

## Resources

| Resource | ไฟล์สเปค | Storage | หมายเหตุ |
|---|---|---|---|
| users | [users.md](users.md) | in-memory (mock external API) | ขับ shopper ในร้าน 3D แบบ realtime ผ่าน SSE |
| shelfs | — | Postgres (Drizzle) | CRUD ชั้นวางของระบบจริง |
| groups | — | Postgres (Drizzle) | CRUD กลุ่มชั้นวาง |
