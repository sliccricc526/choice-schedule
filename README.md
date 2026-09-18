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

If you set this up before the shop calendar, the part-number catalog, production tracking or pinned stages existed, run just the `day_overrides`, `part_numbers`, `stage_log` and `alter table public.jobs` blocks from `supabase/schema.sql` against your database — the rest is already there. Without the `*_pinned_start` columns the board still schedules; it just can't be overruled by dragging, and the legend says so. Without those tables the board still works; it shows a note where the day toggles and the catalog button would be.

The same goes for the `alter table public.stage_log` block that adds `started_on` and `finished_on` and drops the `not null` on `actual_days`: without it, closing a station still records the days it took, but the stage-date columns stay empty and they can't be corrected by hand.

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

**Click any column heading to sort by it**; click it again to reverse. Stage sorts in shop order (not started → fabrication → paint → assembly → complete) rather than alphabetically, and Variance, Left and the day counts open largest-first, since "what is worst" is the reason to sort by them. Blanks go to the bottom whichever way a column points, so untagged or not-started units never head the list.

Rows are ordered by target date to begin with, and **hold their place while you type**. Re-sorting on every keystroke would slide a row out from under the cursor as soon as its date passed its neighbour's, and `Enter` would drop into a different unit than the one below. The order settles when you open the table, when units are added or removed, when you pick a column, or when you press **Re-sort**.

Removing a unit is still done from the board: select it and use **Remove unit**.

## Production tracking

The board knows three things about each unit: which station it's on (**Stage**), when it went in (**In stage since**), and how many working days the shop says are left on it (**Left**). Everything else is derived.

**In stage since** is editable, in the table and in the unit panel. Advancing a station stamps today, but back-date it when a unit was already on the floor before anyone entered it here — otherwise a trailer three weeks into fabrication reads as one day spent. It also sets the `actual_days` written to the stage log when that station closes, so the report is only as honest as this date.

- **Projected** — the unit's remaining work scheduled *forward* from today against the same station capacities. Work already on the floor can't be pushed back into the past, so a unit under way starts now. That's what makes the projection differ from the plan.
- **Variance** — projected finish against the target date, in working days. `+3d late` means it lands three working days past its date; `4d slack` means there's that much room before it.

Click a stage chip in the table, or use **Move to …** in the unit panel, to close a station and open the next. Closing one writes a `stage_log` row with its planned and actual days, and with the dates behind them — the day the unit went into the station and the day it came out — **unless the station has no start date**, in which case nothing is recorded. The days it took are unknown, not zero, and logging zero would teach the report that the station takes no time at all.

That is the normal case for units already on the floor when tracking begins: you often can't say when their current station started. Leave the date blank rather than guessing. Those units go uncounted for the station they're on now and start counting at the next one, which does begin under the app.

### The report — switched off

The shop is using this as a scheduling tool, not to run time studies, so the **Report** tab is
hidden: `SHOW_REPORT` at the top of `src/App.jsx` is `false`. Stations carry on recording their
planned and actual days as they close, so the history is accumulating for the day it is wanted —
set the flag to `true` and the tab comes back with everything that has been logged since.

What it shows when it is on, four ways:

