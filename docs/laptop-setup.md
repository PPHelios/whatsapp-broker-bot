# Test the location change on your laptop

Everything runs on your laptop with its own empty database. The live site is never touched.

1. Install Postgres 16 (or Docker) and create a database: `createdb wehdathub_test`
2. `git fetch origin claude/project-thread-vwvg4g && git checkout claude/project-thread-vwvg4g && npm ci`
3. Copy `.env.example` to `.env` and set:
   - `DATABASE_URL=postgres://localhost/wehdathub_test`
   - `DATABASE_SSL=false`, `PORT=3000`, `WHATSAPP_ENABLED=false`, `MIGRATE_ON_BOOT=true`
   - `OWNER_BROKER_IDS` can stay empty for now.
4. `npm run migrate` (builds all tables, loads the area tree and the 266 compounds from the reviewed sheet).
5. Create a test agency and owner: `npm run onboard` with a small JSON file (see `docs/agency-onboarding.md`).
6. Add test units (kept separate from live data): `node --env-file=.env scripts/seed-poc.js seed` (needs the agency owner and a manager from step 5).
7. `npm start`, open http://localhost:3000/app and sign in.

What to try: add a unit, pick Hyde Park (area fills), search "New Cairo", "5th Settlement", "Banafseg 1", a compound alias.

Undo: the import keeps copies in `areas_backup_111`, `map_places_backup_111`, `listings_location_backup_111`. Reset the laptop database any time with `dropdb wehdathub_test && createdb wehdathub_test`.
