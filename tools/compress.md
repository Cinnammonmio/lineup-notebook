# ย่อรูป / คลิปก่อน commit

ต้องมี [ffmpeg](https://ffmpeg.org/download.html) (Windows: `winget install Gyan.FFmpeg`)

| ชนิด | เป้าหมาย |
|---|---|
| รูป | WebP กว้าง 1280px ≤ 200 KB |
| คลิป | MP4 H.264 720p 30fps ไม่มีเสียง 5–10 วินาที ≤ 3 MB |

## รูป

```bash
ffmpeg -i in.png -vf scale=1280:-2 -quality 75 out.webp
```

ถ้ายังเกิน 200 KB ลด `-quality` เหลือ 65

## คลิป

```bash
ffmpeg -i in.mp4 -vf scale=-2:720,fps=30 -an -c:v libx264 -crf 28 -preset slow -movflags +faststart out.mp4
```

- ตัดเฉพาะช่วง: เพิ่ม `-ss 00:00:03 -t 8` หน้า `-i` (เริ่มวินาทีที่ 3 ยาว 8 วินาที)
- ถ้ายังเกิน 3 MB เพิ่ม `-crf` เป็น 30–32
- `-movflags +faststart` ทำให้เล่นบนมือถือได้ทันทีโดยไม่ต้องรอโหลดทั้งไฟล์

## ทำทีเดียวทั้งโฟลเดอร์ (PowerShell)

```powershell
Get-ChildItem *.png | ForEach-Object { ffmpeg -y -i $_.FullName -vf scale=1280:-2 -quality 75 ($_.BaseName + ".webp") }
```
