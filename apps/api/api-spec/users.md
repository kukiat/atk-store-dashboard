# Users API — curl cheat sheet

API จำลอง (in-memory, ไม่มี DB) สำหรับจัดการลูกค้าใน smart store demo — ยิงแล้วเห็นผลในร้าน 3D ทันทีผ่าน SSE

## Response envelope

ทุก business route (users/shelfs/groups/crowd) ห่อ body ด้วยซองเดียวกัน:

```jsonc
// สำเร็จ — data คือ payload (object / array), error เป็น null
{ "data": { "...": "..." }, "error": null, "success": true }
// พลาด — data เป็น null, error.message คือข้อความ
{ "data": null, "error": { "message": "User is inside, enter needs \"outside\"" }, "success": false }
```

- **HTTP status code ยังมีความหมายเหมือนเดิม** (200/201/404/409/422/502) — `success` เป็นแค่ตัวสะท้อน `res.ok` ให้ client อ่านสะดวก ไม่ได้แทนที่ status code
- `data` รับได้ทั้ง object และ array (`GET /users` = array อยู่ใน `data`)
- **ยกเว้น**: SSE (`GET /users/events`) ไม่ห่อซอง — มี framing ของตัวเอง (`event:` / `data:`); และ `GET /health-check` ก็ไม่ห่อ (liveness probe)
- ฝั่ง web แกะซองที่เดียวใน `apps/web/src/api.js` (`apiFetch`) — คืน `body.data` เมื่อสำเร็จ, throw `error.message` เมื่อพลาด

ตัวอย่าง output ด้านล่างแสดง entity แบบ**ยังไม่ห่อ** เพื่อความกระชับ ของจริงอยู่ใน `data` เสมอ

- Prefix: `http://localhost:3004/users`
- ข้อมูลหายเมื่อ restart process — boot roster ถูก fetch ใหม่จาก external `${ATK_STORE_API_URL}/animation-api/users` (เก็บเฉพาะคนที่ `visit_status` ไม่ใช่ null, map `exited`→`outside`, `inside`→`inside`, ดึง `entered_at` มาด้วย, `id` ของ external ลงที่ `external_id` ส่วน `id` ของเราสร้าง uuid ใหม่ทุกครั้ง) — ถ้า external ล่มตอน boot server จะไม่ขึ้นเลย (ตั้งใจ)
- ล้าง+ดึง roster ใหม่ได้โดยไม่ต้อง restart ผ่าน `POST /users/roster/refresh` (ดูท้ายไฟล์)
- schema ของ user: `{ "id": string, "external_id": number, "name": string, "gender": "male" | "female", "status": "outside" | "waiting" | "inside" | "scanning" | "browsing" | "paying", "shelf_id": string | null, "entered_at": string | null, "updated_at": string }`
  - **id สองตัว อย่าสลับกัน**
    - `id` — uuid ที่ API สร้างเอง **ไม่รับจาก body** ใช้กับ `GET`/`PATCH`/`DELETE /users/:id`
    - `external_id` — id ของ**ระบบภายนอก** (ส่งมาตอน create ผ่าน field `id`) ใช้กับ `POST /users/:externalId/status` **ทางเดียว** ไม่ส่งมา = API gen ให้เองเริ่มที่ `1000000` (ช่วงแยก เพื่อไม่ไปนั่งทับ id จริงของภายนอกที่นับจาก 1) · ซ้ำ = **409**
    - รูปทรงต่างกันชัด (uuid กับเลข) ยิงผิด route จึงเป็น 422/404 ไม่ใช่โดนคนอื่นเงียบ ๆ
  - `shelf_id` — shelf ที่กำลังมี session อยู่ (ตอน `scanning`/`browsing`), นอกนั้น null
  - `updated_at` — ISO 8601 ประทับใหม่ทุกครั้งที่ user เปลี่ยน (create / PATCH / ทุก status action) — dashboard เรียงลิสต์ Exited จากค่านี้ (ใหม่สุดขึ้นบน)
  - `entered_at` — เวลาเริ่มรอบเข้าร้าน (ISO 8601), `null` ตอนอยู่นอกร้าน
    - boot roster เอาค่ามาจาก external ตรง ๆ (เฉพาะคนที่ยังไม่ออกจากร้าน — สถานะ `outside` ถูกล้างเป็น null เพราะเป็นค่าของรอบก่อน)
    - `verify pass` = ประทับเวลาใหม่, `verify fail` / `pay pass` = ล้างเป็น null (`pay fail` ยังอยู่ในร้าน นาฬิกาเดินต่อ)
    - dashboard นับ "In store" จากค่านี้ ไม่ได้นับจากตอน sim spawn ตัวละคร — reload หน้าเว็บแล้วเวลาไม่รีเซ็ต

