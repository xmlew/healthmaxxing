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

-- Set when the session came from an Apple Health workout; that link is the
-- session's provenance (imported vs. manual). At most one session per workout,
-- so re-ingesting an export never duplicates one (same pattern as
-- strength_sessions_workout_id_key).
alter table training_sessions add column if not exists workout_id text references workouts (id);

create unique index if not exists training_sessions_workout_id_key
  on training_sessions (workout_id)
  where workout_id is not null;

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

-- Fuel and other consumables, counted in servings (one gel, one scoop, one
-- tab). Nutrition is per serving and optional. Stock on hand is never stored:
-- it is the sum of stock_events minus the servings recorded on completed,
-- undeleted sessions, so editing or deleting a
-- session moves the balance exactly once.
create table if not exists consumables (
  id bigserial primary key,
  name text not null,
  kind text not null,
  serving_unit text not null default 'serving',
  carbs_g double precision,
  sodium_mg double precision,
  caffeine_mg double precision,
  -- The balance at or below which stock is flagged as low; no flag when unset.
  low_stock_servings double precision,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists consumables_name_lower_key on consumables (lower(name));

-- Changes to the count on hand: a purchase, a starting count, a gift, a lost
-- bag. A positive event is a lot, with its expiry when known.
create table if not exists stock_events (
  id bigserial primary key,
  consumable_id bigint not null references consumables (id),
  servings double precision not null,
  occurred_on date not null,
  expires_on date,
  note text,
  created_at timestamptz not null default now(),
  constraint stock_events_nonzero check (servings <> 0)
);

create index if not exists stock_events_consumable_idx on stock_events (consumable_id);

-- Fuel taken (completed session) or planned (planned session). One row per
-- product per session, so an edit replaces the count instead of adding to it.
create table if not exists training_session_fuel (
  session_id bigint not null references training_sessions (id) on delete cascade,
  consumable_id bigint not null references consumables (id),
  servings double precision not null,
  primary key (session_id, consumable_id),
  constraint training_session_fuel_servings_check check (servings > 0)
);

create index if not exists training_session_fuel_consumable_idx
  on training_session_fuel (consumable_id);

-- Maintenance: a rule says how often an item should be checked - by elapsed
-- days, distance, or ride/run time, whichever comes first - and a service log
-- records that it was done. Due status is computed from the latest service
-- against the rule (or the rule's start date) and the usage since, never
-- stored, so logging a service or editing a session re-evaluates it. A rule
-- means "inspection due", not that the item is unsafe.
create table if not exists maintenance_rules (
  id bigserial primary key,
  equipment_id bigint not null references equipment (id) on delete cascade,
  name text not null,
  interval_days integer,
  interval_km double precision,
  interval_hours double precision,
  -- Usage is counted from here until the first service is logged.
  starts_on date not null default current_date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint maintenance_rules_interval_check
    check (coalesce(interval_days, interval_km, interval_hours) is not null),
  constraint maintenance_rules_positive_check check (
    (interval_days is null or interval_days > 0)
    and (interval_km is null or interval_km > 0)
    and (interval_hours is null or interval_hours > 0)
  )
);

create unique index if not exists maintenance_rules_equipment_name_key
  on maintenance_rules (equipment_id, lower(name));

create table if not exists service_logs (
  id bigserial primary key,
  equipment_id bigint not null references equipment (id) on delete cascade,
  -- The rule this service satisfies; null for a one-off service. Deleting a rule
  -- keeps the history.
  rule_id bigint references maintenance_rules (id) on delete set null,
  performed_on date not null,
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists service_logs_equipment_idx on service_logs (equipment_id, performed_on desc);

-- Money spent or committed on training and racing. Each expense keeps the
-- amount and currency it was actually charged in; totals are in USD using the
-- rate declared on the expense itself (usd_per_unit), and an expense in another
-- currency with no declared rate stays visibly unconverted rather than guessed.
-- A planned expense becomes paid in place, so a purchase is never forecast and
-- counted as spent at the same time.
create table if not exists expenses (
  id bigserial primary key,
  description text not null,
  category text not null,
  amount numeric(14, 2) not null,
  currency text not null default 'USD',
  usd_per_unit numeric(18, 8),
  status text not null default 'paid',
  expense_date date not null,
  -- What the money bought, when it was a gear item; cost lives only here.
  equipment_id bigint references equipment (id),
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expenses_category_check check (category in (
    'equipment', 'consumables', 'maintenance', 'registration', 'travel', 'rentals', 'other'
  )),
  constraint expenses_status_check check (status in ('planned', 'paid')),
  constraint expenses_amount_check check (amount > 0),
  constraint expenses_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint expenses_rate_check check (
    usd_per_unit is null or (usd_per_unit > 0 and currency <> 'USD')
  )
);

create index if not exists expenses_date_idx on expenses (expense_date desc);

-- A stock lot bought with an expense is a purchase. It counts toward stock only
-- while that expense is paid and not deleted, so a planned purchase is never
-- mistaken for gels on the shelf.
alter table stock_events add column if not exists expense_id bigint references expenses (id);

-- A race being prepared for. Several can coexist (an A race, a tune-up); the
-- next upcoming one is the default everywhere a race is not named. Distances
-- are per race because courses differ from the nominal format.
create table if not exists races (
  id bigserial primary key,
  name text not null,
  race_date date not null,
  location text,
  swim_km double precision,
  bike_km double precision,
  run_km double precision,
  goal text,
  budget_usd numeric(14, 2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint races_budget_check check (budget_usd is null or budget_usd >= 0)
);

create unique index if not exists races_name_lower_key on races (lower(name));

-- Spend attributed to a race (entry, travel, race-specific gear); the race's
-- budget is measured against exactly these.
alter table expenses add column if not exists race_id bigint references races (id) on delete set null;

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
