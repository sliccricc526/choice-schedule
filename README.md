# Shop Scheduler

Finite-capacity production scheduling for a three-stage shop (fabrication → paint → final assembly). Units are scheduled **backward from their delivery date** through working days; with leveling on, the engine respects per-station capacity, pulls work earlier only when a day is full, and flags units that cannot make their date with projected days late. All data lives in Supabase, so everyone sees one live board — edits sync to every open screen in real time.

## Stack

- React 18 + Vite
- Supabase (Postgres + Realtime)
- Scheduling engine in `src/engine.js` — pure functions, no I/O, validated against 200 randomized scenarios for capacity/precedence/deadline correctness

## Setup

### 1. Supabase (5 minutes)
1. Create a project at supabase.com (or reuse an existing one).
2. Open the SQL editor, paste the contents of `supabase/schema.sql`, run it once.
3. From Project Settings → API, copy the **Project URL** and **anon public key**.

If you set this up before the shop calendar or the part-number catalog existed, run just the `day_overrides` and `part_numbers` blocks from `supabase/schema.sql` against your database — the rest is already there. Without those tables the board still works; it shows a note where the day toggles and the catalog button would be.

### 2. Local dev
```bash
npm install
cp .env.example .env    # paste your URL + anon key into .env
npm run dev
```

### 3. Deploy (Vercel — same flow as your other projects)
1. Push this folder to a GitHub repo.
2. Vercel dashboard → Add New → Project → import the repo (Vite is auto-detected).
3. Add two environment variables: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Deploy. Share the URL with the shop.

## Part numbers

A part number is the standard build for a trailer model — a description plus working days for fabrication, paint and final assembly. **Edit part numbers** under the board opens the catalog; **Add unit** lets you start a new build from one instead of from blanks.

Selecting a part number **copies** its values onto that unit rather than linking them. Editing a part number later therefore never reschedules trailers already in the shop — a deliberate choice, since a routing change shouldn't silently move work that's underway. Each unit keeps a reference to the part number it came from, so the board tags the row and the unit panel offers **Reset to standard** whenever a unit's numbers have been tuned away from the catalog's.

## Access control

The schema ships in **internal-tool mode**: anyone with the app URL can read and edit (the anon key is public by design). Fine for a private link inside the company; when you want real logins, the path is:
1. Enable an auth method in Supabase (email magic links are the least friction).
2. In `supabase/schema.sql`'s policies, change `using (true)` / `with check (true)` to `auth.role() = 'authenticated'` and re-run the policy statements.
3. Add a small sign-in gate in the app (Supabase's `signInWithOtp` is ~20 lines).

## How the engine schedules

- **Leveling off:** pure just-in-time — each unit's final assembly is anchored to the delivery date, paint and fab chain backward through working days. Overloads show in red in the station-load section.
- **Leveling on:** backward list scheduling, latest delivery first. Each operation claims the latest contiguous block of workdays with open capacity, sliding earlier when a day is full. A unit that cannot fit between today and its delivery falls forward from today and reports projected working days late. Capacity is never exceeded, so the load section cannot go red.
- **The shop calendar:** Monday–Friday are working days by default. Click any date in the board's header row to close it (a holiday or a shutdown) or to open it (a Saturday overtime shift). Closures are shaded like weekends and carry an amber underline so a closed Thursday reads differently from a normal weekend; the schedule reflows immediately and the change syncs to every open board. Days left at their default store no row, so the table stays small.
- Per-day capacity exceptions (a half-staffed Friday rather than a fully closed one) are the natural next step — the engine's day-by-day capacity map already supports them structurally.
