# Users API — curl cheat sheet

API จำลอง (in-memory, ไม่มี DB) สำหรับจัดการลูกค้าใน smart store demo — ยิงแล้วเห็นผลในร้าน 3D ทันทีผ่าน SSE

- Prefix: `http://localhost:3004/users`
- ข้อมูลหายเมื่อ restart process — boot roster ถูก fetch ใหม่จาก external `${ATK_STORE_API_URL}/animation-api/users` (เก็บเฉพาะคนที่ `visit_status` ไม่ใช่ null, map `exited`→`outside`, `inside`→`inside`)
- schema ของ user: `{ "id": number, "name": string, "gender": "male" | "female", "status": "outside" | "waiting" | "inside" | "scanning" | "browsing" | "paying", "shelf_id": number | null, "browse_until": number | null }`
  - `shelf_id` — shelf ที่กำลังมี session อยู่ (ตอน `scanning`/`browsing`), นอกนั้น null
  - `browse_until` — epoch ms ที่ browse session จะถูกปิดอัตโนมัติ (มีค่าเฉพาะตอน `browsing`)

## Lifecycle

API เป็นเจ้าของสถานะลูกค้า — sim จะไม่พาคนจาก roster เดินออกเอง (มีแต่ walk-in ที่ generate ที่หมุนเวียนเอง) ดังนั้น `status` เชื่อถือได้เสมอ เรียกผิดจังหวะได้ **409**

```
outside --enter--> waiting --verify pass--> inside --leave--> paying --pay pass--> outside
                     '--verify fail--> outside                    '--pay fail--> paying (retry)
```

### Shelf sub-machine (ภายใน `inside`)

ลูกค้าที่อยู่ `inside` สั่งให้เดินไปเปิด shelf ได้ — state machine ระดับ shelf:

```
inside   --walkToShelf {shelfId}-->  scanning   (เดินไปยืนหน้า shelf รอ verdict)
scanning --scanQR fail----------->  scanning   (ป้าย FAILED เหนือหัว ประตูไม่เปิด รอสแกนใหม่)
scanning --scanQR pass----------->  browsing   (ป้าย PASS เหนือหัว ประตู shelf เปิด, timer 30 วิเริ่ม)
scanning --walkAway-------------->  inside     (เลิกรอ เดินกลับ loop)
browsing --inspectItem keep|return-> browsing  (หยิบ 1 ชิ้น: เก็บไว้จ่ายตอนออก หรือวางคืนชั้น)
browsing --(อัตโนมัติ ครบ 30 วิ)--->  inside     (server ปิด session เอง → SSE event `shelfClose`)
```

- **timer 30 วินาทีเป็นของ API** — เริ่มนับตอน `scanQR pass`, ครบแล้ว status เปลี่ยนกลับ `inside` เองและ broadcast `shelfClose` (ถ้าตอนนั้นของค้างมือ = ถือว่าเอาไปด้วย ไปจ่ายตอนออกร้าน) — ไม่มี action `shelfClose` ใน API
- `leave` มีอำนาจสูงสุด: สั่งได้จาก `inside` / `scanning` / `browsing` — ทิ้ง shelf session ทันทีแล้วเดินไปประตูออก
- ตัวละคร ambient (walk-in ที่ไม่อยู่ใน roster) วน machine เดียวกันเองอัตโนมัติ — action พวกนี้ใช้กับ user ใน roster เท่านั้น

transition ทั้งหมดยิงผ่าน endpoint เดียว: `POST /users/:id/status` body `{ action, payload? }` (ดูหัวข้อ status ด้านล่าง)

POST /users (สร้างใหม่) = ไปต่อคิวที่ scanner หน้าประตู → เริ่มที่ `waiting` (เหมือน `enter` รอ verify verdict ไม่ได้เดินเข้าตรง ๆ)

## ดูรายชื่อลูกค้า

```bash
curl http://localhost:3004/users
```

```bash
# รายคน (id ไม่มี → 404)
curl http://localhost:3004/users/1
```

## เพิ่มลูกค้า (POST)

คนใหม่จะเดิน scan เข้าร้านทันที — ถ้าร้านเต็ม (8 คน) จะรอคิวหน้าประตูจนมีที่ว่าง (API ตอบ 201 เสมอ)

```bash
curl -X POST http://localhost:3004/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"อนันดา มีสุข","gender":"female"}'
```

- `name`: string ห้ามว่าง (required)
- `gender`: `male` | `female` (required — กำหนดโมเดล 3D)
- `id` server รันให้เอง

## แก้ไขลูกค้า (PATCH)

ทุก field เป็น optional — เปลี่ยนชื่อ: การ์ด/รายชื่อ CUSTOMERS อัปเดตสด, เปลี่ยนเพศ: ตัวละครเกิดใหม่ตรงตำแหน่งเดิมด้วยโมเดลเพศใหม่

