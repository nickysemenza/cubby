# USDA DB Hono + Drizzle (SQLite)

A minimal Hono app using Drizzle ORM with a local SQLite database. Schema is derived from the provided Prisma models. The root route (`/`) returns row counts for each table.

## Stack
- Hono (`@hono/node-server`)
- Drizzle ORM + better-sqlite3
- SQLite (local file)
- Fly.io deploy (with a volume mounted at `/data`)

## Project Layout
- `src/db/schema.ts` — Drizzle schema mirroring the Prisma models
- `drizzle/0000_init.sql` — SQL migration to create tables and indexes
- `src/db/client.ts` — DB setup, migrations, and small helpers
- `src/index.ts` — Hono server with a single route
- `fly.toml` / `Dockerfile` — Fly deployment config

## Setup

1) Install deps

- pnpm: `pnpm install`

2) Initialize the database

- Create local SQLite file and apply migrations: `pnpm run migrate` (will create `./data/usda.sqlite` and apply `drizzle/0000_init.sql`).

3) Run dev server

- `pnpm run dev`
- Open `http://localhost:8080/` to see counts

4) Build + run

- `pnpm run build && pnpm start`

## Fly.io

Database snapshot download (R2) on first boot:

- Upload your local DB to the public R2 bucket and make it public:
  - Gzip and upload with the helper script: `pnpm upload:db`
    - Requires rclone, R2 access keys (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY), and `R2_ACCOUNT_ID`
    - Uses bucket `usda-sqlite` and object key `usda.sqlite.gz` by default
    - Outputs a public URL like `https://usda-sqlite.nickysemenza.com/usda.sqlite.gz`
- Configure Fly env (fly.toml already includes a default URL):
  - `USDA_DB_URL` — public snapshot URL (gzip, `.gz`)
- Create a volume and deploy:
  - `fly volumes create data --region <REGION> --size 10`
  - `fly deploy`
- On first boot, the entrypoint downloads and decompresses into `/data/usda.sqlite`. The file persists on the volume.

Notes
- `DATABASE_PATH` defaults to `/data/usda.sqlite` and is set in `fly.toml`.
- The image excludes `data/` to keep builds fast.
- Script env overrides:
  - `R2_BUCKET`, `R2_OBJECT_KEY`, `R2_PUBLIC_BASE` for custom setups.

## Notes
- The original Prisma GIN/trigram index is Postgres-specific; in SQLite we create a normal index on `usda_food.description` instead.
- Decimal fields are stored as `REAL` in SQLite.
- Foreign keys are defined and enforced by SQLite (`PRAGMA foreign_keys=ON`).

## Route
- `GET /` — returns JSON counts of: `usda_food`, `usda_branded_food`, `usda_nutrient`, `usda_food_nutrient`, `usda_measure_unit`, `usda_food_portion`, `usda_sr_legacy_food`.
