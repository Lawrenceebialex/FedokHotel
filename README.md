# Fedokhotel Website Code Extract

Extracted from the All-in-One WP Migration SQL dump of the Fedokhotel WordPress site.

**Site URL (original):** https://fedokhotel.s6-tastewp.com  
**Admin email:** ebilateilawrence@gmail.com  
**Theme:** Hello Elementor (with custom HTML/CSS)

## What was extracted

### Room Page Templates (standalone HTML)
These recreate the custom-designed room pages that were built with Elementor HTML widgets + custom CSS.

| File | Room | Price (NGN/night) | Notes |
|------|------|-------------------|-------|
| `executive-suite.html` | Executive Suite | ₦85,000 | Horizontal scroll gallery |
| `deluxe-room.html` | Deluxe Room | ₦55,000 | 4-column masonry-style gallery |
| `standard-room.html` | Standard Room | ₦35,000 | Single wide hero image |

Open any of these files directly in a browser to preview the design.

### WP Code Plugin Snippets
- `wpcode-snippets.php` — The two custom code snippets found in the database (one sample message, one that fully disables comments).

### Booking System
The site uses a custom hotel booking plugin with tables prefixed `mhbo_` (Modern Hotel Booking Online / similar):

**Room Types (from `mhbo_room_types`):**
1. **Standard Room** — ₦35,000 base, amenities: wifi, ac, tv, breakfast, pool
2. **Executive Suite** — ₦85,000 base, amenities: wifi, ac, tv, breakfast, pool, complimentary-breakfast, 24-7-room-service, private-lounge-area, dedicated-workspace, king-sized-bed, luxury-ensuite-bathroom
3. **Deluxe Room** — ₦55,000 base, amenities: wifi, ac, tv, queen-bed, 24-7-room-service, king-sized-bed

**Rooms:**
- Standard: Room 101, 102
- Executive: 201, 202
- Deluxe: 401, 402

**Sample Bookings** (in the dump):
- Confirmed booking for Standard Room (13–18 Aug 2026) by Lawrence Ebilatei Alexander
- Two pending bookings for other rooms

The booking frontend is powered by the shortcode `[modern_hotel_booking]` on the "Book Now" page.

### Forms
Fluent Forms plugin was installed with:
- Contact Form Demo
- Subscription Form

### Notes
- The majority of the visual design lives in the Elementor page content (HTML widgets containing the CSS + markup above).
- The WP Code plugin was used mainly for the "disable comments" utility and a sample snippet.
- Images are hosted on postimg.cc (Grok-generated room photos).

You can take the three HTML files and adapt the CSS/markup into your own theme, Elementor templates, or a custom front-end.
