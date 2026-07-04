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
