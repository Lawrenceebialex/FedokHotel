# Fedokhotel

Clean, modern hotel website + booking system built for **Cloudflare**.

- **Frontend**: Cloudflare Pages (static HTML + shared CSS)
- **Database**: Cloudflare D1
- **Images**: Cloudflare R2 (later) — currently using Postimg links
- **API**: Cloudflare Workers (to be implemented)

No WordPress. No Elementor. No third-party booking plugin.

## Design

Exact visual language preserved from the original:

- Background `#F8F5F0`
- Gold accent `#C9A962`
- Fonts: Playfair Display + Inter
- Same gallery styles, highlight cards, and pricing badges

## Project Structure

```
/
├── index.html              # Rooms overview
├── book.html               # Booking form
├── css/main.css            # Shared design system
├── js/booking.js           # Form logic
├── rooms/
│   ├── standard.html
│   ├── deluxe.html
│   └── executive.html
├── schema.sql              # D1 schema + seed data
└── README.md
```

## Room Types

| Slug       | Name             | Price (NGN/night) |
|------------|------------------|-------------------|
| standard   | Standard Room    | 35,000            |
| deluxe     | Deluxe Room      | 55,000            |
| executive  | Executive Suite  | 85,000            |

## Next Steps

1. Deploy frontend to Cloudflare Pages
2. Create D1 database and run `schema.sql`
3. Build a Worker at `/api/bookings` that:
   - Accepts the form payload
   - Checks availability
   - Inserts into `bookings`
   - Returns a confirmation token
4. Move images from Postimg → R2
5. Replace Make.com automations with Worker + optional n8n / email notifications

## Local Preview

Just open the HTML files or serve the folder:

```bash
npx serve .
```

## Cloudflare Setup (quick)

```bash
# Create D1
wrangler d1 create fedokhotel

# Apply schema
wrangler d1 execute fedokhotel --file=./schema.sql

# Deploy Pages (after connecting the GitHub repo)
```

---

Original design extracted from the WordPress dump and cleaned of all Elementor / WP Code residue.
