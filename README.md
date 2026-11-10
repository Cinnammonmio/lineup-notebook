# ARC — Valorant Lineups

เว็บจด lineup Valorant ส่วนตัว เปิดได้ทั้งคอมและมือถือ ไม่มีโฆษณา ไม่ต้องสมัครสมาชิก
เป็นไฟล์ HTML/CSS/JS ล้วน ไม่ต้อง build — รายละเอียดแผนดูที่ [PLAN.md](PLAN.md)

## รันบนเครื่อง

ต้องเปิดผ่านเซิร์ฟเวอร์ (เปิดไฟล์ `index.html` ตรง ๆ แบบ `file://` จะโหลดข้อมูลไม่ได้)

```bash
cd lineup-notebook
python -m http.server 8000
# เปิด http://localhost:8000
```

## เผยแพร่ด้วย GitHub Pages

1. repo → **Settings → Pages**
2. Source: **Deploy from a branch** → branch `main` / `/ (root)` → Save
3. รอ 1–2 นาที เว็บจะอยู่ที่ `https://<user>.github.io/lineup-notebook/`

ทุก path ในเว็บเป็น relative จึงใช้ได้บน URL ย่อยนี้

## เพิ่ม lineup

ดู [docs/adding-lineups.md](docs/adding-lineups.md) และวิธีย่อรูป/คลิปที่ [tools/compress.md](tools/compress.md)

สรุปสั้น ๆ: แก้บนเว็บ (คอม) → ⋯ → ส่งออก lineups.json → แทน `data/lineups.json` → วางรูป/คลิปใน `media/<แมพ>/` → commit + push

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `index.html` | หน้าเดียวของเว็บ |
| `assets/app.js` | โค้ดทั้งหมด |
| `assets/style.css` | ธีมมืด, responsive |
| `data/lineups.json` | ข้อมูล lineup |
| `media/` | รูป/คลิปที่อัดเอง |
| `sw.js`, `manifest.webmanifest` | PWA (ออฟไลน์ + เพิ่มลงหน้าจอโฮม) |

หลังแก้ `assets/` แล้ว deploy ถ้าเว็บยังแสดงของเก่า ให้รีเฟรชอีกครั้ง (service worker อัปเดตเบื้องหลัง) หรือเปลี่ยน `VERSION` ใน `sw.js`

---

ARC เป็นโปรเจกต์ส่วนตัว ไม่ได้รับการรับรองจาก Riot Games และไม่ได้สะท้อนความเห็นของ Riot Games
ภาพแมพ/เอเจนต์ดึงจาก [valorant-api.com](https://valorant-api.com) (API ไม่เป็นทางการ)
