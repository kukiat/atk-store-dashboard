# Users API — curl cheat sheet

API จำลอง (in-memory, ไม่มี DB) สำหรับจัดการลูกค้าใน smart store demo — ยิงแล้วเห็นผลในร้าน 3D ทันทีผ่าน SSE

- Prefix: `http://localhost:3004/users`
- ข้อมูลหายเมื่อ restart process — boot roster ถูก fetch ใหม่จาก external `${ATK_STORE_API_URL}/animation-api/users` (เก็บเฉพาะคนที่ `visit_status` ไม่ใช่ null, map `exited`→`outside`, `inside`→`inside`)
- schema ของ user: `{ "id": number, "name": string, "gender": "male" | "female", "status": "outside" | "waiting" | "inside" | "paying" }`

## Lifecycle

API เป็นเจ้าของสถานะลูกค้า — sim จะไม่พาคนจาก roster เดินออกเอง (มีแต่ walk-in ที่ generate ที่หมุนเวียนเอง) ดังนั้น `status` เชื่อถือได้เสมอ เรียกผิดจังหวะได้ **409**

```
outside --enter--> waiting --verify pass--> inside --leave--> paying --pay pass--> outside
                     '--verify fail--> outside                    '--pay fail--> paying (retry)
```

ทั้ง 4 transition ยิงผ่าน endpoint เดียว: `POST /users/:id/status` body `{ action, payload? }` (ดูหัวข้อ status ด้านล่าง)

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

endpoint เดียวคุมทั้ง 4 transition — body เป็น discriminated union บน `action`
- `enter` / `leave` — ไม่มี payload
- `verify` / `pay` — ต้องมี `payload: { result: "pass" | "fail" }`

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

### leave — `inside` → `paying`

ทิ้งทุกอย่างทันทีแล้วเดินไปที่ประตูทางออก **ยืนรอจ่ายเงินที่ fare-gate** (ยังไม่ออกจากร้าน — ต้องผ่าน pay ก่อน)

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

stream เดียวกับที่ dashboard ใช้ — event: `added` / `updated` / `removed` / `leave` / `enter` / `verify` / `pay` (มี `ping` ทุก ~8 วิเป็น keepalive) — event เหล่านี้ไม่ได้ยุบตาม HTTP route: service ยังยิงแยกต่อ transition เหมือนเดิม

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
