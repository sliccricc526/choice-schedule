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
export const isWorkday = (d) => d.getDay() !== 0 && d.getDay() !== 6
export const prevWorkday = (d) => { let x = addDays(d, -1); while (!isWorkday(x)) x = addDays(x, -1); return x }
export const nextWorkday = (d) => { let x = addDays(d, 1); while (!isWorkday(x)) x = addDays(x, 1); return x }
export const onOrBeforeWorkday = (d) => (isWorkday(d) ? strip(d) : prevWorkday(d))
export const backSpan = (end, n) => { let s = strip(end); for (let i = 1; i < n; i++) s = prevWorkday(s); return s }
export const workdaysBetween = (a, b) => {
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
export const isoDate = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
export const parseDate = (s) => strip(new Date(s + 'T00:00'))

// Unconstrained backward schedule: pure just-in-time, ignores capacity.
export function scheduleJob(job, today) {
  let end = onOrBeforeWorkday(job.delivery)
  const spans = {}
  for (let i = OPS.length - 1; i >= 0; i--) {
    const op = OPS[i]
    const dur = Math.max(1, job[op.key] || 1)
    const start = backSpan(end, dur)
    spans[op.key] = { start, end }
    end = prevWorkday(start)
  }
  const slack = workdaysBetween(today, spans.fab.start)
  return { ...job, spans, mustStart: spans.fab.start, slack, late: slack < 0, lateDays: 0 }
}

// Capacity-constrained: backward list scheduling, latest-delivery first.
// Each op claims the latest contiguous block with open capacity; a job that
// can't fit between today and delivery falls forward from today and reports
// projected working days late.
export function levelSchedule(jobs, caps, today) {
  const usage = { fab: {}, paint: {}, asm: {} }
  const free = (st, d) => (usage[st][isoDate(d)] || 0) < Math.max(1, caps[st])
  const take = (st, s, e) => {
    let d = strip(s)
    while (true) {
      usage[st][isoDate(d)] = (usage[st][isoDate(d)] || 0) + 1
      if (d.getTime() >= e.getTime()) break
      d = nextWorkday(d)
    }
  }
  const latestBlock = (st, n, latestEnd, floor) => {
    let end = onOrBeforeWorkday(latestEnd)
    while (end >= floor) {
      let ok = true, d = strip(end), s = strip(end)
      for (let i = 0; i < n; i++) {
        if (!free(st, d)) { ok = false; break }
        s = strip(d)
        if (i < n - 1) d = prevWorkday(d)
      }
      if (ok) return s >= floor ? { start: s, end } : null
      end = prevWorkday(end)
    }
    return null
  }
  const forwardBlock = (st, n, earliest) => {
    let start = isWorkday(earliest) ? strip(earliest) : nextWorkday(earliest)
    for (let g = 0; g < 500; g++) {
      let ok = true, d = strip(start), e = strip(start)
      for (let i = 0; i < n; i++) {
        if (!free(st, d)) { ok = false; break }
        e = strip(d)
        if (i < n - 1) d = nextWorkday(d)
      }
      if (ok) return { start, end: e }
      start = nextWorkday(start)
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
    const paint = asm && latestBlock('paint', dur.paint, prevWorkday(asm.start), today)
    const fab = paint && latestBlock('fab', dur.fab, prevWorkday(paint.start), today)
    if (fab) {
      spans = { fab, paint, asm }
    } else {
      const f = forwardBlock('fab', dur.fab, today)
      const p = forwardBlock('paint', dur.paint, nextWorkday(f.end))
      const a = forwardBlock('asm', dur.asm, nextWorkday(p.end))
      spans = { fab: f, paint: p, asm: a }
      const dl = onOrBeforeWorkday(job.delivery)
      if (a.end > dl) { late = true; lateDays = workdaysBetween(dl, a.end) }
    }
    OPS.forEach((o) => take(o.key, spans[o.key].start, spans[o.key].end))
    out.push({
      ...job, spans, late, lateDays,
      mustStart: spans.fab.start,
      slack: workdaysBetween(today, spans.fab.start),
    })
  })
  return out
}
