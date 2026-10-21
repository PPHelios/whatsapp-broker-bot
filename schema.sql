-- schema.sql
-- Run once in Supabase / PostgreSQL 14+
-- Make sure a public storage bucket named "listing-images" exists in Supabase.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Pure Immutable Arabic Normalization Function (Enables GIN Trigram Search)
-- ---------------------------------------------------------------------------
create or replace function normalize_arabic(t text) returns text language sql immutable as $$
  select regexp_replace(
    regexp_replace(
      translate(
        lower(coalesce(t, '')),
        'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
        'اااايھووي01234567890123456789'
      ),
      '[\u064B-\u065F\u0670\u0640]', '', 'g'
    ),
    '[^a-z0-9\u0600-\u06FF\s-]', ' ', 'g'
  );
$$;

-- ---------------------------------------------------------------------------
-- 1. Agencies (Tenants)
-- ---------------------------------------------------------------------------
create table if not exists agencies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  logo_url        text,
  primary_color   text not null default '#0B132B',
  secondary_color text not null default '#D4AF37',
  logo_bg         text not null default '#FFFFFF',
  flyer_theme     text not null default 'dark' check (flyer_theme in ('dark', 'light')),
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Brokers (Agents)
-- ---------------------------------------------------------------------------
create table if not exists brokers (
  id               uuid primary key default gen_random_uuid(),
  agency_id        uuid not null references agencies(id) on delete cascade,
  name             text not null,
  phone            text not null,
  phone_normalized text not null unique,
  contact_phone    text,
  role             text not null default 'agent' check (role in ('agent', 'broker', 'admin', 'owner', 'manager')),
  is_active        boolean not null default true,
  preferred_lang   text not null default 'ar' check (preferred_lang in ('ar', 'en')),
  last_active_at   timestamptz default now(),
  created_at       timestamptz not null default now()
);
create index if not exists brokers_agency_idx on brokers(agency_id);
create index if not exists brokers_phone_idx on brokers(phone_normalized);

-- ---------------------------------------------------------------------------
-- 3. Listings
-- ---------------------------------------------------------------------------
create table if not exists listings (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references agencies(id) on delete cascade,
  broker_id         uuid references brokers(id) on delete set null,
  code              text not null,
  title             text,
  property_type     text,
  listing_type      text not null default 'sale' check (listing_type in ('sale', 'rent')),
  price_value       numeric,
  price_display     text,
  area_value        numeric,
  bedrooms          int,
  location          text,
  compound          text,
  district          text,
  city              text,
  location_keywords text[] not null default '{}',
  details           jsonb not null default '{}'::jsonb,
  flyer_cache       jsonb not null default '{}'::jsonb,
  status            text not null default 'active' check (status in ('active', 'sold', 'archived', 'draft')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Generated searchable text column indexed via trigrams
  search_text_normalized text generated always as (
    normalize_arabic(
      coalesce(title, '') || ' ' ||
      coalesce(location, '') || ' ' ||
      coalesce(compound, '') || ' ' ||
      coalesce(district, '') || ' ' ||
      coalesce(city, '') || ' ' ||
      array_to_string(location_keywords, ' ') || ' ' ||
      coalesce(details::text, '')
    )
  ) stored,

  constraint listings_agency_code_unique unique (agency_id, code)
);

create index if not exists listings_agency_status_idx on listings(agency_id, status);
create index if not exists listings_search_trgm_idx on listings using gin (search_text_normalized gin_trgm_ops);
create index if not exists listings_agency_code_lookup_idx on listings(agency_id, code);

-- ---------------------------------------------------------------------------
-- 4. Listing Images
-- ---------------------------------------------------------------------------
create table if not exists listing_images (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references listings(id) on delete cascade,
  agency_id   uuid not null references agencies(id) on delete cascade,
  url         text not null,
  position    int not null default 0,
  role        text,
  created_at  timestamptz not null default now()
);
create index if not exists listing_images_listing_idx on listing_images(listing_id, position);
create index if not exists listing_images_agency_idx on listing_images(agency_id);

-- ---------------------------------------------------------------------------
-- 5. Persistent Listing Drafts (Multi-turn Ingestion Buffer)
-- ---------------------------------------------------------------------------
create table if not exists listing_drafts (
  broker_id    uuid primary key references brokers(id) on delete cascade,
  agency_id    uuid not null references agencies(id) on delete cascade,
  broker_phone text not null,
  media_ids    text[] not null default '{}',
  voice_ids    text[] not null default '{}',
  texts        text[] not null default '{}',
  custom_code  text,
  updated_at   timestamptz not null default now()
);
create index if not exists listing_drafts_updated_idx on listing_drafts(updated_at);

-- ---------------------------------------------------------------------------
-- 6. Operation Logs (Two-tier Observability & Quota Metering)
-- ---------------------------------------------------------------------------
create table if not exists operation_logs (
  id                 bigserial primary key,
  agency_id          uuid references agencies(id) on delete cascade,
  broker_id          uuid references brokers(id) on delete set null,
  listing_code       text,
  operation_type     text not null,
  status             text not null default 'success',
  error_code         text,
  total_duration_ms  int default 0,
  gemini_ms          int default 0,
  media_download_ms  int default 0,
  image_process_ms   int default 0,
  flyer_render_ms    int default 0,
  storage_upload_ms  int default 0,
  db_ms              int default 0,
  tokens_input       int default 0,
  tokens_output      int default 0,
  model_used         text,
  estimated_cost_usd numeric(10, 6) default 0,
  created_at         timestamptz not null default now()
);
create index if not exists op_logs_agency_daily_idx on operation_logs(agency_id, created_at desc) where tokens_input > 0;
create index if not exists op_logs_broker_daily_idx on operation_logs(broker_id, created_at desc) where tokens_input > 0;

-- ---------------------------------------------------------------------------
-- 7. Durable Webhook Inbound Message Queue & Crash Recovery
-- ---------------------------------------------------------------------------
create table if not exists inbound_messages (
  msg_id      text primary key,
  phone_key   text not null,
  payload     jsonb not null,
  status      text not null default 'new' check (status in ('new', 'batched', 'done', 'failed')),
  attempts    int not null default 0,
  received_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists inbound_recovery_idx on inbound_messages(status, received_at) where status in ('new', 'batched');

-- ---------------------------------------------------------------------------
-- 8. Broker Search State (Pagination Storage)
-- ---------------------------------------------------------------------------
create table if not exists broker_search_state (
  phone_key   text primary key,
  parsed      jsonb not null,
  next_offset int not null default 0,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 9. Processed Batches (Idempotent Save Guard)
-- ---------------------------------------------------------------------------
create table if not exists processed_batches (
  batch_key    text primary key,
  agency_id    uuid not null references agencies(id) on delete cascade,
  listing_code text not null,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Security: Row Level Security (RLS)
-- ---------------------------------------------------------------------------
alter table agencies            enable row level security;
alter table brokers             enable row level security;
alter table listings            enable row level security;
alter table listing_images      enable row level security;
alter table listing_drafts      enable row level security;
alter table operation_logs      enable row level security;
alter table inbound_messages    enable row level security;
alter table broker_search_state enable row level security;
alter table processed_batches   enable row level security;