## Lifecycle

API เป็นเจ้าของสถานะลูกค้า — sim จะไม่พาคนจาก roster เดินออกเอง (มีแต่ walk-in ที่ generate ที่หมุนเวียนเอง) ดังนั้น `status` เชื่อถือได้เสมอ เรียกผิดจังหวะได้ **409**

```
outside --enter--> waiting --verify pass--> inside --leave--> paying --pay pass--> outside
   '----verify------> '--verify fail--> outside     '------pay------^  '--pay fail--> paying (retry)
```

`verify` เรียกจาก `outside` ได้ตรง ๆ (รวบ step `enter` ให้เอง) — ยิงครั้งเดียวพาคนจากนอกร้านเข้าเลย (ดูหัวข้อ verify) และ `pay` เรียกจาก `inside`/`scanning`/`browsing` ได้ตรง ๆ เช่นกัน (รวบ step `leave` ให้เอง) — ยิงครั้งเดียวพาคนออกจากร้าน (ดูหัวข้อ pay)

### Shelf sub-machine (ภายใน `inside`)

ลูกค้าที่อยู่ `inside` สั่งให้เดินไปเปิด shelf ได้ — state machine ระดับ shelf:

```
inside   --walkToShelf {shelfId}-->  scanning   (เดินไปยืนหน้า shelf รอ verdict)
inside   --scanQR {result,sku}--->  scanning/browsing  (รวบ walkToShelf: เดินไปชั้นของ sku แล้วสแกน)
scanning --scanQR fail----------->  scanning   (ป้าย FAILED เหนือหัว ประตูไม่เปิด รอสแกนใหม่)
scanning --scanQR pass----------->  browsing   (ป้าย PASS เหนือหัว ประตู shelf เปิด)
scanning --walkAway-------------->  inside     (เลิกรอ เดินกลับ loop)
browsing --inspectItem keep|return-> browsing  (หยิบ 1 ชิ้น: เก็บไว้จ่ายตอนออก หรือวางคืนชั้น)
browsing --shelfClose------------->  inside     (ดูของเสร็จ ปิดประตู → SSE event `shelfClose`)
```

- **ไม่มี auto-close timer แล้ว** — session `browsing` เปิดค้างจนกว่าจะสั่ง `shelfClose` (หรือ `leave`) เอง (ของค้างมือตอนปิด = ถือว่าเอาไปด้วย ไปจ่ายตอนออกร้าน)
- `leave` มีอำนาจสูงสุด: สั่งได้จาก `inside` / `scanning` / `browsing` — ทิ้ง shelf session ทันทีแล้วเดินไปประตูออก
- ตัวละคร ambient (walk-in ที่ไม่อยู่ใน roster) วน machine เดียวกันเองอัตโนมัติ — action พวกนี้ใช้กับ user ใน roster เท่านั้น

transition ทั้งหมดยิงผ่าน endpoint เดียว: `POST /users/:externalId/status` body `{ action, payload? }` — **ใช้ `external_id` ไม่ใช่ uuid** (ดูหัวข้อ status ด้านล่าง)

POST /users (สร้างใหม่) = **ลงทะเบียนเฉย ๆ ไม่ได้พาเข้าร้าน** → เริ่มที่ `outside` และ**ไม่มีตัวละครในฉาก 3D เลย** จนกว่าจะมี `verify` เข้ามา (ซึ่งรวบ step `enter` ให้เอง) — คนใหม่จะไปกองรออยู่ในลิสต์ Exited ของ dashboard

## ดูรายชื่อลูกค้า

```bash
curl http://localhost:3004/users
```

```bash
# รายคน — ใช้ uuid (id ไม่มี → 404)
curl http://localhost:3004/users/0d37d2ec-3b85-44f7-b2d0-3046121d26a3
```

