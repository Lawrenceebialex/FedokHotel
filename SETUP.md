# Fedok 144 — Your setup checklist (Cloudflare D1 + R2 + Pages)

Repo: https://github.com/Lawrenceebialex/FedokHotel  
Live: https://fedokhotel.pages.dev

---

## 1. Cloudflare resource names

| Resource | Name to create | Purpose |
|----------|----------------|---------|
| **D1 database** | `fedok144-db` | Bookings, rooms, staff |
| **R2 bucket** | `fedok144-media` | Logo, room photos, receipts |
| **Worker** | `fedok144-api` | Booking + desk API |

Bindings in Worker:
- D1: `DB` → `fedok144-db`
- R2: `MEDIA` → `fedok144-media`

---

## 2. Create D1 and load schema

1. Dashboard → Workers & Pages → D1 → Create **`fedok144-db`**
2. Console → paste entire **`schema.sql`** from this repo → Run
3. Check: `SELECT * FROM room_types;`

Or Wrangler:
```bash
npm i -g wrangler
wrangler login
wrangler d1 create fedok144-db
wrangler d1 execute fedok144-db --file=./schema.sql
```

---

## 3. Create R2

1. R2 → Create bucket **`fedok144-media`**
2. Upload logo as `logo.png` (TasteWP logo URL will die — save it now from the current header src)
3. Optional: public access / custom domain for media

---

## 4. Worker API endpoints

| Method | Path | Use |
|--------|------|-----|
| POST | `/api/bookings` | Online + walk-in + phone (same table, different `source`) |
| GET | `/api/bookings/lookup?ref=&phone=` | Guest Portal |
| GET | `/api/bookings?date=` or `?q=` | Front desk list/search |
| PATCH | `/api/bookings/:id` | Confirm, check-in, assign room, cancel |
| GET | `/api/rooms/availability?type=&from=&to=` | Block double booking |

`wrangler.toml`:
```toml
name = "fedok144-api"
main = "src/index.js"
compatibility_date = "2026-11-01"

[[d1_databases]]
binding = "DB"
database_name = "fedok144-db"
database_id = "PASTE_ID"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "fedok144-media"
```

CORS: allow `https://fedokhotel.pages.dev`

---

## 5. Replace Make.com

- New booking → Worker writes D1, optional Telegram/email `fetch`
- Reminders → Worker Cron Trigger (`crons = ["0 7 * * *"]`)
- No spreadsheet; no Make op limits

---

## 6. Pages / links

- `/` homepage (your design + header/footer)
- `/guest-portal.html` concierge / guest lookup
- `/desk/` receptionist (protect with Cloudflare Access)
- `/book.html` online form
- `/rooms/*` room pages

---

## 7. Your order of work

1. D1 `fedok144-db` + run schema.sql  
2. R2 `fedok144-media` + upload logo  
3. Fix logo URL in index header to R2  
4. Worker `fedok144-api` + routes above  
5. Point book / guest-portal / desk forms at Worker URL  
6. Cloudflare Access on `/desk/*`  
7. Optional cron + WhatsApp notify  

When Worker URL is live, send it and the forms can be wired in one pass.

## 8. Additionals later

- PDF receipts in R2  
- Occupancy calendar for desk  
- Weekly `wrangler d1 export` → R2  
- Move postimg images to R2  
