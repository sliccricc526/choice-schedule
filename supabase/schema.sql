-- Shop Scheduler schema — run once in the Supabase SQL editor.

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  unit text not null,
  description text not null default '',
  delivery_date date not null,
  fab_days int not null default 1 check (fab_days >= 1),
  paint_days int not null default 1 check (paint_days >= 1),
  asm_days int not null default 1 check (asm_days >= 1),
  created_at timestamptz not null default now()
);

create table if not exists public.station_caps (
  station text primary key check (station in ('fab','paint','asm')),
  cap int not null default 1 check (cap >= 1)
);

insert into public.station_caps (station, cap) values
  ('fab', 2), ('paint', 1), ('asm', 2)
on conflict (station) do nothing;

-- Part-number catalog: the standard build for a trailer model. Selecting one on
-- a unit copies these values onto that unit, so editing a part number later
-- never reschedules trailers already in the shop.
create table if not exists public.part_numbers (
  id uuid primary key default gen_random_uuid(),
  part_number text not null unique,
  description text not null default '',
  fab_days int not null default 1 check (fab_days >= 1),
  paint_days int not null default 1 check (paint_days >= 1),
  asm_days int not null default 1 check (asm_days >= 1),
  created_at timestamptz not null default now()
);

-- Which part number a unit was built from. Kept for reference and drift, not as
-- a live link; clearing the catalog entry leaves the unit's own numbers intact.
alter table public.jobs
  add column if not exists part_number_id uuid references public.part_numbers(id) on delete set null;

-- Production tracking. `stage` is the station a unit is on now and
-- `stage_started` is the day it went on.
--
-- `days_left` holds how many working days that station RUNS IN TOTAL, counted
-- from stage_started -- not the days remaining, despite the name, which is kept
-- so an older deployment reading this table still finds its column. The days
-- remaining are worked out from the two (see daysToGo in src/engine.js), and
-- that is the whole point: a remainder is only true on the day it is typed, so
-- storing one walked every projected finish a day later for every day nobody
-- went down the book decrementing. A run length does not move, so the finish
-- holds still and the remainder counts itself down.
--
-- Everything else -- projected finish, variance -- is derived, so nobody types
-- it and nobody can forget to.
alter table public.jobs
  add column if not exists stage text not null default 'none'
    check (stage in ('none','fab','paint','asm','done')),
  add column if not exists stage_started date,
  add column if not exists days_left int check (days_left is null or days_left >= 0),
  add column if not exists updated_at timestamptz not null default now();

-- Stages placed by hand, by dragging them on the board. A pinned stage keeps
-- the date it was dropped on and the scheduler works everything else around it;
-- null means the scheduler is free to choose, which is the default for all three.
alter table public.jobs
  add column if not exists fab_pinned_start date,
  add column if not exists paint_pinned_start date,
  add column if not exists asm_pinned_start date;

-- How important a unit is, 1 to 10, higher first. It decides who gets a station
-- when two units want the same one, and it outranks the delivery date: a 10
-- takes the next open bay ahead of everything, including work due sooner. 5 is
-- the neutral middle, so a shop that never touches the number is scheduled
-- exactly as it was before this column existed.
alter table public.jobs
  add column if not exists priority integer not null default 5
    check (priority between 1 and 10);

-- Planned against actual, kept as each station closes, so estimates can be
-- checked against what the trailers really took.
create table if not exists public.stage_log (
  job_id uuid not null references public.jobs(id) on delete cascade,
  stage text not null check (stage in ('fab','paint','asm')),
  planned_days int not null,
  actual_days int not null,
  closed_on date not null default current_date,
  primary key (job_id, stage)
);

-- The dates behind those durations: when the station really opened and when it
-- really closed. `closed_on` only ever said when the row was written, which is
-- the same day for a station closed on time and a lie for one caught up on
-- later. Rows written before these columns existed keep null starts -- unknown,
-- not assumed.
alter table public.stage_log
  add column if not exists started_on date,
  add column if not exists finished_on date;

update public.stage_log set finished_on = closed_on where finished_on is null;