## เพิ่มลูกค้า (POST)

คนใหม่**ยังไม่เข้าร้าน**: ได้ `status: "outside"` และไม่มีตัวละครในฉาก 3D ต้องยิง `verify` ตามมาถึงจะเดินเข้า (ดูหัวข้อ verify) — API ตอบ 201

```bash
# จากระบบภายนอก: ส่ง id ของตัวเองมาด้วย → ลง external_id
curl -X POST http://localhost:3004/users \
  -H 'Content-Type: application/json' \
  -d '{"id":900,"name":"อนันดา มีสุข","gender":"female"}'

# จาก Backdoor: ไม่ส่ง id → API gen external_id ให้ (1000000, 1000001, …)
curl -X POST http://localhost:3004/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"อนันดา มีสุข","gender":"female"}'
```

- `name`: string ห้ามว่าง (required)
- `gender`: `male` | `female` (required — กำหนดโมเดล 3D)
- `id`: number (optional) — **id ของระบบภายนอก** ลงที่ `external_id` ไม่ใช่ `id` ของเรา · ซ้ำกับคนที่มีอยู่ → **409**
- `id` (uuid) ของเรา server สร้างเองเสมอ ส่งมาก็ไม่รับ

## แก้ไขลูกค้า (PATCH)

ทุก field เป็น optional — เปลี่ยนชื่อ: การ์ด/รายชื่อ CUSTOMERS อัปเดตสด, เปลี่ยนเพศ: ตัวละครเกิดใหม่ตรงตำแหน่งเดิมด้วยโมเดลเพศใหม่

```bash
curl -X PATCH http://localhost:3004/users/0d37d2ec-3b85-44f7-b2d0-3046121d26a3 \
  -H 'Content-Type: application/json' \
  -d '{"name":"ชื่อใหม่"}'
```

```bash
# เปลี่ยนเพศ (respawn ร่างใหม่คาที่)
curl -X PATCH http://localhost:3004/users/0d37d2ec-3b85-44f7-b2d0-3046121d26a3 \
  -H 'Content-Type: application/json' \
  -d '{"gender":"male"}'
```

## ลบลูกค้า (DELETE)

ตัวคนจะค่อย ๆ fade หายไปตรงที่ยืนอยู่ (~1.2 วินาที) — id ที่ไม่มีตอบ 404

```bash
curl -X DELETE http://localhost:3004/users/0d37d2ec-3b85-44f7-b2d0-3046121d26a3
```

ตอบ `{ "data": { "id": "0d37d2ec-…" }, "error": null, "success": true }` — คืนแค่ `id` (uuid) (ไม่มี `deleted: true` แล้ว: HTTP 200 + `success: true` บอกว่าสำเร็จอยู่แล้ว และลบไม่สำเร็จคือ 404 ไม่ใช่ `deleted: false`)

## ล้าง roster แล้วดึงใหม่จาก external (POST /users/roster/refresh)

ดีด store กลับไปเป็นสภาพเหมือนเพิ่ง restart API โดยไม่ต้อง restart — **แทนที่ทั้งก้อน**: ทิ้ง status ของทุกคน (รวมคนที่กำลัง `paying` / เปิดชั้นวางอยู่), ทิ้งคนที่ POST สร้างเองในเครื่อง, gender ที่ PATCH ไว้เด้งกลับไปเป็นค่าที่เดาจากชื่อ ตอบกลับเป็น roster ชุดใหม่ทั้งหมด (เหมือน `GET /users`)

```bash
curl -X POST http://localhost:3004/users/roster/refresh
```

