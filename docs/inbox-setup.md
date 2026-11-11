# ตั้งค่ากล่องรับ lineup จากเพื่อน (Supabase, ฟรี)

เพื่อนกด **📤 ส่ง lineup ให้เจ้าของ** ในเว็บ → lineup + รูปเข้ากล่องรับทันที (เพื่อนไม่ต้องสมัครอะไร)
เจ้าของเห็นป้าย **📥 รอตรวจ N** → ตรวจ → เพิ่มเข้าสมุด (ขึ้น GitHub ด้วย token ของเจ้าของ)

- เพื่อน **ส่งได้อย่างเดียว** อ่าน / ลบของในกล่องไม่ได้ และแตะ GitHub ไม่ได้
- อ่าน / ลบกล่องได้เฉพาะคนที่มี **รหัสผ่านเจ้าของ** (เก็บในเครื่องเจ้าของเท่านั้น)
- ใครมีลิงก์เว็บก็ส่งได้ แต่จะไม่ขึ้นเว็บจนกว่าเจ้าของกดรับ

## 1. สร้าง project

1. สมัคร / ล็อกอิน https://supabase.com → **New project** (เลือก region ใกล้ เช่น Singapore)
2. ตั้งรหัสผ่านฐานข้อมูล (เก็บไว้ ไม่ต้องใส่ในเว็บ) → รอสร้างเสร็จ

## 2. รัน SQL

เมนูซ้าย **SQL Editor** → **New query** → วางทั้งหมดด้านล่าง
**แก้ `เปลี่ยนเป็นรหัสของคุณ`** เป็นรหัสผ่านเจ้าของที่ต้องการ → **Run**

```sql
-- ARC inbox: friends can send, only the owner (with the passphrase) can read / delete
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.arc_inbox (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  sender text not null check (char_length(sender) between 1 and 30),
  payload jsonb not null check (octet_length(payload::text) < 6000000)
);
alter table public.arc_inbox enable row level security;
drop policy if exists "anyone can send" on public.arc_inbox;
create policy "anyone can send" on public.arc_inbox for insert to anon with check (true);
revoke select, update, delete on public.arc_inbox from anon, authenticated;
grant insert on public.arc_inbox to anon;

create table if not exists public.arc_owner (
  id int primary key default 1 check (id = 1),
  pass_hash text not null
);
alter table public.arc_owner enable row level security;
revoke all on public.arc_owner from anon, authenticated;

-- ★ เปลี่ยนรหัสผ่านเจ้าของตรงนี้ (รันซ้ำเพื่อเปลี่ยนรหัสได้)
insert into public.arc_owner (id, pass_hash)
values (1, extensions.crypt('เปลี่ยนเป็นรหัสของคุณ', extensions.gen_salt('bf')))
on conflict (id) do update set pass_hash = excluded.pass_hash;

create or replace function public.arc_is_owner(pass text) returns boolean
language sql security definer set search_path = public, extensions as $$
  select exists (select 1 from public.arc_owner o where o.pass_hash = extensions.crypt(pass, o.pass_hash));
$$;

create or replace function public.arc_inbox_count(pass text) returns int
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.arc_is_owner(pass) then raise exception 'wrong passphrase'; end if;
  return (select count(*) from public.arc_inbox);
end $$;

create or replace function public.arc_inbox_list(pass text) returns setof public.arc_inbox
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.arc_is_owner(pass) then raise exception 'wrong passphrase'; end if;
  return query select * from public.arc_inbox order by id;
end $$;

create or replace function public.arc_inbox_delete(pass text, ids bigint[]) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not public.arc_is_owner(pass) then raise exception 'wrong passphrase'; end if;
  delete from public.arc_inbox where id = any(ids);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.arc_is_owner(text) from public, anon, authenticated;
grant execute on function public.arc_inbox_count(text), public.arc_inbox_list(text), public.arc_inbox_delete(text, bigint[]) to anon;
```

ควรขึ้น **Success. No rows returned**

## 3. ใส่ค่าในเว็บ (เครื่องเจ้าของที่ตั้ง token GitHub แล้ว)

1. Supabase: **Project Settings → API** (หรือ Data API) → คัดลอก
   - **Project URL** เช่น `https://abcd1234.supabase.co`
   - **anon public** key (ขึ้นต้น `eyJ…`) — ใช้ตัว anon เท่านั้น **ห้ามใช้ service_role**
2. เว็บ ARC: **⋯ → ตั้งค่ากล่องรับ (เจ้าของ)** → วาง URL, anon key, รหัสผ่านเจ้าของ → **ทดสอบ** (ควรขึ้น ✓) → **บันทึก**
3. เว็บจะขึ้น GitHub ไฟล์ `data/inbox.json` (URL + anon key) ให้เอง → อีก 1–2 นาทีเว็บของเพื่อนจะส่งเข้ากล่องได้

URL และ anon key เปิดเผยได้ (เป็นค่าสาธารณะ สิทธิ์ถูกจำกัดด้วย SQL ข้างบน) · รหัสผ่านเจ้าของไม่ขึ้น GitHub

## ใช้งาน

- **เพื่อน:** เพิ่ม lineup → ⋯ → **📤 ส่ง lineup ให้เจ้าของ** (ครั้งแรกถามชื่อ) · ส่งซ้ำจะส่งเฉพาะอันที่เพิ่ม / แก้ใหม่
- **เจ้าของ:** ป้าย **📥 รอตรวจ N** ด้านบน (หรือ ⋯ → 📥 รับ lineup จากเพื่อน) → ติ๊ก → **เพิ่มที่เลือก**
  - อันที่ติ๊ก: เพิ่มเป็น lineup ใหม่ (ไม่ทับของเดิม) มีป้าย "โดย ชื่อเพื่อน" แล้วขึ้น GitHub
  - อันที่ไม่ติ๊ก: ถูกทิ้งจากกล่องรับ
  - กด ยกเลิก: ของยังอยู่ในกล่อง

## หมายเหตุ

- แพ็กเกจฟรีมีพื้นที่จำกัด และ project ที่ไม่ได้ใช้นาน ๆ อาจถูกพัก (เข้า supabase.com กด Restore) — เช็กเงื่อนไขล่าสุดที่เว็บ Supabase
- ส่งได้ครั้งละไม่เกินประมาณ 6 MB (รูป 1600–2560px ประมาณ 100–500 KB ต่อรูป)
- ถ้ายังไม่ตั้งกล่องรับ ปุ่ม 📤 จะใช้วิธีส่งไฟล์ (แชร์เข้า LINE / Discord) และเจ้าของใช้ ⋯ → 📄 รับจากไฟล์
