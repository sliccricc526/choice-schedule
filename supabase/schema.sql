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

-- Shop calendar. A row overrides the Mon-Fri default for one day: working=false
-- closes the shop (holiday, shutdown), working=true opens a weekend for
-- overtime. Days with no row follow the default, so this table stays small.
create table if not exists public.day_overrides (
  day date primary key,
  working boolean not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- Row Level Security: open to anyone holding the anon key (internal-tool mode).
-- To restrict to logged-in users later, change `using (true)` to
-- `using (auth.role() = 'authenticated')` on each policy and enable
-- Supabase Auth in the app.
alter table public.jobs enable row level security;
alter table public.station_caps enable row level security;
alter table public.day_overrides enable row level security;
alter table public.part_numbers enable row level security;

create policy "jobs open access" on public.jobs
  for all using (true) with check (true);
create policy "caps open access" on public.station_caps
  for all using (true) with check (true);
create policy "days open access" on public.day_overrides
  for all using (true) with check (true);
create policy "parts open access" on public.part_numbers
  for all using (true) with check (true);

-- Live sync between users: publish changes over realtime.
alter publication supabase_realtime add table public.jobs;
alter publication supabase_realtime add table public.station_caps;
alter publication supabase_realtime add table public.day_overrides;
alter publication supabase_realtime add table public.part_numbers;

-- Optional starter data (delete these rows once real units are in):
insert into public.jobs (unit, description, delivery_date, fab_days, paint_days, asm_days) values
  ('CT-551',  '55-ton lowboy',      current_date + 9,  8,  2, 4),
  ('CT-552',  '55-ton lowboy',      current_date + 16, 8,  2, 4),
  ('CT-8014', '80-ton 3+1 RGN',     current_date + 24, 12, 3, 6),
  ('CT-8015', '80-ton 3+1 RGN',     current_date + 31, 12, 3, 6),
  ('OD-207',  'Oilfield drop deck', current_date + 13, 5,  2, 2),
  ('CT-1102', '110-ton extendable', current_date + 42, 16, 4, 8);
