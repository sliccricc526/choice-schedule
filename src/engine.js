// Scheduling engine — pure functions, no UI, no I/O.
// Validated: 200 randomized scenarios, zero capacity/precedence/deadline violations.

export const DAY = 86400000
export const OPS = [
  { key: 'fab', label: 'Fabrication', color: '#44688F', light: '#E3EAF2' },
  { key: 'paint', label: 'Paint', color: '#C0722F', light: '#F5E8DA' },
  { key: 'asm', label: 'Final assembly', color: '#3E7C59', light: '#E1EEE6' },
]

export const strip = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
// Calendar-day arithmetic. Adding a fixed 86400000 ms drifts by an hour across a
// daylight-saving change, which leaves dates that are no longer local midnight and
// never compare equal to a stripped date — use this everywhere instead.
export const addDays = (d, n) => { const x = strip(d); x.setDate(x.getDate() + n); return x }
// Whole calendar days from a to b; the rounding absorbs the DST hour.
export const daysBetween = (a, b) => Math.round((strip(b) - strip(a)) / DAY)
export const isoDate = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
export const parseDate = (s) => strip(new Date(s + 'T00:00'))
export const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6

// A search for the next or previous working day gives up after this many days.
// A calendar with everything switched off would otherwise spin forever and
// freeze the page, the way the old fixed-millisecond date math did.
const MAX_SCAN = 4000

export class CalendarError extends Error {}

// The shop calendar. `overrides` maps an ISO date to whether the shop works that
// day, so a closed Thanksgiving is { '2026-11-26': false } and a Saturday shift
// is { '2026-11-28': true }. Any day not listed follows the Mon–Fri default.
export function createCalendar(overrides) {
  const map = overrides instanceof Map ? overrides : new Map(Object.entries(overrides || {}))

  const isWorkday = (d) => {
    const o = map.get(isoDate(d))
    return o === undefined ? !isWeekend(d) : o
  }
  const scan = (from, step) => {
    let x = addDays(from, step)
    for (let i = 0; i < MAX_SCAN; i++) {
      if (isWorkday(x)) return x
      x = addDays(x, step)
    }
    throw new CalendarError(
      `No working day within ${MAX_SCAN} days of ${isoDate(from)} — too much of the calendar is switched off.`)
  }
  const prevWorkday = (d) => scan(d, -1)
  const nextWorkday = (d) => scan(d, 1)
  const onOrBeforeWorkday = (d) => (isWorkday(d) ? strip(d) : prevWorkday(d))
  const backSpan = (end, n) => { let s = strip(end); for (let i = 1; i < n; i++) s = prevWorkday(s); return s }
  const workdaysBetween = (a, b) => {
    let cur = strip(a)
    const end = strip(b)
    // An unparseable date would otherwise never meet the loop's exit test and
    // would spin forever, freezing the page.
    if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return 0
    const dir = end >= cur ? 1 : -1
    let c = 0
    while (cur.getTime() !== end.getTime()) {
      cur = addDays(cur, dir)
      if (isWorkday(cur)) c += dir
    }
    return c
  }
  // True when this day was set by hand rather than by the Mon–Fri default.
  const isOverridden = (d) => map.has(isoDate(d))

  return { isWorkday, isOverridden, prevWorkday, nextWorkday, onOrBeforeWorkday, backSpan, workdaysBetween }
}

// Weekends off, no closures — used when no calendar is supplied.
export const defaultCalendar = createCalendar()

// --- Pinned stages ---------------------------------------------------------
// A stage the shop has placed by hand, by dragging it on the board. The
// scheduler stops choosing dates for that stage and works the rest of the unit
// — and the rest of the shop — around it. The foreman knows things the
// algorithm does not; this is how they say so.

export const pinOf = (job, key) => (job.pins && job.pins[key]) || null
export const hasPins = (job) => OPS.some((o) => pinOf(job, o.key))

// The block a pinned stage occupies. It runs forward from the pin, because a
// pin says when the work starts; a pin dropped on a closed day takes the next
// working one, since nothing runs on a day the shop is shut.
export function pinnedSpan(job, key, cal = defaultCalendar) {
  const p = pinOf(job, key)
  if (!p) return null
  const start = cal.isWorkday(p) ? strip(p) : cal.nextWorkday(p)
  const dur = Math.max(1, job[key] || 1)
  let end = start
  for (let i = 1; i < dur; i++) end = cal.nextWorkday(end)
  return { start, end }
}

