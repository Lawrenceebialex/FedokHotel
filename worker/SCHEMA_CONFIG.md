# Phase 3 — Hotel configuration (production schema)

## Source of truth

### room_categories
base_price_per_night, is_active, name, slug, …

### rooms
category_id, room_number, operational_status (available|occupied|maintenance|out_of_service), is_active

### hotel_profile
hotel_name, phone, email, address, timezone, currency, check_in_time, check_out_time

**Do not** create `room_types` or `hotel_settings`.
**Do not** run deprecated `003_hotel_config.sql`.

Soft-deactivate categories (`is_active=0`) and rooms; never hard-delete.
Price changes do not rewrite reservation `price_per_night` / `total_amount`.