- external ล่ม/ตอบ error → **502** และ **store เดิมไม่กระเทือน** (fetch ให้เสร็จก่อนถึงแตะ store) — ต่างจากตอน boot ที่ตั้งใจให้ server ตาย
- SSE: ยิง **`roster` ตัวเดียว** ที่แบก roster ชุดใหม่ทั้ง array (ไม่ใช่ `removed`/`added` รายคน — ดูหัวข้อ SSE ท้ายไฟล์) dashboard จะ replace ตารางทั้งก้อน และฉาก 3D รื้อ body ของ user ทุกตัวทิ้งแล้วสร้างใหม่ตามสถานะในชุดใหม่ทันที **ไม่ต้อง reload `/v5`**
  - คนที่ `inside` ไปยืนบนพื้น, `waiting` ไปต่อคิวหน้าประตู, `outside`/`paying` ไม่มีตัวในฉาก (เหมือนตอน boot เป๊ะ)
  - ambient crowd (walk-in ที่ไม่อยู่ใน roster) ไม่โดนแตะ — คนละประชากรกัน
  - เป็น replace ทั้งก้อน ไม่ใช่ diff: **ทุกคนได้ uuid ใหม่หมด** แม้ `external_id` จะเป็นคนเดิม (uuid ที่จดไว้ก่อน refresh จะ 404 — ใช้ `external_id` อ้างอิงข้ามการ refresh แทน) และ body ในฉากถูกรื้อสร้างใหม่ทุกตัว (เสียตำแหน่งเดิม)
- ปุ่ม `⤓ Reload from External` บนหน้า `/backdoor` ยิง endpoint นี้ (มี confirm ก่อน)

## เปลี่ยน status (POST /users/:externalId/status)

> ⚠️ **route เดียวในไฟล์นี้ที่ใช้ `external_id` ไม่ใช่ uuid** — ตัวเลขใน path ข้างล่างคือ `external_id` ทั้งหมด ยิง uuid มาที่นี่จะได้ 422 (ไม่ใช่ตัวเลข)

endpoint เดียวคุมทุก transition (9 action) — body เป็น discriminated union บน `action`
- `enter` / `leave` / `walkAway` / `shelfClose` — ไม่มี payload
- `verify` / `pay` — ต้องมี `payload: { result: "pass" | "fail" }`
- `scanQR` — ต้องมี `payload: { result: "pass" | "fail", sku: string }` (sku ชี้ shelf เป้าหมาย 1:1)
- `walkToShelf` — ต้องมี `payload: { shelfId: string }` (device_id ของ shelf)
- `inspectItem` — ต้องมี `payload: { result: "keep" | "return" }`

ทุก action ตอบกลับ **user entity เต็ม** (ห่อใน `data`) เรียกผิดจังหวะ → 409, `external_id` ไม่มี → 404, action/payload ผิดคู่ (เช่น verify ไม่ส่ง result) → 422 ตั้งแต่ validation — error ทั้งหมดอยู่ในรูป `{ data: null, error: { message }, success: false }` พร้อม status code เดิม

### enter — `outside` → `waiting`

ลูกค้าโผล่มานอกร้านแล้วเดินไปต่อคิวที่ scanner หน้าประตูทางเข้า — **ยืนรอเฉย ๆ ไม่ scan เอง** จนกว่าจะสั่ง verify คนที่รอคิวไม่นับรวมในความจุร้าน (8 คน)

```bash
curl -X POST http://localhost:3004/users/2/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"enter"}'
```

### verify — `waiting` → `inside` (pass) / `outside` (fail)

- `pass` — beam กวาดตัว ไฟเขียว ID tag เด้ง แล้วเดินเข้าร้าน
- `fail` — ไฟแดงกะพริบ หันหลังเดินออกไปหายไป (สั่ง checkin ใหม่ได้)

เรียกจาก `outside` ได้ตรง ๆ ด้วย — verify จะรวบ step `enter` ให้เอง (ยิง SSE `enter` ก่อน แล้ว `verify`) ยิงครั้งเดียวได้คนเดินจากนอกร้านเข้า (pass) หรือถูกปฏิเสธหน้าประตู (fail = โผล่ที่คิวแล้วเดินออก, สุทธิ `outside`→`outside`) — ไม่ต้อง `enter` ก่อน (แต่ยัง `enter` แยกได้ถ้าอยากให้ไปยืนรอที่ `waiting` ก่อน)

```bash
curl -X POST http://localhost:3004/users/2/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"verify","payload":{"result":"pass"}}'
```

### walkToShelf — `inside` → `scanning`

สั่งลูกค้าเดินไปยืนหน้า shelf ที่ระบุ แล้ว**ยืนรอเฉย ๆ** จนกว่าจะสั่ง `scanQR` (ไม่ scan เอง — แบบเดียวกับ `enter` ที่รอ verify)