```bash
curl -X PATCH http://localhost:3004/users/6 \
  -H 'Content-Type: application/json' \
  -d '{"name":"ชื่อใหม่"}'
```

```bash
# เปลี่ยนเพศ (respawn ร่างใหม่คาที่)
curl -X PATCH http://localhost:3004/users/6 \
  -H 'Content-Type: application/json' \
  -d '{"gender":"male"}'
```

## ลบลูกค้า (DELETE)

ตัวคนจะค่อย ๆ fade หายไปตรงที่ยืนอยู่ (~1.2 วินาที) — id ที่ไม่มีตอบ 404

```bash
curl -X DELETE http://localhost:3004/users/6
```

## เปลี่ยน status (POST /users/:id/status)

endpoint เดียวคุมทุก transition (8 action) — body เป็น discriminated union บน `action`
- `enter` / `leave` / `walkAway` — ไม่มี payload
- `verify` / `pay` / `scanQR` — ต้องมี `payload: { result: "pass" | "fail" }`
- `walkToShelf` — ต้องมี `payload: { shelfId: number }`
- `inspectItem` — ต้องมี `payload: { result: "keep" | "return" }`

ทุก action ตอบกลับ **user entity เต็ม** เรียกผิดจังหวะ → 409, id ไม่มี → 404, action/payload ผิดคู่ (เช่น verify ไม่ส่ง result) → 422 ตั้งแต่ validation

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

verdict สำหรับคนที่ยืนรอหน้า shelf:

- `pass` — ป้าย PASS เขียวเด้งเหนือหัว ประตูกระจก shelf เปิดตรงหน้า → `browsing` และ **timer 30 วิเริ่มนับ** (`browse_until` โผล่บน entity)
- `fail` — ป้าย FAILED แดงเด้งเหนือหัว ประตูไม่เปิด ยืนรอสแกนใหม่ที่เดิม (ยัง `scanning`)

```bash
curl -X POST http://localhost:3004/users/4/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"scanQR","payload":{"result":"pass"}}'
```

### inspectItem — `browsing` → `browsing`

หยิบของ 1 ชิ้นจากชั้น (1 request = 1 cycle จบในตัว):

- `keep` — เก็บไว้ (นับเป็นของที่เอาไปจ่ายตอนออกร้าน — "Items picked" บน card ขยับ)
- `return` — ดูแล้ววางคืนชั้น

ยิงได้หลายครั้งจนกว่า session จะหมดเวลา — ไม่สั่งอะไรเลยลูกค้าก็ยืนเฉย ๆ จนประตูปิดเอง

```bash
curl -X POST http://localhost:3004/users/4/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"inspectItem","payload":{"result":"keep"}}'
```

### walkAway — `scanning` → `inside`

เลิกรอ verdict เดินกลับไปเดิน loop ต่อ (ใช้ได้เฉพาะตอน `scanning` — session ที่เปิดแล้ว (`browsing`) ปิดได้ทางเดียวคือรอ timer หรือสั่ง `leave`)

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

```bash
curl -X POST http://localhost:3004/users/4/status \
  -H 'Content-Type: application/json' \
  -d '{"action":"pay","payload":{"result":"fail"}}'
```

## ฟัง event สด (SSE)

stream เดียวกับที่ dashboard ใช้ — event: `added` / `updated` / `removed` / `leave` / `enter` / `verify` / `pay` / `walkToShelf` / `scanQR` / `inspectItem` / `walkAway` / `shelfClose` (มี `ping` ทุก ~8 วิเป็น keepalive) — event เหล่านี้ไม่ได้ยุบตาม HTTP route: service ยังยิงแยกต่อ transition เหมือนเดิม

- `walkToShelf` → `{ id, shelfId }`
- `scanQR` → `{ id, result }` / `inspectItem` → `{ id, result }`
- `walkAway` → `{ id }`
- `shelfClose` → `{ id }` — ยิงเองจาก server ตอน timer 30 วิครบ (ไม่มี HTTP action คู่กัน)

```bash
curl -N http://localhost:3004/users/events
```

ตัวอย่าง output:

```
event: hello
data: {"connected":true}

event: added
data: {"id":6,"name":"อนันดา มีสุข","gender":"female"}

event: removed
data: {"id":6}
```

## หมายเหตุ: ชื่อไทยบน Windows

PowerShell/cmd ส่งภาษาไทยใน `-d` แล้ว encoding เพี้ยน — ให้เขียน body ลงไฟล์ UTF-8 แล้วส่งด้วย `--data-binary` แทน:

```bash
# body.json (บันทึกเป็น UTF-8): {"name":"อนันดา มีสุข","gender":"female"}
curl -X POST http://localhost:3004/users \
  -H 'Content-Type: application/json' \
  --data-binary @body.json
```
