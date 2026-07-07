-- Health Maxxing schema. Single-user personal health tracker.
-- Applied via `npm run db:migrate` (scripts/migrate.ts). All statements are
-- idempotent so the script is safe to re-run against an existing database.

create table if not exists health_metric_samples (
  id bigserial primary key,
  metric_name text not null,
  unit text,
  sample_ts timestamptz not null,
  source text not null default '',
  qty double precision,
  min_value double precision,
  avg_value double precision,
  max_value double precision,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (metric_name, sample_ts, source)
);

create index if not exists health_metric_samples_name_ts_idx
  on health_metric_samples (metric_name, sample_ts desc);

create table if not exists workouts (
  id text primary key,
  name text,
  location text,
  is_indoor boolean,
  start_time timestamptz,
  end_time timestamptz,
  duration_min double precision,
  active_energy_kj double precision,
  basal_energy_kj double precision,
  distance_km double precision,
  avg_heart_rate double precision,
  max_heart_rate double precision,
  step_count integer,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists workouts_start_time_idx on workouts (start_time desc);

create table if not exists weight_logs (
  id bigserial primary key,
  logged_at timestamptz not null,
  weight_kg double precision not null,
  body_fat_pct double precision,
  source text not null default 'manual',
  note text,
  created_at timestamptz not null default now(),
  unique (logged_at, source)
);

create index if not exists weight_logs_logged_at_idx on weight_logs (logged_at desc);

-- Body composition beyond scale weight. weight_logs is already a measurement
-- snapshot (weight + body_fat_pct); a smart-scale reading adds these in the same
-- event, so they extend this row rather than living in a second table that would
-- duplicate weight_kg (the single source of truth for weight across the app).
alter table weight_logs add column if not exists skeletal_muscle_mass_kg double precision;
alter table weight_logs add column if not exists waist_cm double precision;

create table if not exists food_logs (
  id bigserial primary key,
  logged_at timestamptz not null,
  description text not null,
  calories double precision not null,
  protein_g double precision,
  carbs_g double precision,
  fat_g double precision,
  meal text,
  created_at timestamptz not null default now()
);

create index if not exists food_logs_logged_at_idx on food_logs (logged_at desc);

create table if not exists goals (
  id smallint primary key default 1,
  starting_weight_kg double precision,
  starting_date date,
  target_weight_kg double precision,
  target_date date,
  daily_calorie_target double precision,
  updated_at timestamptz not null default now(),
  constraint goals_singleton check (id = 1)
);

-- Training phase drives the direction of the pace check: a cut expects loss, a
-- bulk expects controlled gain, recomp/maintenance expect roughly stable weight.
-- Added post-hoc via alter + a guarded constraint so re-running stays idempotent.
alter table goals add column if not exists phase text not null default 'maintenance';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'goals_phase_check') then
    alter table goals add constraint goals_phase_check
      check (phase in ('cut', 'bulk', 'recomp', 'maintenance'));
  end if;
end $$;

-- Daily protein target (grams). For muscle building this is the macro that
-- matters most, so it sits alongside the calorie target.
alter table goals add column if not exists daily_protein_target double precision;

-- Strength training. A `strength_session` is one lifting session; its `strength_sets`
-- are the working sets. `exercises` is a normalized reference table so a muscle group
-- (and default unit) lives in one place rather than being repeated on every set.
create table if not exists exercises (
  id bigserial primary key,
  name text not null,
  muscle_group text,
  default_unit text not null default 'kg',
  created_at timestamptz not null default now()
);

-- Dedupe exercise names case-insensitively so the write path (upsert) and the
-- read path (getExerciseHistory matches on lower(name)) agree - otherwise "Bench"
-- and "bench" become two rows on write but merge on read. Drop the original
-- case-sensitive unique so re-running transitions an already-migrated database.
alter table exercises drop constraint if exists exercises_name_key;
create unique index if not exists exercises_name_lower_key on exercises (lower(name));

create table if not exists strength_sessions (
  id bigserial primary key,
  session_date date not null,
  notes text,
  workout_id text references workouts (id),
  created_at timestamptz not null default now()
);

create index if not exists strength_sessions_date_idx
  on strength_sessions (session_date desc);

-- At most one auto-linked session per Apple Health workout, so re-importing an
-- export doesn't create duplicate sessions for the same "Traditional Strength
-- Training" workout. Partial (workout_id is not null) so manual sessions are unconstrained.
create unique index if not exists strength_sessions_workout_id_key
  on strength_sessions (workout_id)
  where workout_id is not null;

create table if not exists strength_sets (
  id bigserial primary key,
  session_id bigint not null references strength_sessions (id) on delete cascade,
  exercise_id bigint not null references exercises (id),
  set_number integer not null,
  weight double precision,
  reps integer,
  rpe double precision,
  rir double precision,
  created_at timestamptz not null default now()
);

create index if not exists strength_sets_session_idx on strength_sets (session_id);
create index if not exists strength_sets_exercise_idx
  on strength_sets (exercise_id, created_at desc);

-- OAuth 2.1 authorization server, backing the MCP endpoint's connector handshake
-- (Claude.ai custom connectors require OAuth, not a raw bearer). This app is both
-- the resource server (/api/mcp) and its own authorization server. Secrets, codes,
-- and tokens are stored as their sha256 (base64url) digests, never in plaintext:
-- the DB never needs the original, only to recognize a value presented back to it.
create table if not exists oauth_clients (
  client_id text primary key,
  client_secret_hash text,
  client_name text,
  redirect_uris text[] not null,
  token_endpoint_auth_method text not null default 'client_secret_post',
  scope text,
  created_at timestamptz not null default now()
);

create table if not exists oauth_authorization_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients (client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null,
  scope text,
  resource text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists oauth_access_tokens (
  access_token_hash text primary key,
  refresh_token_hash text unique,
  client_id text not null references oauth_clients (client_id) on delete cascade,
  scope text,
  resource text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists oauth_access_tokens_refresh_idx
  on oauth_access_tokens (refresh_token_hash);