- shelf ไม่มีอยู่ → 404, shelf `online: false` หรือ `type: "checkout"` (ไม่มีประตู) → 409 (เช็คกับ shelfs API — รายการ shelf ดูได้ที่ `GET /shelfs`)
- API ไม่เช็คว่า slot หน้า shelf ว่างหรือไม่ (scene จัดการเอง — mock)

```bash
curl -X POST http://localhost:3004/users/4/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"walkToShelf","payload":{"shelfId":3}}'
```

### scanQR — `scanning` → `browsing` (pass) / ค้างที่ `scanning` (fail)

verdict สำหรับคนที่ยืนรอหน้า shelf — `sku` ใน payload ชี้ shelf เป้าหมาย (1 sku = 1 shelf, resolve ผ่าน shelfs data):

- `pass` — ป้าย PASS เขียวเด้งเหนือหัว ประตูกระจก shelf เปิดตรงหน้า → `browsing` (เปิดค้างจนสั่ง `shelfClose`)
- `fail` — ป้าย FAILED แดงเด้งเหนือหัว ประตูไม่เปิด ยืนรอสแกนใหม่ที่เดิม (ยัง `scanning`)

เรียกจาก `inside` ได้ตรง ๆ ด้วย — scanQR จะรวบ step `walkToShelf` ให้เอง: resolve `sku` → shelf แล้วเดินไปที่ชั้นนั้น (ยิง SSE `walkToShelf` ก่อน แล้ว `scanQR`) ยิงครั้งเดียวได้คนเดินจากกลางร้านไปสแกนเปิดชั้น (pass → `browsing`) หรือค้างหน้าเครื่องอ่าน (fail = สุทธิ `inside`→`scanning`, ไม่ใช่ round trip) — ไม่ต้อง `walkToShelf` ก่อน (แต่ยัง `walkToShelf` แยกได้)

- `sku` ไม่มีในชั้นไหน → **404**, sku's shelf `online:false` / `checkout` → **409**
- เรียกจาก `scanning` (เดินมาด้วย walkToShelf แล้ว) `sku` ต้องชี้ชั้นที่ยืนอยู่ (`shelf_id`) ไม่ตรง → **409**
- รายการ sku ดูได้ที่ `GET /shelfs` (field `sku` ของแต่ละ shelf เช่น `BEV`/`SNK`)

```bash
# one-shot จาก inside: เดินไปชั้นของ SNK แล้วสแกนเปิดเลย
curl -X POST http://localhost:3004/users/4/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"scanQR","payload":{"result":"pass","sku":"SNK"}}'
```

### inspectItem — `browsing` → `browsing`

หยิบของ 1 ชิ้นจากชั้น (1 request = 1 cycle จบในตัว):

- `keep` — เก็บไว้ (นับเป็นของที่เอาไปจ่ายตอนออกร้าน — "Items picked" บน card ขยับ)
- `return` — ดูแล้ววางคืนชั้น

ยิงได้หลายครั้งจนกว่าจะสั่ง `shelfClose` — ไม่สั่งอะไรเลยลูกค้าก็ยืนเฉย ๆ ประตูเปิดค้าง (ไม่ปิดเอง)

```bash
curl -X POST http://localhost:3004/users/4/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"inspectItem","payload":{"result":"keep"}}'
```

### shelfClose — `browsing` → `inside`

ดูของเสร็จ ปิดประตู shelf แล้วกลับไปเดิน loop ต่อ (ใช้ได้เฉพาะตอน `browsing`) — แทนที่ auto-close timer เดิม: session `browsing` **ไม่ปิดเอง** ต้องสั่ง `shelfClose` (หรือ `leave`) ของค้างมือตอนปิด = เอาไปด้วย

```bash
curl -X POST http://localhost:3004/users/4/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"shelfClose"}'
```

### walkAway — `scanning` → `inside`

เลิกรอ verdict เดินกลับไปเดิน loop ต่อ (ใช้ได้เฉพาะตอน `scanning` — session ที่เปิดแล้ว (`browsing`) ปิดด้วย `shelfClose` หรือ `leave`)

```bash
curl -X POST http://localhost:3004/users/4/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"walkAway"}'
```

### leave — `inside` | `scanning` | `browsing` → `paying`

