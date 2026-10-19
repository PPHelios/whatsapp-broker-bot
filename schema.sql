-- Run once in Supabase: SQL Editor -> paste -> Run. (Postgres 14+ required for bit_count)
-- Also create a PUBLIC storage bucket named "media" (Storage -> New bucket).

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- Auto-increment sequence for automatic code fallback when broker doesn't supply a code
create sequence if not exists listing_code_seq start with 1000;

-- ---------------------------------------------------------------- tenants
create table if not exists agencies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  logo_url      text,                          -- Public CDN URL
  brand_color   text not null default '#0f172a',
  accent_color  text not null default '#38bdf8',
  created_at    timestamptz not null default now()
);

create table if not exists brokers (
  id             uuid primary key default gen_random_uuid(),
  agency_id      uuid not null references agencies(id) on delete cascade,
  phone          text not null unique,         -- WhatsApp number, digits only (e.g., 201001234567)
  name           text not null,
  contact_phone  text,                         -- Displayed on flyers; defaults to phone
  role           text not null default 'broker' check (role in ('broker','admin')),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists brokers_agency_idx on brokers(agency_id);

-- ---------------------------------------------------------------- listings
create table if not exists listings (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null,          -- Scoped alphanumeric code (e.g., "1042", "MV-104", "A12")
  agency_id            uuid not null references agencies(id) on delete cascade,
  broker_id            uuid not null references brokers(id),
  status               text not null default 'draft' check (status in ('draft','active','sold','archived')),
  title                text,
  property_type        text,
  listing_type         text,
  price_value          numeric,
  price_display        text,
  area_value           numeric,
  bedrooms             int,
  location             text,
  features             text[] not null default '{}',
  language             text not null default 'ar',
  lat                  double precision,
  lng                  double precision,
  location_name        text,
  raw_text             text,
  details              jsonb not null default '{}'::jsonb,   -- Full Gemini-extracted payload
  search_text          text not null default '',             -- Normalized text for SQL ILIKE / Trigram search
  flyer_url            text,                                 -- Public URL to the generated brochure
  hero_position        int not null default 0,               -- Index of the hero image chosen by AI

  -- Developer Installment Model
  is_primary_developer boolean not null default false,
  down_payment_value   numeric,
  installment_years    int,
  installment_value    numeric,                              -- Quarterly or monthly check amount
  payment_frequency    text default 'quarterly' check (payment_frequency in ('monthly','quarterly','semi_annual','annual')),
  delivery_date        text,
  maintenance_pct      numeric default 8,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Scope code uniqueness per agency (Agency A and Agency B can both have unit #101)
  constraint listings_agency_code_unique unique (agency_id, code)
);

create index if not exists listings_agency_status_idx on listings(agency_id, status);
create index if not exists listings_search_trgm_idx on listings using gin (search_text gin_trgm_ops);
create index if not exists listings_agency_code_idx on listings(agency_id, lower(code));

create table if not exists listing_images (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references listings(id) on delete cascade,
  agency_id   uuid not null references agencies(id) on delete cascade,  -- Denormalized for scoped duplicate queries
  position    int  not null,
  url         text not null,
  phash       bit(64) not null                                          -- 64-bit dHash of the original photo
);
create index if not exists listing_images_agency_idx on listing_images(agency_id);
create index if not exists listing_images_listing_idx on listing_images(listing_id, position);

-- ---------------------------------------------------------------- operations & state
create table if not exists processed_messages (      -- Webhook deduplication (persists across restarts)
  message_id   text primary key,
  received_at  timestamptz not null default now()
);

create table if not exists sessions (                -- Conversation state machine per broker
  phone        text primary key,
  state        text not null check (state in ('collecting','clarifying','review','waiting_code','search_paging')),
  listing_id   uuid references listings(id) on delete set null,
  data         jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- analytics & metrics
create table if not exists usage_events (            -- Granular audit log, unit economics & rate limits
  id           bigserial primary key,
  agency_id    uuid,
  broker_id    uuid,
  phone        text,
  event_type   text not null,                        -- submission, brochure, regenerate, search, show, status, price, confirm, gemini, duplicate_warning, error, unregistered, rate_limited
  listing_id   uuid,
  duration_ms  int,
  cost_usd     numeric(8, 6) default 0,              -- Real API cost tracked per transaction
  tokens_input int default 0,
  tokens_output int default 0,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists usage_broker_type_time_idx on usage_events(broker_id, event_type, created_at desc);
create index if not exists usage_agency_time_idx on usage_events(agency_id, created_at desc);

create table if not exists search_analytics (        -- Captures local buyer demand & zero-result inventory gaps
  id            bigserial primary key,
  agency_id     uuid not null references agencies(id) on delete cascade,
  broker_id     uuid not null references brokers(id),
  query_raw     text not null,
  tokens        text[] not null,
  results_count int not null,
  is_voice      boolean default false,
  created_at    timestamptz not null default now()
);
create index if not exists idx_search_analytics_agency on search_analytics(agency_id, created_at desc);

create or replace view daily_usage as
select date_trunc('day', created_at)::date as day,
       agency_id,
       event_type,
       count(*) as events,
       round(avg(duration_ms)) as avg_ms,
       round(sum(cost_usd), 4) as total_cost_usd
from usage_events
group by 1, 2, 3;

-- ---------------------------------------------------------------- security (row level security)
-- The bot connects using the service key / postgres superuser, bypassing RLS.
-- Enabling RLS with no policies prevents any unauthorized client using the anon key from reading data.
alter table agencies           enable row level security;
alter table brokers            enable row level security;
alter table listings           enable row level security;
alter table listing_images     enable row level security;
alter table processed_messages enable row level security;
alter table sessions           enable row level security;
alter table usage_events       enable row level security;
alter table search_analytics   enable row level security;