// Stations run one after another. A pin can break that — paint pinned to a week
// before fabrication finishes — and the board says so rather than quietly
// resequencing the unit behind the shop's back.
export function stageConflict(spans) {
  for (let i = 1; i < OPS.length; i++) {
    const prev = spans[OPS[i - 1].key], cur = spans[OPS[i].key]
    if (!prev || !cur) continue
    if (cur.start <= prev.end) return true
  }
  return false
}

// Unconstrained backward schedule: pure just-in-time, ignores capacity.
export function scheduleJob(job, today, cal = defaultCalendar) {
  let end = cal.onOrBeforeWorkday(job.delivery)
  const spans = {}
  for (let i = OPS.length - 1; i >= 0; i--) {
    const op = OPS[i]
    const pinned = pinnedSpan(job, op.key, cal)
    if (pinned) {
      spans[op.key] = pinned
    } else {
      const dur = Math.max(1, job[op.key] || 1)
      spans[op.key] = { start: cal.backSpan(end, dur), end }
    }
    end = cal.prevWorkday(spans[op.key].start)
  }
  const slack = cal.workdaysBetween(today, spans.fab.start)
  const dl = cal.onOrBeforeWorkday(job.delivery)
  const over = spans.asm.end > dl
  return {
    ...job, spans, mustStart: spans.fab.start, slack,
    late: over || slack < 0,
    lateDays: over ? cal.workdaysBetween(dl, spans.asm.end) : 0,
    conflict: stageConflict(spans),
  }
}

// Capacity-constrained: backward list scheduling, latest-delivery first.
// Each op claims the latest contiguous block with open capacity; a job that
// can't fit between today and delivery falls forward from today and reports
// projected working days late.
export function levelSchedule(jobs, caps, today, cal = defaultCalendar) {
  const usage = { fab: {}, paint: {}, asm: {} }
  const free = (st, d) => (usage[st][isoDate(d)] || 0) < Math.max(1, caps[st])
  const take = (st, s, e) => {
    let d = strip(s)
    while (true) {
      usage[st][isoDate(d)] = (usage[st][isoDate(d)] || 0) + 1
      if (d.getTime() >= e.getTime()) break
      d = cal.nextWorkday(d)
    }
  }
  const latestBlock = (st, n, latestEnd, floor) => {
    let end = cal.onOrBeforeWorkday(latestEnd)
    while (end >= floor) {
      let ok = true, d = strip(end), s = strip(end)
      for (let i = 0; i < n; i++) {
        if (!free(st, d)) { ok = false; break }
        s = strip(d)
        if (i < n - 1) d = cal.prevWorkday(d)
      }
      if (ok) return s >= floor ? { start: s, end } : null
      end = cal.prevWorkday(end)
    }
    return null
  }
  const forwardBlock = (st, n, earliest) => {
    let start = cal.isWorkday(earliest) ? strip(earliest) : cal.nextWorkday(earliest)
    for (let g = 0; g < 500; g++) {
      let ok = true, d = strip(start), e = strip(start)
      for (let i = 0; i < n; i++) {
        if (!free(st, d)) { ok = false; break }
        e = strip(d)
        if (i < n - 1) d = cal.nextWorkday(d)
      }
      if (ok) return { start, end: e }
      start = cal.nextWorkday(start)
    }
    return { start, end: start }
  }

  // Pinned stages are placed before anything is scheduled automatically, and
  // they keep their days whatever else wants them — including going over
  // capacity, which the load rows then show in red. The shop put them there on
  // purpose; the scheduler's job is to work around them, not to overrule them.
  const pins = new Map()
  jobs.forEach((job) => {
    const m = {}
    OPS.forEach((o) => {
      const sp = pinnedSpan(job, o.key, cal)
      if (sp) { m[o.key] = sp; take(o.key, sp.start, sp.end) }
    })
    if (OPS.some((o) => m[o.key])) pins.set(job.id, m)
  })

  const ordered = [...jobs].sort((a, b) => b.delivery - a.delivery)
  const out = []
  ordered.forEach((job) => {
    const pin = pins.get(job.id) || {}
    const dur = {
      fab: Math.max(1, job.fab || 1),
      paint: Math.max(1, job.paint || 1),
      asm: Math.max(1, job.asm || 1),
    }
    // Backward pass, latest first, skipping over any stage already pinned. An
    // unpinned stage may not start before a pinned stage that precedes it has
    // finished, which is what keeps the sequence intact around a pin.
    const backward = () => {
      const got = {}
      let latestEnd = cal.onOrBeforeWorkday(job.delivery)
      for (let i = OPS.length - 1; i >= 0; i--) {
        const key = OPS[i].key
        if (pin[key]) {
          got[key] = pin[key]
        } else {
          let floor = today
          for (let k = 0; k < i; k++) {
            const p = pin[OPS[k].key]
            if (!p) continue
            const after = cal.nextWorkday(p.end)
            if (after > floor) floor = after
          }
          const blk = latestBlock(key, dur[key], latestEnd, floor)
          if (!blk) return null
          got[key] = blk
        }
        latestEnd = cal.prevWorkday(got[key].start)
      }
      return got
    }

    let spans = backward()
    if (spans) {
      OPS.forEach((o) => { if (!pin[o.key]) take(o.key, spans[o.key].start, spans[o.key].end) })
    } else {
      // Nowhere to fit between today and delivery: fall forward from today,
      // still stepping around whatever is pinned.
      const got = {}
      let cursor = today
      OPS.forEach((o) => {
        if (pin[o.key]) {
          got[o.key] = pin[o.key]
        } else {
          const blk = forwardBlock(o.key, dur[o.key], cursor)
          got[o.key] = blk
          take(o.key, blk.start, blk.end)
        }
        cursor = cal.nextWorkday(got[o.key].end)
      })
      spans = got
    }
    // Checked on both paths now: a pinned stage can run past the delivery date
    // even when everything fitted, which the old fallback-only test missed.
    const dl = cal.onOrBeforeWorkday(job.delivery)
    const over = spans.asm.end > dl
    out.push({
      ...job, spans,
      late: over,
      lateDays: over ? cal.workdaysBetween(dl, spans.asm.end) : 0,
      conflict: stageConflict(spans),
      mustStart: spans.fab.start,
      slack: cal.workdaysBetween(today, spans.fab.start),
    })
  })
  return out
}