ทิ้งทุกอย่างทันที (รวมถึง shelf session ที่ค้างอยู่ — ของค้างมือถือว่าเอาไปด้วย) แล้วเดินไปที่ประตูทางออก **ยืนรอจ่ายเงินที่ fare-gate** (ยังไม่ออกจากร้าน — ต้องผ่าน pay ก่อน)

```bash
curl -X POST http://localhost:3004/users/4/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"leave"}'
```

### pay — `paying` → `outside` (pass) / ค้างที่ประตู (fail)

face-scan ที่ประตูทางออกสำหรับคนที่รอจ่าย (`paying`):

- `pass` — ใบเสร็จเด้ง เดินออกจากร้าน → `outside`
- `fail` — tag แดง "DECLINED" ค้างอยู่ที่ประตูเพื่อลองใหม่ (ยัง `paying`)

เรียกจาก `inside` / `scanning` / `browsing` ได้ตรง ๆ ด้วย — pay จะรวบ step `leave` ให้เอง (ยิง SSE `leave` ก่อน แล้ว `pay`) ยิงครั้งเดียวได้คนเดินจากพื้นที่ร้านออกไปเลย (pass) หรือไปค้างที่ fare-gate (fail) — ไม่ต้อง `leave` ก่อน (แต่ยัง `leave` แยกได้ถ้าอยากให้ไปยืนรอที่ `paying` ก่อน) ต่างจาก verify fail ตรงที่ **pay fail ไม่ใช่ round trip**: คนถูกพาไปที่ gate แล้ว สุทธิ `inside`→`paying` (ค้างรอรูดใหม่)

```bash
curl -X POST http://localhost:3004/users/4/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"pay","payload":{"result":"fail"}}'
```

## ฟัง event สด (SSE)

stream เดียวกับที่ dashboard ใช้ — event: `added` / `updated` / `removed` / `leave` / `enter` / `verify` / `pay` / `walkToShelf` / `scanQR` / `inspectItem` / `walkAway` / `shelfClose` / `roster` (มี `ping` ทุก ~8 วิเป็น keepalive) — event เหล่านี้ไม่ได้ยุบตาม HTTP route: service ยังยิงแยกต่อ transition เหมือนเดิม

**SSE frame ไม่ห่อ response envelope** — `data:` ของแต่ละ frame คือ payload ดิบ (`{"id":6,...}`) ไม่ใช่ `{ data, error, success }` (event-stream มี framing ของตัวเองอยู่แล้ว)

- `walkToShelf` → `{ id, shelfId }`
- `scanQR` → `{ id, result, sku }` / `inspectItem` → `{ id, result }`
- `walkAway` → `{ id }`
- `shelfClose` → `{ id }` — ยิงตอนสั่ง action `shelfClose` (browsing → inside)
- `roster` → **array ของ user ทั้ง roster** (`[{ id, name, status, ... }, ...]`) — ตัวเดียวที่ `data:` ไม่ใช่ object ของคนเดียว. ยิงจาก `POST /users/roster/refresh` อย่างเดียว แปลว่า "roster ตอนนี้คือชุดนี้เป๊ะ ให้ล้างแล้วสร้างใหม่"

```bash
curl -N http://localhost:3004/users/events
```

ตัวอย่าง output:

```
event: hello
data: {"connected":true}

event: added
data: {"id":"0d37d2ec-…","external_id":900,"name":"อนันดา มีสุข","gender":"female","status":"outside",…}

event: removed
data: {"id":"0d37d2ec-…"}
```

ทุก `id` ใน SSE คือ **uuid** (`User.id`) — `external_id` ติดมาเฉพาะ event ที่แบก user เต็มใบ (`added`/`updated`/`enter`/`roster`) และไม่เคยถูกใช้เป็น key ของ event

## หมายเหตุ: ชื่อไทยบน Windows

PowerShell/cmd ส่งภาษาไทยใน `-d` แล้ว encoding เพี้ยน — ให้เขียน body ลงไฟล์ UTF-8 แล้วส่งด้วย `--data-binary` แทน:

```bash
# body.json (บันทึกเป็น UTF-8): {"name":"อนันดา มีสุข","gender":"female"}
curl -X POST http://localhost:3004/users \
  -H 'Content-Type: application/json' \
  --data-binary @body.json
```
