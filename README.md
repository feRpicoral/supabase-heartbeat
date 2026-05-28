# Supabase Heartbeat

Keeps multiple Supabase projects active from GitHub Actions with one tiny Postgres write per project.

This repo does not use Supabase REST, GraphQL, or client API keys. It connects to Postgres directly, so RLS and disabled Data API settings do not affect the heartbeat.

## Local Config

Copy `.env.example` to `.env` for runtime settings:

```text
SUPABASE_HEARTBEAT_ID=github-actions
SUPABASE_HEARTBEAT_CONCURRENCY=4
```

Copy `projects.urls.example` to `projects.urls` and replace each line with a Supavisor session pooler URL:

```text
postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-region.pooler.supabase.com:5432/postgres # production

postgresql://postgres.OTHER_PROJECT_REF:PASSWORD@aws-0-region.pooler.supabase.com:5432/postgres # staging
```

Blank lines and comments use dotenv-style parsing: `#` starts a comment unless it is inside single or double quotes.

Use the session pooler on port `5432`. The transaction pooler on port `6543` works for some simple queries but is a worse default because it does not preserve normal session behavior.

The heartbeat always connects over TLS and does not verify the server certificate chain, so you do not need to add `sslmode` to the URLs. Any `sslmode` left in a URL is ignored. Certificate verification is skipped because Supabase serves a self-signed CA chain that newer `pg` releases reject under `sslmode=require`.

`.env` and `projects.urls` are ignored and must never be committed.

## Sync GitHub Secret

```sh
scripts/sync-gh-secret.sh
```

The script reads `projects.urls` and updates the `SUPABASE_DATABASE_URLS` Actions secret through the GitHub CLI.

To target a specific repository:

```sh
GH_REPO=owner/repo scripts/sync-gh-secret.sh
```

To use a different local file:

```sh
scripts/sync-gh-secret.sh ./my-projects.urls
```

The script stores all URLs in one secret and prints only the number of URLs synced.

## Database Objects

The workflow runs `sql/setup.sql` to create a dedicated schema and table in every configured database:

```sql
CREATE SCHEMA IF NOT EXISTS heartbeat;

CREATE TABLE IF NOT EXISTS heartbeat.pings (
  id TEXT PRIMARY KEY,
  touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Every run executes `sql/ping.sql` with `SUPABASE_HEARTBEAT_ID` as the row id:

```sql
INSERT INTO heartbeat.pings (id, touched_at)
VALUES ($1, NOW())
ON CONFLICT (id)
DO UPDATE SET touched_at = EXCLUDED.touched_at;
```

The table is isolated from `public`, has no foreign keys, no triggers, no extensions, no policies, and no dependency on Supabase-managed schemas. Prisma projects should not see it unless they intentionally introspect the `heartbeat` schema.

## GitHub Actions

The workflow runs twice per day and can also be started manually from the Actions tab.

If one project fails, the rest still run. The job exits with a failure status after all projects finish when any project failed.

## Install

```sh
yarn install
```

## Run Locally

```sh
SUPABASE_DATABASE_URLS="$(cat projects.urls)" node --env-file=.env scripts/heartbeat.mjs
```

## Test

```sh
yarn test
```
