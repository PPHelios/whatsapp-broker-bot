-- ============================================================
-- AqarChat Master Schema Definition
-- Compatible with PostgreSQL 15+ / Supabase
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ------------------------------------------------------------
-- 1. IMMUTABLE ARABIC NORMALIZER FUNCTION
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clean_arabic_text(input_text TEXT)
RETURNS TEXT AS $$
BEGIN
    IF input_text IS NULL THEN
        RETURN '';
    END IF;

    -- Remove Tashkeel
    input_text := regexp_replace(input_text, '[\u064B-\u065F\u0670]', '', 'g');
    -- Remove Tatweel
    input_text := regexp_replace(input_text, '\u0640', '', 'g');
    -- Normalize Alef
    input_text := regexp_replace(input_text, '[إأآٱ]', 'ا', 'g');
    -- Normalize Yaa
    input_text := regexp_replace(input_text, 'ى', 'ي', 'g');
    -- Normalize Taa Marbouta
    input_text := regexp_replace(input_text, 'ة', 'ه', 'g');
    -- Lowercase and collapse spaces
    RETURN lower(trim(regexp_replace(input_text, '\s+', ' ', 'g')));
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- ------------------------------------------------------------
-- 2. CORE TENANCY TABLES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    logo_url TEXT,
    brand_color TEXT NOT NULL DEFAULT '#0f172a',
    accent_color TEXT NOT NULL DEFAULT '#38bdf8',
    primary_color VARCHAR DEFAULT '#0B132B',
    secondary_color VARCHAR DEFAULT '#D4AF37',
    flyer_theme TEXT NOT NULL DEFAULT 'dark',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.brokers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    phone TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    contact_phone TEXT,
    role TEXT NOT NULL DEFAULT 'broker',
    is_active BOOLEAN NOT NULL DEFAULT true,
    preferred_lang VARCHAR DEFAULT 'ar',
    phone_normalized TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ------------------------------------------------------------
-- 3. PRIMARY DEVELOPER PROJECTS (Master Collateral Entity)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    developer_name TEXT,
    district TEXT,
    city TEXT,
    delivery_year INTEGER,
    maintenance_pct NUMERIC DEFAULT 8.0,
    collateral JSONB NOT NULL DEFAULT '{}'::jsonb,
    media JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    CONSTRAINT uq_agency_project_name UNIQUE (agency_id, name)
);

-- ------------------------------------------------------------
-- 4. LISTINGS (Resale Units & Developer Typologies)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    broker_id UUID NOT NULL REFERENCES public.brokers(id) ON DELETE RESTRICT,
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,

    code TEXT NOT NULL UNIQUE,
    developer_unit_code TEXT,
    inventory_type TEXT NOT NULL DEFAULT 'resale_unit',
    status TEXT NOT NULL DEFAULT 'draft',

    title TEXT,
    property_type TEXT,
    listing_type TEXT,

    -- Financials & Pricing Matrix
    price_value NUMERIC,
    price_display TEXT,
    is_primary_developer BOOLEAN NOT NULL DEFAULT false,
    down_payment_value NUMERIC,
    installment_years INTEGER,
    installment_value NUMERIC,
    payment_frequency TEXT DEFAULT 'quarterly',
    maintenance_pct NUMERIC DEFAULT 8,
    payment_terms JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Physical Specs & Location
    area_value NUMERIC,
    bedrooms INTEGER,
    compound TEXT,
    district TEXT,
    city TEXT,
    location TEXT,
    location_name TEXT,
    location_keywords TEXT[] NOT NULL DEFAULT '{}',
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    delivery_date TEXT,

    -- Descriptive & Normalized Search
    features TEXT[] NOT NULL DEFAULT '{}',
    language TEXT NOT NULL DEFAULT 'ar',
    raw_text TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    search_text TEXT NOT NULL DEFAULT '',
    search_text_normalized TEXT,

    -- Assets & Deliverables
    collateral JSONB NOT NULL DEFAULT '{}'::jsonb,
    flyer_url TEXT,
    hero_position INTEGER NOT NULL DEFAULT 0,
    flyer_wa_media_id TEXT,
    flyer_wa_media_at TIMESTAMP WITH TIME ZONE,
    flyer_cache JSONB DEFAULT '{}'::jsonb,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- ------------------------------------------------------------
-- 5. LISTING IMAGES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.listing_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    url TEXT NOT NULL,
    phash BIT(64),
    role TEXT
);

-- ------------------------------------------------------------
-- 6. BROKER STATE & DRAFT WORKFLOWS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.listing_drafts (
    broker_id UUID PRIMARY KEY REFERENCES public.brokers(id) ON DELETE CASCADE,
    agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
    broker_phone VARCHAR NOT NULL,
    media_ids TEXT[] DEFAULT '{}',
    voice_ids TEXT[] DEFAULT '{}',
    texts TEXT[] DEFAULT '{}',
    custom_code VARCHAR,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.broker_search_state (
    phone_key TEXT PRIMARY KEY,
    parsed JSONB NOT NULL,
    next_offset INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inbound_messages (
    msg_id TEXT PRIMARY KEY,
    phone_key TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    attempts INTEGER NOT NULL DEFAULT 0,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.operation_logs (
    id BIGSERIAL PRIMARY KEY,
    agency_id UUID,
    broker_id UUID,
    listing_code TEXT,
    operation_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'success',
    error_code TEXT,
    total_duration_ms INTEGER DEFAULT 0,
    gemini_ms INTEGER DEFAULT 0,
    media_download_ms INTEGER DEFAULT 0,
    image_process_ms INTEGER DEFAULT 0
);

-- ------------------------------------------------------------
-- 7. SEARCH & ACCESS INDEXES
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_listings_search_trgm
ON public.listings
USING gin (public.clean_arabic_text(COALESCE(search_text_normalized, search_text, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_listings_agency_code
ON public.listings (agency_id, code);

CREATE INDEX IF NOT EXISTS idx_listings_dev_code
ON public.listings (agency_id, developer_unit_code)
WHERE developer_unit_code IS NOT NULL;