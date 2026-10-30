# yomite-parser

Standalone Node.js service for Yomite's external content integrations.

Current responsibilities:

- Fetch and cache Anime News Network RSS headlines.
- Extract readable article text and Open Graph cover images on demand.
- Detect and publish Yomite Android releases to subscribed devices.
- Add CORS, source validation, and health-check endpoints for the mobile/web app.

## Endpoints

- `GET /health`
- `GET /api/news`
- `GET /api/news/article?url=https%3A%2F%2Fwww.animenewsnetwork.com%2F...`
- `GET /api/releases/latest`
- `POST /api/releases/sync` (requires `x-release-sync-secret`)
- `POST /api/releases/subscribe`
- `POST /api/releases/unsubscribe`

The article endpoint only accepts HTTPS URLs hosted on `animenewsnetwork.com` or its subdomains.

## Render

- Service type: Web Service
- Build command: `npm install`
- Start command: `npm start`
- Environment: `CORS_ORIGINS=https://yomite.vercel.app`

The service listens on Render's `PORT` environment variable and binds to `0.0.0.0`.

## Release notifications

Set these Render environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (never expose this to the app)
- `RELEASE_SYNC_SECRET`
- `GITHUB_TOKEN` (optional: increases GitHub API rate limit from 60 to 5,000 requests/hour)
- `RELEASE_POLL_INTERVAL_MS` (optional: background poll cadence in ms, defaults to 900000 / 15 minutes)

Run the release tables in the root `supabase_schema.sql` file before enabling
the GitHub Actions release sync. The Android release workflow calls the sync
endpoint after publishing the curated `release-notes/v{version}.md` body.

The service also runs an auto-recovery check 3 seconds after boot and periodically
polls GitHub releases in the background (default: every 15 minutes), ensuring that
even if the server was asleep or suspended when a release occurred, it automatically
recovers, syncs the newest release with Supabase, sends push notifications to pending devices,
and serves the newest release on `GET /api/releases/latest`.
