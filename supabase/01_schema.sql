-- SRTP Production Tracker — Supabase schema
--
-- Replaces the Google Sheet. Run this once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run), then 02_api.sql.
--
-- WHY THIS EXISTS
-- Apps Script was measured at 0.17–17.8 seconds per request while the script itself
-- did 0–1ms of work. The latency was the platform, not the code, so no amount of
-- optimising the backend could fix it. Postgres answers the same questions in
-- single-digit milliseconds because the tables are indexed — the history sheets had
-- no index, so every lookup scanned every row.
--
-- SHAPE
-- The tables mirror what the sheets held, with two deliberate changes:
--
--   * A work order's ~90 recipe/target fields live in one `spec` jsonb column rather
--     than 90 real columns. They're only ever read as a block, and adding a field to
--     a recipe card then costs nothing — no migration, no append-only rule, none of
--     the column-order fragility that made the Sheet dangerous to tidy up.
--
--   * A thickness check's 16 wall points are an array, not T1…T16. The API hands back
--     both shapes so existing front-end code keeps working.
--
-- Column names are snake_case here (Postgres convention); the API layer in 02_api.sql
-- returns the PascalCase keys the front end already expects, so index.html doesn't
-- need rewriting to match the database.

-- gen_random_uuid(), and crypt()/gen_salt() for password hashing.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Accounts, sessions, settings
-- ---------------------------------------------------------------------------

-- Deliberately not Supabase Auth. The login model is staying exactly as it is for
-- now — admin username/password, operators signed in by scanning a tag that carries
-- a shared key — so changing how the floor signs in isn't bundled into the same
-- switch as changing the database. Supabase Auth is the natural move later, when
-- per-operator logins are worth doing on their own.
create table if not exists accounts (
  id            uuid primary key default gen_random_uuid(),
  username      text not null,
  name          text not null default '',
  role          text not null check (role in ('Admin','Operator')),
  password_hash text not null default '',   -- bcrypt; blank = cannot sign in with a password
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    text not null default ''
);
-- Usernames are compared case-insensitively, so uniqueness has to be too.
create unique index if not exists accounts_username_key on accounts (lower(username));

