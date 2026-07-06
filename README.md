# Health Maxxing

A personal health, body-composition, and strength tracker. It ingests Apple
Health data exported by the [Health Auto Export](https://www.healthyapps.dev/)
app, lets you manually log weight and body composition, food (with macros), and
strength sets, and shows trends against a weight-loss or muscle-building goal.

## Features

| Route | What it does |
|---|---|
| `/` | Today's steps, active/basal energy, sleep, resting HR, calories in vs. out, protein vs. target, and progress toward your goal - plus banners when resting HR spikes above its 30-day baseline or protein is under target |
| `/trends` | Weight vs. goal, a lean-mass-vs-fat-mass overlay, calories in vs. out, steps, sleep, resting heart rate, and HRV over 7/30/90 days |
| `/recovery` | Resting HR and HRV overlaid on daily training load, plus weekly strength volume per muscle group, over 7/30/90 days - with an overtraining flag and an overreaching flag when a muscle group's volume stays elevated while HRV declines |
| `/strength` | Per-exercise history and estimated 1RM (Epley) over time, with recent sessions (top set + volume) and a stall badge when best-set volume plateaus |
| `/tdee` | Estimated TDEE (active + basal energy) vs. logged calories: daily and rolling net balance, cumulative deficit/surplus, and implied weight change |
| `/correlations` | Pearson correlation for curated daily-series pairings (sleep vs. next-day resting HR, steps vs. weight-loss rate), with a "not enough data" guard when paired points are too few |
| `/log` | Manual weight/body-composition (body fat %, muscle mass, waist) and food (with macros) entries, with delete |
| `/goals` | Training phase (cut/bulk/recomp/maintenance), starting/target weight, target date, daily calorie and protein targets, with a phase-aware pace check (flags loss too fast on a cut, gain too fast on a bulk) |
| `/workouts` | Imported workouts list + per-workout detail (duration, distance, energy, heart rate) |
| `POST /api/ingest` | Where Health Auto Export's REST API automation posts to, protected by a bearer-token secret (`INGEST_SECRET`) |
| `/api/mcp` | Remote MCP server exposing the same data to Claude as tools - query trends, analyze recovery/TDEE/correlations/anomalies, log weight/food/strength sets, track macros and progressive overload, manage goals - protected by `MCP_SECRET` |

**Data model** (`db/schema.sql`): `health_metric_samples` (every Apple Health
metric, generic name/unit/qty/min/avg/max + raw JSON payload), `workouts`,
`weight_logs` (weight + body fat %, skeletal muscle mass, waist), `food_logs`
(calories + protein/carbs/fat), a normalized `exercises` table with
`strength_sessions` and `strength_sets`, and a single-row `goals` table
(weight targets + training phase + calorie/protein targets).

**Stack**: Next.js 16 (App Router, Turbopack), React 19, Tailwind v4,
Recharts, Postgres via the plain `postgres` driver (works against any local
or hosted Postgres - no ORM, no Neon-specific lock-in).

Data lives in Postgres. There's no login on the dashboard itself - treat the
deployment URL as private, and change `INGEST_SECRET` if it ever leaks.

## Local setup

1. Start a local Postgres (or point at a hosted one - see below). With
   [Homebrew](https://brew.sh):
   ```bash
   brew install postgresql@16
   brew services start postgresql@16
   createdb healthmaxxing
   ```
   Homebrew's Postgres creates a superuser role matching your macOS username
   with local trust auth, so no password is needed for local development.
2. Copy `.env.example` to `.env.local` and fill in `DATABASE_URL` (pointing at
   the database above) and `INGEST_SECRET` (`openssl rand -base64 32`). For the
   Homebrew setup, `postgresql://localhost:5432/healthmaxxing` is enough.
3. Install dependencies and create the schema:
   ```bash
   npm install
   npm run db:migrate
   ```
4. Run the app:
   ```bash
   npm run dev
   ```

### Importing historical data

The `data/` folder (gitignored - never commit real health exports) is where
you'd drop a manual Health Auto Export JSON file. Import it directly into the
database, bypassing the API route entirely:

```bash
npm run db:import -- data/your-export.json
```

This is idempotent - re-importing the same file updates existing rows instead
of duplicating them, so it's safe to re-run after a fresh full export.

## Deploying

1. **Database**: create a hosted Postgres (e.g. a free [Neon](https://neon.tech)
   project) and copy its connection string.
2. **Schema**: run the migration once against that connection string:
   ```bash
   DATABASE_URL="<your-prod-connection-string>" npm run db:migrate
   ```
3. **Backfill**: import your historical export the same way:
   ```bash
   DATABASE_URL="<your-prod-connection-string>" npm run db:import -- data/your-export.json
   ```
   Do this locally, not through `/api/ingest` - hosts like Vercel cap
   serverless function request bodies at 4.5 MB, and a multi-month export is
   much larger than that.
4. **App**: deploy to Vercel (or any Next.js host) and set the `DATABASE_URL`
   and `INGEST_SECRET` environment variables there to the same values.

### Configuring automated sync

In Health Auto Export: **Automations -> new REST API automation**.

- **URL**: `https://<your-deployment>/api/ingest`
- **Method**: POST, **Format**: JSON
- **Headers**: `Authorization: Bearer <your INGEST_SECRET>`
- **Batch Requests**: ON - keeps each request small and under the 4.5 MB
  serverless body limit
- **Date range**: "Since Last Sync" - sends only new data on each run
- Schedule it however often you'd like (e.g. daily)

## Querying from Claude (MCP server)

The app doubles as a remote [MCP](https://modelcontextprotocol.io) server at
`/api/mcp`, so Claude can read and update your data in conversation - *"how's my
resting HR trending this month?"* or *"log 650 kcal for lunch"*. It's a Next.js
route handler (`app/api/[transport]/route.ts`) that reuses the same Postgres
queries as the dashboard, over Streamable HTTP, protected by a bearer token.

Tools: `get_today_summary`, `get_trends`, `get_goal_status`, `list_workouts`,
`get_workout_detail`, `get_recent_logs`, `get_recovery`, `get_tdee`,
`get_correlation`, `get_anomalies`, `get_exercise_history`, `get_1rm_estimate`,
`get_progressive_overload_status`, `get_macro_summary` (read); `log_weight`
(weight + body composition), `log_food` (with macros), `log_set`, `set_goal`,
`delete_weight_log`, `delete_food_log` (write).

Set `MCP_SECRET` in `.env.local` (`openssl rand -base64 32`), then register it
with Claude Code:

```bash
claude mcp add --transport http health-maxxing http://localhost:3000/api/mcp \
  --header "Authorization: Bearer <your MCP_SECRET>"
```

Check the connection with `/mcp` inside a session. Using it from **Claude.ai**
as a custom connector instead requires the server to be reachable over public
HTTPS (localhost only works for Claude Code, or expose it through a tunnel);
deploying it publicly isn't set up yet.

## Current status

Built and verified locally (real import of a 1-month export: 625 metric
samples, 5 workouts; all routes, forms, and the ingest endpoint exercised
end-to-end). **Not yet deployed** - it's only ever been run against a local
Homebrew Postgres, so nothing is reachable from your phone yet, and no weight
or food has been logged for real.

## Notes

- "Today" boundaries (for stats like "steps today") are computed against a
  fixed timezone, `TIME_ZONE` in `lib/time.ts` (defaults to
  `America/Los_Angeles`, matching the sample export). Change it if you're
  somewhere else - this matters because deployed hosts run their server
  clock in UTC.
- Weight and food logging are manual; the sample Health Auto Export data
  didn't include body weight or nutrition metrics. If a future export
  includes a body-weight metric, it lands in `health_metric_samples`
  alongside everything else rather than merging into `weight_logs`.
- Strength sets are logged through the `log_set` MCP tool (e.g. from Claude),
  not a web form yet; a same-day Apple Health "Traditional Strength Training"
  workout auto-links a session. Volume math uses logged weight, so bodyweight-
  only sets (weight 0) currently count as zero load.
- No authentication on the dashboard - anyone with the URL can view and log
  data. Fine for a private/unlisted deployment; worth revisiting before
  sharing the link with anyone.
