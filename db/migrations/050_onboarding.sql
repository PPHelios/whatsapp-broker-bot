-- 050: onboarding. brokers.onboarding = { welcome: <time the welcome card was closed>, hints: { unit, search, lead:
-- <time the bot's one-time hint was sent> }, nudges: { d1, d3, d7: <time sent or skipped> } }.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS onboarding jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Brokers who were already here have seen enough: no welcome card, hints or nudges for them.
UPDATE brokers SET onboarding = jsonb_build_object('welcome', now(), 'nudges', jsonb_build_object('d1', now(), 'd3', now(), 'd7', now()),
       'hints', jsonb_build_object('unit', now(), 'search', now(), 'lead', now()))
 WHERE onboarding = '{}'::jsonb;