create table if not exists sessions (
  token      text primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  kind       text not null default 'password',   -- 'password' | 'qr'
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
-- Resolving a token was the single most expensive thing the old backend did: it
-- scanned the whole sheet on every cache miss, and that sheet grew with every tag
-- scan. Here it's a primary-key lookup.
create index if not exists sessions_account_idx on sessions (account_id);
create index if not exists sessions_expires_idx on sessions (expires_at);

create table if not exists settings (
  key   text primary key,
  value text not null default ''
);

-- ---------------------------------------------------------------------------
-- Work orders and reels
-- ---------------------------------------------------------------------------

create table if not exists work_orders (
  code           text primary key,
  created_at     timestamptz not null default now(),
  created_by     text not null default '',
  customer       text not null default '',
  product_code   text not null default '',
  pipe_size      text not null default '',
  email_to       text not null default '',
  project_length numeric,
  archived       boolean not null default false,
  archived_at    timestamptz,
  archived_by    text not null default '',
  last_updated   timestamptz not null default now(),
  -- Every target, temperature, die size and line speed, keyed exactly as the front
  -- end reads them: BL_TargetOD, BR_LongsMaterial, CV_ConcentricityGap, and so on.
  spec           jsonb not null default '{}'::jsonb
);
-- The dashboard asks for unarchived work orders and nothing else.
create index if not exists work_orders_active_idx on work_orders (archived) where archived = false;

create table if not exists pipes (
  pipe_code        text primary key,
  work_order_code  text not null references work_orders(code) on delete cascade,
  created_at       timestamptz not null default now(),
  created_by       text not null default '',

  bl_status        text not null default 'Not started',
  bl_started_at    timestamptz,
  bl_completed_at  timestamptz,
  bl_actual_length numeric,
  br_status        text not null default 'Not started',
  br_started_at    timestamptz,
  br_completed_at  timestamptz,
  br_actual_length numeric,
  cv_status        text not null default 'Not started',
  cv_started_at    timestamptz,
  cv_completed_at  timestamptz,
  cv_actual_length numeric,

  overall_status   text not null default 'Active',
  last_updated     timestamptz not null default now(),
  last_email_at    timestamptz,

  -- Carried on the reel so the dashboard and the TV progress bars never have to look
  -- at the readings table. Kept from the Sheet design because it was the right idea
  -- there and is still the right idea here — the board is read far more often than a
  -- reading is written.
  last_reading_at     timestamptz,
  last_reading_type   text,
  last_reading_value  numeric,
  last_reading_in_tol text,
  bl_last_footage     numeric,
  br_last_footage     numeric,
  cv_last_footage     numeric
);
create index if not exists pipes_work_order_idx on pipes (work_order_code);

-- ---------------------------------------------------------------------------
-- Measurements and log entries
-- ---------------------------------------------------------------------------

-- Voiding, shared by readings and thickness checks. A measurement is never edited and
-- never deleted — it is struck out, with who asked, who agreed and why. Operators can
-- only request; the controller decides. See the void_* columns below.
--   ''          still counts
--   'Requested' operator has asked; STILL COUNTS until approved
--   'Void'      struck out; stops counting, never removed
--   'Rejected'  request turned down; counts again

create table if not exists readings (
  id                uuid primary key default gen_random_uuid(),
  pipe_code         text not null references pipes(pipe_code) on delete cascade,
  section           text not null,
  ts                timestamptz not null default now(),
  operator          text not null default '',
  type              text not null,              -- 'OD' | 'Pitch'
  value             numeric not null,
  in_tol            text not null default '',   -- 'Y' | 'N' | ''
  footage           numeric,

  -- Timestamp provenance: what the operator says vs when the server actually got it.
  -- The gap is what catches a shift's worth of checks back-dated at the end of a day.
  entered_at        timestamptz not null default now(),
  time_source       text not null default 'Device',  -- 'Device' | 'Manual'
  time_offset_min   integer not null default 0,

  void_status       text not null default '',
  void_reason       text not null default '',
  void_requested_by text not null default '',
  void_requested_at timestamptz,
  voided_by         text not null default '',
  voided_at         timestamptz
);
-- This is the index the Sheet could never have. Opening a reel used to scan every row
-- of a sheet holding all of plant history; here it goes straight to the rows it wants.
create index if not exists readings_pipe_idx on readings (pipe_code);
create index if not exists readings_pipe_section_type_idx on readings (pipe_code, section, type);
create index if not exists readings_ts_idx on readings (ts);

create table if not exists thickness_checks (
  id                uuid primary key default gen_random_uuid(),
  pipe_code         text not null references pipes(pipe_code) on delete cascade,
  section           text not null,
  position          text not null default '',   -- 'Start' | 'End'
  ts                timestamptz not null default now(),
  operator          text not null default '',
  od                numeric,
  -- 16 points on Baseline, 12 on Coverline. An array, because T1…T16 columns were only
  -- ever a spreadsheet's way of expressing a list.
  points            numeric[] not null default '{}',
  avg_thickness     numeric,
  computed_id       numeric,
  ovality           numeric,

  void_status       text not null default '',
  void_reason       text not null default '',
  void_requested_by text not null default '',
  void_requested_at timestamptz,
  voided_by         text not null default '',
  voided_at         timestamptz
);
create index if not exists thickness_pipe_idx on thickness_checks (pipe_code);

create table if not exists notes (
  id        uuid primary key default gen_random_uuid(),
  pipe_code text not null references pipes(pipe_code) on delete cascade,
  section   text not null default '',
  ts        timestamptz not null default now(),
  operator  text not null default '',
  text      text not null default ''
);
create index if not exists notes_pipe_idx on notes (pipe_code);

create table if not exists photos (
  id                uuid primary key default gen_random_uuid(),
  pipe_code         text not null references pipes(pipe_code) on delete cascade,
  section           text not null default '',
  ts                timestamptz not null default now(),
  operator          text not null default '',
  caption           text not null default '',
  -- storage_path is a Supabase Storage object; drive_url is kept so photos taken
  -- before the move still open. New uploads only set storage_path.
  storage_path      text not null default '',
  drive_url         text not null default '',
  drive_file_id     text not null default '',
  problem_report_id uuid
);
create index if not exists photos_pipe_idx on photos (pipe_code);

create table if not exists material_usage (
  id           uuid primary key default gen_random_uuid(),
  pipe_code    text not null references pipes(pipe_code) on delete cascade,
  section      text not null default '',
  ts           timestamptz not null default now(),
  operator     text not null default '',
  material     text not null default '',
  lot_number   text not null default '',
  start_weight numeric,
  end_weight   numeric,
  used_weight  numeric
);
create index if not exists material_pipe_idx on material_usage (pipe_code);

create table if not exists problem_reports (
  id               uuid primary key default gen_random_uuid(),
  pipe_code        text not null references pipes(pipe_code) on delete cascade,
  section          text not null default '',
  ts               timestamptz not null default now(),
  operator         text not null default '',
  footage_marker   numeric,
  description      text not null default '',
  status           text not null default 'Open',   -- 'Open' | 'Resolved'
  resolved_by      text not null default '',
  resolved_at      timestamptz,
  resolution_notes text not null default ''
);
create index if not exists problems_pipe_idx on problem_reports (pipe_code);
-- The dashboard only ever counts the open ones.
create index if not exists problems_open_idx on problem_reports (pipe_code) where status = 'Open';

create table if not exists downtime_events (
  id          uuid primary key default gen_random_uuid(),
  pipe_code   text not null references pipes(pipe_code) on delete cascade,
  section     text not null,
  start_time  timestamptz not null default now(),
  end_time    timestamptz,
  reason_code text not null default '',
  notes       text not null default '',
  operator    text not null default ''
);
create index if not exists downtime_pipe_idx on downtime_events (pipe_code);
-- An open stoppage is the only one the dashboard timer cares about.
create index if not exists downtime_open_idx on downtime_events (pipe_code) where end_time is null;

create table if not exists email_log (
  id        uuid primary key default gen_random_uuid(),
  pipe_code text not null,
  sent_at   timestamptz not null default now(),
  sent_to   text not null default '',
  trigger   text not null default ''
);
create index if not exists email_log_pipe_idx on email_log (pipe_code);

-- ---------------------------------------------------------------------------
-- Lock everything down
-- ---------------------------------------------------------------------------
--
-- Row Level Security is enabled with NO policies, which denies everything to the
-- anon and authenticated roles. Nothing reaches these tables directly from a browser.
--
-- That is the point. In the Sheet, anyone with edit access to the file bypassed every
-- login, role check and void approval in the app — the security model had a door in
-- the back of it. Here the only way in is through the functions in 02_api.sql, which
-- run as the table owner and check the caller's token and role first. The anon key
-- that ships in index.html can call those functions and nothing else.

alter table accounts         enable row level security;
alter table sessions         enable row level security;
alter table settings         enable row level security;
alter table work_orders      enable row level security;
alter table pipes            enable row level security;
alter table readings         enable row level security;
alter table thickness_checks enable row level security;
alter table notes            enable row level security;
alter table photos           enable row level security;
alter table material_usage   enable row level security;
alter table problem_reports  enable row level security;
alter table downtime_events  enable row level security;
alter table email_log        enable row level security;