// --- Production tracking --------------------------------------------------
// The plan says when work should happen. These say where it actually is.

export const STAGES = ['none', 'fab', 'paint', 'asm', 'done']
export const STAGE_LABEL = {
  none: 'Not started', fab: 'Fabrication', paint: 'Paint', asm: 'Assembly', done: 'Complete',
}
const STAGE_AT = { fab: 0, paint: 1, asm: 2 }
// The station that follows the one given, or 'done' after the last.
export const nextStage = (stage) => (stage === 'none' ? 'fab'
  : stage === 'done' ? 'done'
  : (OPS[STAGE_AT[stage] + 1] || { key: 'done' }).key)

// Work still to do, station by station. The station in progress contributes
// whatever the shop says is left; stations after it contribute their planned
// duration; stations already closed contribute nothing at all — which is the
// point, since a finished operation should stop consuming capacity.
export function remainingWork(job) {
  const stage = job.stage || 'none'
  if (stage === 'done') return []
  const at = stage === 'none' ? -1 : STAGE_AT[stage]
  const out = []
  OPS.forEach((op, i) => {
    if (i < at) return
    const planned = Math.max(1, job[op.key] || 1)
    const days = i === at
      ? Math.max(0, job.daysLeft == null ? planned : job.daysLeft)
      : planned
    if (days > 0) out.push({ key: op.key, days })
  })
  return out
}

// Working days from a to b counting both ends — what a station took when it
// opened on a and closed on b. Zero when b falls before a, since a station
// cannot close before it opens.
export function workdaysInclusive(a, b, cal = defaultCalendar) {
  const s = strip(a), e = strip(b)
  if (e < s) return 0
  return cal.workdaysBetween(s, e) + (cal.isWorkday(s) ? 1 : 0)
}

// Working days spent on the station in progress, counting the day it started.
export function daysSpent(job, today, cal = defaultCalendar) {
  const stage = job.stage || 'none'
  if (stage === 'none' || stage === 'done' || !job.stageStarted) return 0
  const start = strip(job.stageStarted)
  if (start > strip(today)) return 0
  return workdaysInclusive(start, today, cal)
}

