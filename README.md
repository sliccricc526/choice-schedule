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

## Access control

The schema ships in **internal-tool mode**: anyone with the app URL can read and edit (the anon key is public by design). Fine for a private link inside the company; when you want real logins, the path is:
1. Enable an auth method in Supabase (email magic links are the least friction).
2. In `supabase/schema.sql`'s policies, change `using (true)` / `with check (true)` to `auth.role() = 'authenticated'` and re-run the policy statements.
3. Add a small sign-in gate in the app (Supabase's `signInWithOtp` is ~20 lines).

## How the engine schedules

- **Leveling off:** pure just-in-time — each unit's final assembly is anchored to the delivery date, paint and fab chain backward through working days. Overloads show in red in the station-load section.
- **Leveling on:** backward list scheduling, latest delivery first. Each operation claims the latest contiguous block of workdays with open capacity, sliding earlier when a day is full. A unit that cannot fit between today and its delivery falls forward from today and reports projected working days late. Capacity is never exceeded, so the load section cannot go red.
- Weekends are non-working. Weekend/overtime modeling, per-day capacity exceptions, and shop closures are natural next steps — the engine's day-by-day capacity map already supports them structurally.