-- `actual_days` is derived from those two dates, so it has to be able to say
-- "not known yet" for a station whose dates are only half filled in. A row with
-- no figure is left out of the estimate sections of the report rather than
-- counted as zero.
alter table public.stage_log alter column actual_days drop not null;

-- The steps that make up a station's work on one unit: "cut rails", "weld deck",
-- "install king pin". Steps do not necessarily run one after another -- two
-- welders on different subassemblies work side by side -- so each one names
-- what must finish before it can start, and the station takes as long as the
-- longest chain through them. A station with steps has its day count built
-- rather than typed; a station with no steps keeps its own number, which is
-- how every unit starts.
create table if not exists public.job_steps (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  stage text not null check (stage in ('fab','paint','asm')),
  name text not null default '',
  days int not null default 1 check (days >= 1),
  done boolean not null default false,
  -- The steps this one waits on, by id, within the same unit and station.
  -- Empty means it can start as soon as the station does.
  needs uuid[] not null default '{}',
  -- Working days to hold the step back beyond what it waits on: paint has to
  -- sit before the next man can touch it, or the shop simply wants the work
  -- later than it strictly could be. Set by dragging the step on the board.
  lag int not null default 0 check (lag >= 0),
  -- The order they are listed in, which is the shop's, not the database's.
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists job_steps_job_stage on public.job_steps (job_id, stage, position);

-- Shop calendar. A row overrides the Mon-Fri default for one day: working=false
-- closes the shop (holiday, shutdown), working=true opens a weekend for
-- overtime. Days with no row follow the default, so this table stays small.
create table if not exists public.day_overrides (
  day date primary key,
  working boolean not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- Row Level Security: signed-in users only.
--
-- `to authenticated` is what actually protects the data. The anon key ships
-- inside the public JavaScript bundle by design, so a policy granted to the
-- `public` role lets anyone who opens the page read and write every table
-- straight through the REST API — the sign-in screen would just be decoration.
-- Granting to `authenticated` means a request has to carry a real session
-- token, which only a successful sign-in produces.
--
-- Accounts are created in the Supabase dashboard (Authentication -> Users ->
-- Add user, with Auto Confirm on). Leave public signups disabled so nobody can
-- enrol themselves.
alter table public.jobs enable row level security;
alter table public.station_caps enable row level security;
alter table public.day_overrides enable row level security;
alter table public.part_numbers enable row level security;
alter table public.stage_log enable row level security;
alter table public.job_steps enable row level security;

create policy "jobs team access" on public.jobs
  for all to authenticated using (true) with check (true);
create policy "caps team access" on public.station_caps
  for all to authenticated using (true) with check (true);
create policy "days team access" on public.day_overrides
  for all to authenticated using (true) with check (true);
create policy "parts team access" on public.part_numbers
  for all to authenticated using (true) with check (true);
create policy "stage log team access" on public.stage_log
  for all to authenticated using (true) with check (true);
create policy "job steps team access" on public.job_steps
  for all to authenticated using (true) with check (true);

-- Live sync between users: publish changes over realtime.
alter publication supabase_realtime add table public.jobs;
alter publication supabase_realtime add table public.station_caps;
alter publication supabase_realtime add table public.day_overrides;
alter publication supabase_realtime add table public.part_numbers;
-- Without this a station closed on one screen leaves the report stale on every
-- other one until the page is reloaded.
alter publication supabase_realtime add table public.stage_log;
alter publication supabase_realtime add table public.job_steps;

-- Optional starter data (delete these rows once real units are in):
insert into public.jobs (unit, description, delivery_date, fab_days, paint_days, asm_days) values
  ('CT-551',  '55-ton lowboy',      current_date + 9,  8,  2, 4),
  ('CT-552',  '55-ton lowboy',      current_date + 16, 8,  2, 4),
  ('CT-8014', '80-ton 3+1 RGN',     current_date + 24, 12, 3, 6),
  ('CT-8015', '80-ton 3+1 RGN',     current_date + 31, 12, 3, 6),
  ('OD-207',  'Oilfield drop deck', current_date + 13, 5,  2, 2),
  ('CT-1102', '110-ton extendable', current_date + 42, 16, 4, 8);