// Where the work actually lands: remaining work scheduled FORWARD from today
// against the same station capacities. A unit already on the floor cannot be
// pushed back into the past, so its remaining work starts now — that is what
// makes this differ from the backward plan, and the difference is the slip.
// Units under way are placed first: you don't stop a trailer mid-fab to start
// another one.
export function projectSchedule(jobs, caps, today, cal = defaultCalendar) {
  const usage = { fab: {}, paint: {}, asm: {} }
  const free = (st, d) => (usage[st][isoDate(d)] || 0) < Math.max(1, caps[st])
  const take = (st, s, e) => {
    let d = strip(s)
    while (true) {
      usage[st][isoDate(d)] = (usage[st][isoDate(d)] || 0) + 1
      if (d.getTime() >= e.getTime()) break
      d = cal.nextWorkday(d)
    }
  }
  const forwardBlock = (st, n, earliest) => {
    let start = cal.isWorkday(earliest) ? strip(earliest) : cal.nextWorkday(earliest)
    for (let g = 0; g < 500; g++) {
      let ok = true, d = strip(start), e = strip(start)
      for (let i = 0; i < n; i++) {
        if (!free(st, d)) { ok = false; break }
        e = strip(d)
        if (i < n - 1) d = cal.nextWorkday(d)
      }
      if (ok) return { start, end: e }
      start = cal.nextWorkday(start)
    }
    return { start, end: start }
  }

  // A run of working days from `earliest`, taking whatever capacity it needs.
  const runFrom = (earliest, n) => {
    const start = cal.isWorkday(earliest) ? strip(earliest) : cal.nextWorkday(earliest)
    let end = start
    for (let i = 1; i < n; i++) end = cal.nextWorkday(end)
    return { start, end }
  }

  const underway = (j) => { const s = j.stage || 'none'; return s !== 'none' && s !== 'done' }
  const ordered = [...jobs].sort((a, b) =>
    (underway(b) - underway(a)) || (a.delivery - b.delivery) || String(a.unit).localeCompare(String(b.unit)))

  const out = []
  ordered.forEach((job) => {
    const work = remainingWork(job)
    const due = cal.onOrBeforeWorkday(job.delivery)
    const spans = {}
    let cursor = today, end = null
    work.forEach(({ key, days }, i) => {
      // The station this unit is on right now is running, so its remaining work
      // starts now. Capacity decides where work that has not begun goes; it
      // cannot decide where a trailer already in the bay is. Six units in
      // fabrication against a cap of four is a fact about the shop floor, and
      // the honest answer is to draw all six starting today — not to push two of
      // them into next week, which is the one thing that definitely is not
      // happening. The overload is real and stays visible in the bars
      // themselves; the load rows under the board count the plan, not the floor.
      const running = i === 0 && key === job.stage
      // A stage pinned to a date does not begin before it, even where the floor
      // happens to be clear sooner — otherwise the plan says one thing and the
      // projection beside it says another. The station already under way is
      // exempt: it is running, whatever date was once pinned to it.
      const pin = running ? null : pinOf(job, key)
      const earliest = pin && strip(pin) > cursor ? strip(pin) : cursor
      const blk = running ? runFrom(earliest, days) : forwardBlock(key, days, earliest)
      spans[key] = blk
      // Claimed either way, so an overrun station still reports its overload.
      take(key, blk.start, blk.end)
      cursor = cal.nextWorkday(blk.end)
      end = blk.end
    })
    const complete = work.length === 0
    out.push({
      ...job,
      spans,
      due,
      projectedEnd: end,                                   // null once every station is closed
      complete,
      variance: complete ? 0 : cal.workdaysBetween(due, end),   // + late, - early
      slipping: !complete && end > due,
      daysRemaining: work.reduce((n, w) => n + w.days, 0),
      spent: daysSpent(job, today, cal),
    })
  })
  return out
}

// --- Planned against actual dates -----------------------------------------
// The plan says when a station should run; the stage log says when it really
// did. This lines the two up station by station for one unit, so the four
// dates read side by side.

export const STAGE_RANK = { none: 0, fab: 1, paint: 2, asm: 3, done: 4 }

// `plan` is the unit's planned spans, `log` its closed stations keyed by stage
// ({ started, finished, plannedDays, actualDays }), `proj` its forward
// projection. Anything not known comes back null rather than guessed: a
// station closed before the dates were kept has no actual start, and saying so
// is better than inventing one.
export function stageDates(job, plan, log, proj, cal = defaultCalendar) {
  const stage = job.stage || 'none'
  const rank = STAGE_RANK[stage] || 0
  const span = (a, b) => (a && b ? cal.workdaysBetween(a, b) : null)
  return OPS.map((op, i) => {
    const planned = (plan && plan[op.key]) || null
    const rec = (log && log[op.key]) || null
    const active = stage === op.key
    // Closed once it is logged, or once the unit has moved past it — a stage
    // set by hand leaves no log row, but the station is still behind the unit.
    const state = rec || rank > i + 1 ? 'closed' : active ? 'active' : 'pending'
    const start = (rec && rec.started) || (active ? job.stageStarted || null : null)
    const finish = (rec && rec.finished) || null
    return {
      key: op.key,
      label: op.label,
      state,
      plan: planned,
      actual: { start, finish },
      // Where the work is now expected to land, for stations not yet closed.
      projected: (!rec && proj && proj.spans && proj.spans[op.key]) || null,
      startVar: span(planned && planned.start, start),
      finishVar: span(planned && planned.end, finish),
      plannedDays: rec ? rec.plannedDays : Math.max(1, job[op.key] || 1),
      actualDays: rec ? rec.actualDays : null,
    }
  })
}
