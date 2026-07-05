-- =========================================================
-- SMOLBIZ — migration v2
-- Run this in Supabase SQL Editor AFTER the original schema.sql.
-- Everything here is additive (safe to run on an existing database).
-- =========================================================

-- ---------- businesses: contact email for collab + settings ----------
alter table businesses add column if not exists contact_email text;

-- ---------- profiles: avatar for admin/worker account ----------
alter table profiles add column if not exists avatar_url text;

-- ---------- products: cost/budget so we can calculate profit ----------
alter table products add column if not exists cost numeric default 0;

-- ---------- transactions: customer name, expense category, computed profit ----------
alter table transactions add column if not exists customer_name text;
alter table transactions add column if not exists category text;
alter table transactions add column if not exists cost_at_sale numeric default 0;

-- ---------- COLLAB EVENTS (admin announces, all other admins can see + contact) ----------
create table if not exists collab_events (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid references businesses(id) on delete cascade,
  title text not null,
  description text,
  event_time timestamptz not null,
  contact_email text,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);
alter table collab_events enable row level security;

-- everyone signed in can see every business's collab announcements (that's the point of the tab)
create policy "collab_events_select" on collab_events for select using (true);
-- only an admin can post/edit/delete their own business's announcements
create policy "collab_events_insert" on collab_events for insert with check (business_id = my_business_id() and my_role() = 'admin');
create policy "collab_events_update" on collab_events for update using (business_id = my_business_id() and my_role() = 'admin');
create policy "collab_events_delete" on collab_events for delete using (business_id = my_business_id() and my_role() = 'admin');

-- =========================================================
-- Done. Re-run scripts/generate-config.js only if you change env vars —
-- this file does not touch config.js.
-- =========================================================
