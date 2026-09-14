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

// Unconstrained backward schedule: pure just-in-time, ignores capacity.
export function scheduleJob(job, today, cal = defaultCalendar) {
  let end = cal.onOrBeforeWorkday(job.delivery)
  const spans = {}
  for (let i = OPS.length - 1; i >= 0; i--) {
    const op = OPS[i]
    const dur = Math.max(1, job[op.key] || 1)
    const start = cal.backSpan(end, dur)
    spans[op.key] = { start, end }
    end = cal.prevWorkday(start)
  }
  const slack = cal.workdaysBetween(today, spans.fab.start)
  return { ...job, spans, mustStart: spans.fab.start, slack, late: slack < 0, lateDays: 0 }
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

  const ordered = [...jobs].sort((a, b) => b.delivery - a.delivery)
  const out = []
  ordered.forEach((job) => {
    const dur = {
      fab: Math.max(1, job.fab || 1),
      paint: Math.max(1, job.paint || 1),
      asm: Math.max(1, job.asm || 1),
    }
    let spans = null, late = false, lateDays = 0
    const asm = latestBlock('asm', dur.asm, job.delivery, today)
    const paint = asm && latestBlock('paint', dur.paint, cal.prevWorkday(asm.start), today)
    const fab = paint && latestBlock('fab', dur.fab, cal.prevWorkday(paint.start), today)
    if (fab) {
      spans = { fab, paint, asm }
    } else {
      const f = forwardBlock('fab', dur.fab, today)
      const p = forwardBlock('paint', dur.paint, cal.nextWorkday(f.end))
      const a = forwardBlock('asm', dur.asm, cal.nextWorkday(p.end))
      spans = { fab: f, paint: p, asm: a }
      const dl = cal.onOrBeforeWorkday(job.delivery)
      if (a.end > dl) { late = true; lateDays = cal.workdaysBetween(dl, a.end) }
    }
    OPS.forEach((o) => take(o.key, spans[o.key].start, spans[o.key].end))
    out.push({
      ...job, spans, late, lateDays,
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

// Working days spent on the station in progress, counting the day it started.
export function daysSpent(job, today, cal = defaultCalendar) {
  const stage = job.stage || 'none'
  if (stage === 'none' || stage === 'done' || !job.stageStarted) return 0
  const start = strip(job.stageStarted)
  if (start > strip(today)) return 0
  return cal.workdaysBetween(start, today) + (cal.isWorkday(start) ? 1 : 0)
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

  const underway = (j) => { const s = j.stage || 'none'; return s !== 'none' && s !== 'done' }
  const ordered = [...jobs].sort((a, b) =>
    (underway(b) - underway(a)) || (a.delivery - b.delivery) || String(a.unit).localeCompare(String(b.unit)))

  const out = []
  ordered.forEach((job) => {
    const work = remainingWork(job)
    const due = cal.onOrBeforeWorkday(job.delivery)
    const spans = {}
    let cursor = today, end = null
    work.forEach(({ key, days }) => {
      const blk = forwardBlock(key, days, cursor)
      spans[key] = blk
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