- **By station** — how fabrication, paint and assembly each run against their estimates on average. The rule on each bar is what was booked and the fill is what it took, so a fill past the rule is an overrun.
- **By model** — booked against took, per station, grouped by part number (or by the unit's description where it has no part number). This is the one that answers whether an 80-ton RGN really takes twelve fab days.
- **Stage dates — planned against actual** — every unit's three stations with planned start, planned finish, actual start and actual finish side by side, and the working-day difference on each end. A station still open shows where the projection now puts its finish, marked `proj`, rather than a blank. The same four dates are in the unit panel on the board and table views, for one unit at a time — that half is **not** hidden, because knowing when a unit is due into paint is scheduling rather than reporting. It is also where the dates are edited; this table is read-only.
- **Recent closures** — the last 25 stations closed, with the difference on each and the dates it ran between.

Percentages are computed on totals rather than averaged, so a long station counts for more than a short one. A model's figures follow the part number a unit carries *now*, so re-tagging a unit moves its history with it.

The *planned* dates on the stage-date table are the plain just-in-time plan — straight back from the delivery date, capacity ignored. That is deliberate, and it is **not** the levelled plan the board draws when **Level to capacity** is on. Levelling books no work earlier than today, so for a station that has already run it would invent a planned date in the future and the comparison would be meaningless. Just-in-time is defined in the past as well as the future: the latest that station could have run and still made delivery. It also means the table doesn't shift under you when the levelling toggle is flipped. A negative start difference therefore reads as *the station opened earlier than it strictly had to*, not as a problem.

### Correcting the actual dates

Actual dates are stamped as a station closes, which is right when someone clicks **Move to …** the same day and wrong when they click it a week later. They can be corrected in the unit panel, on the board or table view, by typing into the stage-date table there.

What can be corrected depends on the station:

- **Closed** — both dates. The days it took are recounted from them and written back to the log, so the recorded figures can never drift away from the dates shown beside them.
- **On now** — the start only, which is the same value as **In stage since** and **Went into …**; editing either moves the other. It has no finish until it is closed, and closing it is what sets one — a date field that closed a station behind your back would be a nasty surprise.
- **Not started** — neither. Nothing has happened to record.

Clearing both dates on a closed station deletes its log row. Setting only one leaves the days it took unknown: the row keeps the date but records no figure, and the estimate sections of the report leave it out rather than counting it as zero. It still appears in the stage-date table, so it is visible rather than silently dropped.

Stations closed before those two columns existed keep whatever the log has — usually a finish date and no start. Filling in the start writes both down properly and recounts the days from them.

### The calendar

The **Calendar** view is the same book read by date out the door rather than by work in the shop.
Each unit sits on a month grid on the day it is due, with its work-order number, its part number (or
description), and how many working days late the projection says it will be. Clicking one opens it
in the panel below, the same as clicking a row on the board.

Days the shop is closed are shaded. Only days set by hand carry a word — a closed Thanksgiving reads
**closed** and a Saturday opened for overtime reads **open** — because labelling every Saturday
would bury the one that matters. A delivery landing on a shaded day is worth a second look.

The header counts the month's deliveries and how many of them the projection says will miss. With no
deliveries in the month being viewed it says where the work actually is, so an empty grid doesn't
read as a broken one.

### Moving around the board

Once a real book is loaded the board runs well past the edge of the screen. Grab any empty part of
it — a cell, the date row, the station load rows — and pull, the way you would a paper schedule
across a bench.

Anything that already answers to a drag or a click keeps doing so: the bars place stages, the dates
open and close the shop, a row label selects its unit. A pan only counts as a pan once the pointer
has actually moved a few pixels, so a click that wobbles is still a click, and the click that ends a
real pan is swallowed — dragging across the date row must not close every day it passed over.

On a touch screen the browser's own scrolling is left alone. It does momentum and rubber-banding
better than this would, and panning as well would move the board twice as far as the finger.

### Placing a stage by hand

The scheduler picks every date. When it picks wrong — and it will, because it doesn't know the
north bay is tied up or that this trailer has to go on the truck Thursday — drag the stage where it
belongs on the **planned** (upper) lane:

- **Drag the middle** of a bar to move that stage. It lands where you drop it.
- **Drag either edge** to change how long the stage takes. The right edge keeps the start put and
  stretches the finish; the left edge keeps the finish put and moves the start. Either writes the
  station's day count for that unit.

A dragged stage is **pinned**: it keeps a heavier border and a dot, the scheduler stops choosing its
dates, and everything else — this unit's other stages, and every other unit in the shop — is planned
around it. Pins are claimed before anything is scheduled automatically, so a pin always wins.

Resizing pins too. That is deliberate: the plan is built *backward* from the delivery date, so its
finish is the anchored edge. Change only the day count and the scheduler re-places the bar, which
means dragging the right edge rightwards would grow the bar leftwards. Pinning makes the bar end up
where the gesture put it, every time.

The unit panel lists what has been placed by hand and releases it — one stage at a time, or
**Release all**, which hands it all back to the scheduler.

Two things a pin is allowed to do, because refusing would be worse than reporting:

- **Go over capacity.** Three trailers pinned onto one paint day with a cap of one all stay put, and
  the load row goes red. You said so on purpose; the board's job is to show you what it costs.
- **Break the sequence.** Paint pinned across the back of fabrication stays where you put it and the
  unit is flagged **OVERLAP**. Nothing is quietly resequenced behind you.

Dragging changes the day fabrication has to start, which is what the board sorts on — so rows would
leap around under the pointer. The board holds its order instead, settling when units are added or
removed, or when **Re-sort rows** is clicked.

On the board each row carries two lanes: the plan on top (light, outlined), and where the remaining work actually lands underneath (the same station colour, filled solid). A pair therefore reads as one station in two states, which is what the **Plan over projection** key in the legend shows. The lower lane only appears once a unit is under way or is already projected late — an untouched unit shows only its plan, because nothing is happening on it yet.

Colour says *which station*, and nothing else. How late a unit is running is the red `+Nd` flag beside its work-order number, and how far its bars run past the ▼ delivery mark.

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
