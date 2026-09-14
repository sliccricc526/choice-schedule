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

If you set this up before the shop calendar, the part-number catalog or production tracking existed, run just the `day_overrides`, `part_numbers`, `stage_log` and `alter table public.jobs` blocks from `supabase/schema.sql` against your database — the rest is already there. Without those tables the board still works; it shows a note where the day toggles and the catalog button would be.

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

## Board and table

Two views of the same plan, switched from the header.

**Board** is the Gantt: bars per operation, the day axis, station load, and the day toggles.

**Table** is for working through the book — every unit as a row with its target date in the second column. Type a date and press <kbd>Enter</kbd> to drop to the next one; tabbing would cross every other field first. Unit, part number, description and the three durations are editable in the same row, and the computed fabrication start and slack/late status sit at the end, read-only.

Rows are ordered by target date but **hold their place while you type**. Re-sorting on every keystroke would slide a row out from under the cursor as soon as its date passed its neighbour's, and `Enter` would drop into a different unit than the one below. The order settles when you open the table, when units are added or removed, or when you press **Re-sort by date**.

Removing a unit is still done from the board: select it and use **Remove unit**.

## Production tracking

The board knows three things about each unit: which station it's on (**Stage**), when it went in (**In stage since**), and how many working days the shop says are left on it (**Left**). Everything else is derived.

**In stage since** is editable, in the table and in the unit panel. Advancing a station stamps today, but back-date it when a unit was already on the floor before anyone entered it here — otherwise a trailer three weeks into fabrication reads as one day spent. It also sets the `actual_days` written to the stage log when that station closes, so the report is only as honest as this date.

- **Projected** — the unit's remaining work scheduled *forward* from today against the same station capacities. Work already on the floor can't be pushed back into the past, so a unit under way starts now. That's what makes the projection differ from the plan.
- **Variance** — projected finish against the target date, in working days. `+3d late` means it lands three working days past its date; `4d slack` means there's that much room before it.

Click a stage chip in the table, or use **Move to …** in the unit panel, to close a station and open the next. Closing one writes a `stage_log` row with its planned and actual days.

### The report

The **Report** view reads that log back three ways:

- **By station** — how fabrication, paint and assembly each run against their estimates on average. The rule on each bar is what was booked and the fill is what it took, so a fill past the rule is an overrun.
- **By model** — booked against took, per station, grouped by part number (or by the unit's description where it has no part number). This is the one that answers whether an 80-ton RGN really takes twelve fab days.
- **Recent closures** — the last 25 stations closed, with the difference on each.

Percentages are computed on totals rather than averaged, so a long station counts for more than a short one. A model's figures follow the part number a unit carries *now*, so re-tagging a unit moves its history with it.

On the board each row carries two lanes: the plan on top (outlined), and where the remaining work actually lands underneath (solid, red when it runs past the target). The lower lane only appears once a unit is under way or is already projected late — an untouched unit shows only its plan, because nothing is happening on it yet.

Two things worth knowing about the semantics:

- **A closed station stops consuming capacity.** That's the whole reason the projection is a separate pass rather than the existing backward schedule, which floors every operation at one day.
- **For a unit nobody has started, Variance is "earliest possible finish vs target".** Positive means it can no longer be built in time even starting today; negative is float. That's why it reads *slack* rather than *early*.

Tracking degrades gracefully: without the `stage` columns on `jobs`, the board runs exactly as it did before and the tracking columns don't appear.

## Part numbers

A part number is the standard build for a trailer model — a description plus working days for fabrication, paint and final assembly. **Edit part numbers** under the board opens the catalog; **Add unit** lets you start a new build from one instead of from blanks.

Selecting a part number **copies** its values onto that unit rather than linking them. Editing a part number later therefore never reschedules trailers already in the shop — a deliberate choice, since a routing change shouldn't silently move work that's underway. Each unit keeps a reference to the part number it came from, so the board tags the row and the unit panel offers **Reset to standard** whenever a unit's numbers have been tuned away from the catalog's.

## Access control

The board is behind an email-and-password sign-in. Signing out clears what's on screen, and no data is requested until a session exists.

**The sign-in screen is not what protects the data.** The anon key ships inside the public JavaScript bundle by design, so anyone who opens the page can read it out and call the REST API directly. What protects the data is that every policy in `supabase/schema.sql` is granted `to authenticated` — a request without a real session token matches no policy and comes back empty. Keep it that way: a policy granted to `public` (or `using (true)` with no role) reopens the whole database no matter what the UI does.

### Managing accounts

There are no public signups — nobody can enrol themselves. Add people in the Supabase dashboard:

1. **Authentication → Users → Add user**.
2. Enter their email and an initial password, and tick **Auto Confirm User** (without it they'd need a confirmation email, which needs SMTP set up).
3. Send them the address, their password, and the app URL.

Removing someone is the same screen — delete the user and their session stops working. Under **Authentication → Providers → Email**, leave *Enable signup* off so the signup endpoint stays closed.

### Passwords

Signed-in users can set their own password from **Change password** in the header. It asks for the current password first, so a session left open on a shop machine isn't enough on its own to take an account over. Minimum 8 characters.

Hand out a temporary password when you create the account and let people change it on first sign-in. There is **no self-serve reset** — that would need an email link, and sending email needs an SMTP provider configured in Supabase, which this project deliberately doesn't have. So a forgotten password means you resetting it from **Authentication → Users**. If that becomes a nuisance, configuring SMTP and turning on the invite and recovery emails is the fix.

## How the engine schedules

- **Leveling off:** pure just-in-time — each unit's final assembly is anchored to the delivery date, paint and fab chain backward through working days. Overloads show in red in the station-load section.
- **Leveling on:** backward list scheduling, latest delivery first. Each operation claims the latest contiguous block of workdays with open capacity, sliding earlier when a day is full. A unit that cannot fit between today and its delivery falls forward from today and reports projected working days late. Capacity is never exceeded, so the load section cannot go red.
- **The shop calendar:** Monday–Friday are working days by default. Click any date in the board's header row to close it (a holiday or a shutdown) or to open it (a Saturday overtime shift). Closures are shaded like weekends and carry an amber underline so a closed Thursday reads differently from a normal weekend; the schedule reflows immediately and the change syncs to every open board. Days left at their default store no row, so the table stays small.
- Per-day capacity exceptions (a half-staffed Friday rather than a fully closed one) are the natural next step — the engine's day-by-day capacity map already supports them structurally.
