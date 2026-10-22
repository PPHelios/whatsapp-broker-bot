-- ============================================================================
-- AqarChat Production Database Schema
-- Matches: lib/text.js, lib/financials.js, lib/excel.js, lib/search.js, lib/listing.js
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ----------------------------------------------------------------------------
-- 1. Agencies (Tenants)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    logo_url TEXT,
    phone TEXT,
    brand_color TEXT DEFAULT '#0f172a' NOT NULL,
    accent_color TEXT DEFAULT '#38bdf8' NOT NULL,
    primary_color VARCHAR(7) DEFAULT '#0B132B',
    secondary_color VARCHAR(7) DEFAULT '#D4AF37',
    flyer_theme TEXT DEFAULT 'dark' NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- ----------------------------------------------------------------------------
-- 2. Brokers (Agents & Admins)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brokers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    phone_normalized TEXT,
    name TEXT NOT NULL,
    contact_phone TEXT,
    role TEXT DEFAULT 'broker' NOT NULL,
    is_active BOOLEAN DEFAULT true NOT NULL,
    preferred_lang VARCHAR(10) DEFAULT 'ar',
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    CONSTRAINT uq_broker_agency_phone UNIQUE (agency_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_brokers_agency ON public.brokers USING btree (agency_id);
CREATE INDEX IF NOT EXISTS idx_brokers_phone ON public.brokers USING btree (phone_number);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_brokers_phone_normalized ON public.brokers USING btree (phone_normalized);

-- ----------------------------------------------------------------------------
-- 3. Projects (Compounds & Master Developments)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    developer_name TEXT,
    district TEXT,
    city TEXT,
    delivery_year INTEGER,
    maintenance_pct NUMERIC DEFAULT 8.0,
    collateral JSONB DEFAULT '{}'::jsonb NOT NULL,
    media JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    CONSTRAINT uq_agency_project_name UNIQUE (agency_id, name)
);

-- ----------------------------------------------------------------------------
-- 4. Listings & Units
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    broker_id UUID REFERENCES public.brokers(id) ON DELETE SET NULL, -- Nullable to allow unclaimed units
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    code TEXT NOT NULL,
    status TEXT DEFAULT 'draft' NOT NULL,
    listing_type TEXT DEFAULT 'sale',
    inventory_type TEXT DEFAULT 'resale_unit' NOT NULL,
    property_type TEXT DEFAULT 'apartment',
    is_primary_developer BOOLEAN DEFAULT false NOT NULL,
    developer_unit_code TEXT,

    -- Specs
    title TEXT,
    compound TEXT,
    compound_en VARCHAR(120),
    district TEXT,
    city TEXT,
    price_value NUMERIC,
    price_display TEXT,
    down_payment_value NUMERIC,
    installment_years INTEGER,
    installment_value NUMERIC,
    payment_frequency TEXT DEFAULT 'quarterly',
    delivery_date TEXT,
    maintenance_pct NUMERIC DEFAULT 8,
    area_value NUMERIC,
    bedrooms INTEGER,
    bathrooms INTEGER,
    features TEXT[] DEFAULT '{}'::text[] NOT NULL,
    location_keywords TEXT[] DEFAULT '{}'::text[] NOT NULL,
    details JSONB DEFAULT '{}'::jsonb NOT NULL,
    payment_terms JSONB DEFAULT '{}'::jsonb NOT NULL,
    collateral JSONB DEFAULT '{}'::jsonb NOT NULL,

    -- Search & Text NLP
    language TEXT DEFAULT 'ar' NOT NULL,
    raw_text TEXT,
    search_text TEXT DEFAULT '' NOT NULL,
    search_text_normalized TEXT,

    -- Geo
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    location_name TEXT,

    -- Flyer & Media
    flyer_url TEXT,
    hero_position INTEGER DEFAULT 0 NOT NULL,
    flyer_wa_media_id TEXT,
    flyer_wa_media_at TIMESTAMP WITH TIME ZONE,
    flyer_cache JSONB DEFAULT '{}'::jsonb,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    CONSTRAINT uq_agency_listing_code UNIQUE (agency_id, code)
);

CREATE INDEX IF NOT EXISTS idx_listings_agency_status ON public.listings USING btree (agency_id, status);
CREATE INDEX IF NOT EXISTS idx_listings_agency_code ON public.listings USING btree (agency_id, lower(code));
CREATE INDEX IF NOT EXISTS idx_listings_details_gin ON public.listings USING gin (details);
CREATE INDEX IF NOT EXISTS idx_listings_location_keywords_gin ON public.listings USING gin (location_keywords);

-- ----------------------------------------------------------------------------
-- 5. Payment Plans
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID REFERENCES public.listings(id) ON DELETE CASCADE,
    plan_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    years INTEGER DEFAULT 0 NOT NULL,
    discount_pct NUMERIC(5,2) DEFAULT 0.00,
    down_payment_pct NUMERIC(5,2) DEFAULT 10.00,
    maintenance_pct NUMERIC(5,2) DEFAULT 8.00,
    maintenance_splits INTEGER DEFAULT 3,
    milestones JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_plans_listing ON public.payment_plans USING btree (listing_id);

-- ----------------------------------------------------------------------------
-- 6. Images & Media
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.listing_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    "position" INTEGER NOT NULL,
    url TEXT NOT NULL,
    phash BIT(64),
    role TEXT,
    CONSTRAINT uq_listing_image_position UNIQUE (listing_id, "position")
);

CREATE INDEX IF NOT EXISTS idx_listing_images_listing ON public.listing_images USING btree (listing_id, "position");

-- ----------------------------------------------------------------------------
-- 7. Ingestion, Sessions & Operational Logs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.listing_drafts (
    broker_id UUID PRIMARY KEY REFERENCES public.brokers(id) ON DELETE CASCADE,
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    broker_phone VARCHAR(32) NOT NULL,
    media_ids TEXT[] DEFAULT '{}'::text[],
    voice_ids TEXT[] DEFAULT '{}'::text[],
    texts TEXT[] DEFAULT '{}'::text[],
    custom_code VARCHAR(64),
    staged_data JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.broker_sessions (
    broker_id UUID NOT NULL REFERENCES public.brokers(id) ON DELETE CASCADE,
    session_type VARCHAR(64) NOT NULL,
    context_data JSONB DEFAULT '{}'::jsonb NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (broker_id, session_type)
);

CREATE TABLE IF NOT EXISTS public.inbound_messages (
    msg_id TEXT PRIMARY KEY,
    phone_key TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT DEFAULT 'new' NOT NULL,
    attempts INTEGER DEFAULT 0 NOT NULL,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.processed_messages (
    message_id VARCHAR(128) PRIMARY KEY,
    sender_masked VARCHAR(64) NOT NULL,
    direction VARCHAR(16) DEFAULT 'inbound' NOT NULL,
    action_type VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID REFERENCES public.agencies(id) ON DELETE CASCADE,
    broker_id UUID REFERENCES public.brokers(id) ON DELETE SET NULL,
    action VARCHAR(64) NOT NULL,
    severity VARCHAR(16) DEFAULT 'info',
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_agency ON public.audit_logs USING btree (agency_id, created_at DESC);