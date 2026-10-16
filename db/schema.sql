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
  created_at timestamptz not null default now()
);

-- Weight is stored in kilograms everywhere (see lib/units.ts) and rendered in
-- pounds, so there is no per-exercise unit to record.
alter table exercises drop column if exists default_unit;

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
  weight_kg double precision,
  reps integer,
  rpe double precision,
  rir double precision,
  created_at timestamptz not null default now()
);

-- The column carried kilograms all along; the name now says so, matching
-- weight_logs.weight_kg. Guarded so re-running against a migrated database
-- is a no-op.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'strength_sets' and column_name = 'weight'
  ) then
    alter table strength_sets rename column weight to weight_kg;
  end if;
end
$$;

-- A set's role in the session. Only 'working' sets feed 1RM estimates,
-- progressive-overload PRs, and training volume; see lib/set-types.ts for why.
alter table strength_sets add column if not exists set_type text not null default 'working';

alter table strength_sets drop constraint if exists strength_sets_set_type_check;
alter table strength_sets add constraint strength_sets_set_type_check
  check (set_type in ('working', 'warmup', 'dropset', 'burnout'));

create index if not exists strength_sets_session_idx on strength_sets (session_id);
create index if not exists strength_sets_exercise_idx
  on strength_sets (exercise_id, created_at desc);

-- A routine is a named rotation of training days (Push/Pull/Legs), each day an
-- ordered list of exercises with the targets to hit. Targets are the plan;
-- strength_sets stay the record of what actually happened, so a missed session
-- never rewrites what you meant to do. Routines are versioned by name
-- ("PPL v1.0"), and the most recently created one is the current plan.
create table if not exists routines (
  id bigserial primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists routines_name_lower_key on routines (lower(name));

create table if not exists routine_days (
  id bigserial primary key,
  routine_id bigint not null references routines (id) on delete cascade,
  name text not null,
  position integer not null,
  created_at timestamptz not null default now()
);

-- Days are addressed by name within a routine ("push"), and ordered by position
-- so the next day in the rotation is well defined.
create unique index if not exists routine_days_routine_name_key
  on routine_days (routine_id, lower(name));

create table if not exists routine_exercises (
  id bigserial primary key,
  day_id bigint not null references routine_days (id) on delete cascade,
  exercise_id bigint not null references exercises (id),
  position integer not null,
  target_sets integer,
  target_reps integer,
  target_weight_kg double precision,
  notes text,
  created_at timestamptz not null default now()
);

create unique index if not exists routine_exercises_day_exercise_key
  on routine_exercises (day_id, exercise_id);

-- Which routine day a session was. Without it the rotation cannot be advanced:
-- "what is next" is answered by looking at what the last session was.
alter table strength_sessions add column if not exists routine_day_id bigint;

-- History outlives the plan. Retiring a routine must neither be blocked by the
-- sessions logged against it nor delete them: the training happened, and the
-- routine day was only the label it was filed under. Dropped and re-added so an
-- already-migrated database picks up the delete behavior.
alter table strength_sessions drop constraint if exists strength_sessions_routine_day_id_fkey;
alter table strength_sessions add constraint strength_sessions_routine_day_id_fkey
  foreign key (routine_day_id) references routine_days (id) on delete set null;

-- Endurance training. A `training_session` is one swim, ride, run, or brick,
-- planned or completed; PPL lifting stays in strength_sessions. A session is a
-- date and a status, and its ordered `training_segments` carry the sport,
-- duration, and distance - a single-sport session has one segment, a brick has
-- several. Nothing is stored at the session level that a segment already says,
-- so a session's sport and totals are always read off its segments.
create table if not exists training_sessions (
  id bigserial primary key,
  session_date date not null,
  status text not null default 'completed',
  rpe double precision,
  notes text,
  -- Soft delete: training history feeds equipment usage and stock balances, so a
  -- deletion must be recoverable rather than silently rewriting those totals.
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint training_sessions_status_check check (status in ('planned', 'completed')),
  constraint training_sessions_rpe_check check (rpe is null or rpe between 0 and 10)
);

create index if not exists training_sessions_date_idx
  on training_sessions (session_date desc);

create table if not exists training_segments (
  id bigserial primary key,
  session_id bigint not null references training_sessions (id) on delete cascade,
  position integer not null,
  sport text not null,
  duration_min double precision,
  distance_km double precision,
  created_at timestamptz not null default now(),
  constraint training_segments_sport_check check (sport in ('swim', 'bike', 'run')),
  constraint training_segments_duration_check check (duration_min is null or duration_min > 0),
  constraint training_segments_distance_check check (distance_km is null or distance_km >= 0),
  unique (session_id, position)
);

-- Gear inventory. Cost is deliberately absent: what an item cost lives on the
-- expense that paid for it, so spend is counted in exactly one place. Usage is
-- likewise derived from the completed segments the item is linked to, never
-- stored as a counter that edits and retries could drift.
create table if not exists equipment (
  id bigserial primary key,
  name text not null,
  category text not null,
  status text not null default 'owned',
  quantity integer not null default 1,
  location text,
  acquired_on date,
  fit_notes text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint equipment_status_check
    check (status in ('needed', 'owned', 'rented', 'borrowed', 'retired')),
  constraint equipment_quantity_check check (quantity >= 0)
);

create unique index if not exists equipment_name_lower_key on equipment (lower(name));

-- Gear is linked per segment, not per session: in a brick the bike rides the
-- bike leg and the shoes run the run leg, and each accrues only its own distance.
create table if not exists training_segment_equipment (
  segment_id bigint not null references training_segments (id) on delete cascade,
  equipment_id bigint not null references equipment (id),
  primary key (segment_id, equipment_id)
);

create index if not exists training_segment_equipment_equipment_idx
  on training_segment_equipment (equipment_id);

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
