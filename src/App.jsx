import { useState, useMemo, useEffect, useLayoutEffect, useCallback, useRef, Fragment, cloneElement } from 'react'
import { supabase, configured } from './supabase.js'
import {
  OPS, strip, addDays, daysBetween, isWeekend, createCalendar, scheduleJob, levelSchedule,
  isoDate, parseDate, projectSchedule, nextStage, daysSpent, STAGE_LABEL, STAGE_RANK, stageDates,
  workdaysInclusive, hasPins, stepPlan, stepSpans, stepLanes, stepDependsOn,
} from './engine.js'

const COL = 26
const SHORT = { fab: 'Fab', paint: 'Paint', asm: 'Assembly' }
const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
// The same date, written the way a date field writes it. Anywhere a calculated
// date sits beside one that is typed in, "Oct 5" next to 09/07/2026 reads as a
// different kind of value -- a note rather than a date -- so the two columns
// are spelled the same. The board keeps the short form: there it is a label on
// a bar, not a figure to compare against the one next to it.
const fmtNum = (d) => d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })

const underway = (j) => j.stage && j.stage !== 'none' && j.stage !== 'done'

// What a cell needs in order to show everything in it. The browser will not
// answer this: an input is as wide as its CSS says whatever text is inside it,
// so the text is measured directly and the boxes around it added back on.
const measureText = (() => {
  let ctx = null
  return (text, s) => {
    if (!text) return 0
    if (!ctx) ctx = document.createElement('canvas').getContext('2d')
    ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
    // what is drawn, not what is in the DOM -- a chip holds "Fabrication" and
    // shows FABRICATION, which is wider
    const shown = s.textTransform === 'uppercase' ? text.toUpperCase()
      : s.textTransform === 'lowercase' ? text.toLowerCase() : text
    return ctx.measureText(shown).width + (parseFloat(s.letterSpacing) || 0) * shown.length
  }
})()

const fitWidth = (node) => {
  const s = getComputedStyle(node)
  // Margins count: a stage chip carries one from the rule it is built on, and
  // a column fitted without it wraps the chip onto two lines.
  const box = parseFloat(s.paddingLeft) + parseFloat(s.paddingRight)
    + parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth)
    + parseFloat(s.marginLeft) + parseFloat(s.marginRight)
  if (node.tagName === 'INPUT' || node.tagName === 'SELECT') {
    // a date field and a select both draw a control the text knows nothing of
    const control = node.tagName === 'SELECT' || node.type === 'date' ? 26 : 2
    const text = node.tagName === 'SELECT'
      ? ((node.options[node.selectedIndex] || {}).text || '')
      : node.type === 'date' ? '00/00/0000' : node.value
    return measureText(text, s) + box + control
  }
  const kids = [...node.childNodes]
    .filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()))
  // Nothing to measure means the element is sized by its CSS, not by what is
  // in it -- the spacer that keeps a unit without steps lined up, the dot on a
  // stage chip. Its laid-out width is the honest answer. Only for the empty
  // ones: anything holding text may have been stretched by the column it is
  // already in, and asking it how wide it is would just give that width back.
  if (!kids.length) return Math.max(box, node.offsetWidth || 0)
  const sizes = kids.map((n) => (n.nodeType === 3 ? measureText(n.textContent.trim(), s) : fitWidth(n)))
  // Only a flex column stacks its children. Everything else in this table runs
  // across, so the widths add up rather than the widest one deciding.
  const stacked = s.display.includes('flex') && s.flexDirection.startsWith('column')
  return box + (stacked
    ? Math.max(...sizes)
    : sizes.reduce((a, b) => a + b, 0) + (parseFloat(s.columnGap) || 0) * (kids.length - 1))
}

// The stage-log report is time study, not scheduling, and the shop is not using
// it yet. Closures carry on being recorded either way, so the history is there
// the day it is wanted — set this to true to put the tab back.
const SHOW_REPORT = false

export default function App() {
  const today = useMemo(() => strip(new Date()), [])
  const [jobs, setJobs] = useState([])
  const [caps, setCaps] = useState({ fab: 2, paint: 1, asm: 2 })
  // ISO date -> whether the shop works that day, overriding the Mon–Fri default.
  const [dayOverrides, setDayOverrides] = useState(() => new Map())
  // False when the day_overrides table isn't there yet, so the board still works.
  const [calendarEnabled, setCalendarEnabled] = useState(true)
  // Part-number catalog: the standard build for each trailer model.
  const [parts, setParts] = useState([])
  const [partsEnabled, setPartsEnabled] = useState(true)
  const [showParts, setShowParts] = useState(false)
  const [addPart, setAddPart] = useState('')
  // Off by default. The levelled plan books no work earlier than today, which
  // is the right answer for a plan but wrong for reading a shop that is already
  // running late — it pretends every overdue unit starts this morning. Plain
  // just-in-time shows what each unit actually needed, and the shop turns
  // levelling on when it wants to ask whether the plan fits capacity.
  const [leveled, setLeveled] = useState(false)
  const [selected, setSelected] = useState(null)
  const [status, setStatus] = useState(configured ? 'loading' : 'unconfigured')
  const [error, setError] = useState('')
  const [bootErrors, setBootErrors] = useState([])
  // undefined while we're still asking Supabase, null when signed out.
  const [session, setSession] = useState(undefined)
  const [showPassword, setShowPassword] = useState(false)
  const [view, setView] = useState('board')
  // False until the tracking columns exist on jobs, so the board still runs without them.
  const [trackingEnabled, setTrackingEnabled] = useState(true)
  // Same for the pinned-stage columns: without them the board still schedules,
  // it just can't be overruled by dragging.
  const [pinsEnabled, setPinsEnabled] = useState(true)
  // The steps each station breaks into, per unit. Empty is the normal state:
  // a station with no steps keeps using its own typed day count.
  const [steps, setSteps] = useState([])
  // False until the job_steps table exists, so the board still runs without it.
  const [stepsEnabled, setStepsEnabled] = useState(true)
  // Which units are showing their steps on the board.
  const [openUnits, setOpenUnits] = useState(() => new Set())
  // Closed stations, planned against actual. Empty until a station is closed.
  const [stageLog, setStageLog] = useState([])
  // False until stage_log carries started_on/finished_on, so closing a station
  // still works on a database that hasn't had the migration run against it.
  const [stageDatesEnabled, setStageDatesEnabled] = useState(true)

  const load = useCallback(async () => {
    if (!supabase) return
    try {
      const [jr, cr, dr, pr, sr, tr] = await Promise.all([
        supabase.from('jobs').select('*').order('delivery_date'),
        supabase.from('station_caps').select('*'),
        supabase.from('day_overrides').select('*'),
        supabase.from('part_numbers').select('*').order('part_number'),
        supabase.from('stage_log').select('*'),
        supabase.from('job_steps').select('*').order('position'),
      ])
      if (jr.error || cr.error) {
        setStatus('error')
        setError((jr.error || cr.error).message)
        return
      }
      const jrows = jr.data || []
      const has = (k) => jrows.length === 0 || Object.prototype.hasOwnProperty.call(jrows[0], k)
      setTrackingEnabled(has('stage'))
      setPinsEnabled(has('fab_pinned_start'))
      setJobs(jrows.map((r) => ({
        id: r.id, unit: r.unit, desc: r.description || '',
        delivery: parseDate(r.delivery_date),
        fab: r.fab_days, paint: r.paint_days, asm: r.asm_days,
        partId: r.part_number_id || '',
        stage: r.stage || 'none',
        stageStarted: r.stage_started ? parseDate(r.stage_started) : null,
        daysLeft: r.days_left == null ? null : r.days_left,
        // Stages the shop has placed by hand; absent keys mean the scheduler chooses.
        pins: OPS.reduce((m, o) => {
          const v = r[`${o.key}_pinned_start`]
          if (v) m[o.key] = parseDate(v)
          return m
        }, {}),
      })))
      const c = { fab: 2, paint: 1, asm: 2 }
      ;(cr.data || []).forEach((r) => { c[r.station] = r.cap })
      setCaps(c)
      // The calendar is optional: if the table hasn't been created yet, fall back
      // to plain weekends rather than failing the whole board.
      setCalendarEnabled(!dr.error)
      setDayOverrides(dr.error ? new Map() : new Map((dr.data || []).map((r) => [r.day, r.working])))
      // The catalog is optional the same way, so the board still runs without it.
      setPartsEnabled(!pr.error)
      setParts(pr.error ? [] : (pr.data || []))
      // Steps are optional the same way the catalog is.
      setStepsEnabled(!tr.error)
      setSteps(tr.error ? [] : (tr.data || []))
      const srows = sr.error ? [] : (sr.data || [])
      setStageLog(srows)
      if (srows.length) setStageDatesEnabled(Object.prototype.hasOwnProperty.call(srows[0], 'started_on'))
      setStatus('ready')
    } catch (err) {
      setStatus('error')
      setError(String((err && err.message) || err))
    }
  }, [])

  // Which account the board is currently showing. Token refreshes and the
  // re-authentication behind a password change both raise auth events for the
  // same person — reloading the board on those would tear down whatever the
  // user is in the middle of, so only a genuine change of account counts.
  const userIdRef = useRef(null)
  useEffect(() => {
    if (!supabase) return setSession(null)
    const apply = (s) => {
      const prevId = userIdRef.current
      const nextId = s ? s.user.id : null
      userIdRef.current = nextId
      setSession(s || null)
      if (nextId === prevId) return
      setStatus(nextId ? 'loading' : 'ready')
      if (!nextId) { setJobs([]); setParts([]); setDayOverrides(new Map()) }
    }
    supabase.auth.getSession().then(({ data }) => apply(data.session || null))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => apply(s || null))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const onErr = (e) => setBootErrors((b) => [...b, String(e.reason?.message || e.message || e.reason || e.error || 'unknown error')])
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onErr)
    return () => {
      window.removeEventListener('error', onErr)
      window.removeEventListener('unhandledrejection', onErr)
    }
  }, [])

  // Only watch for a stalled load while there's a session actually loading.
  useEffect(() => {
    if (!session || status !== 'loading') return
    const watchdog = setTimeout(() => {
      setStatus((s) => (s === 'loading' ? 'error' : s))
      setError((prev) => prev || 'Loading stalled after 10 seconds without a reported cause. The messages below (if any) are the underlying errors.')
    }, 10000)
    return () => clearTimeout(watchdog)
  }, [session, status])

  // The shop calendar. Several handlers below reach for it, so it is built
  // before any of them.
  const cal = useMemo(() => createCalendar(dayOverrides), [dayOverrides])

  const userId = session ? session.user.id : null
  // How many edits are still on their way to the database. Declared up here
  // because the reload below reads it, and a name used above where it is
  // defined is the shape of bug this file has produced more than once.
  const pendingWrites = useRef(0)
  // A realtime event is mostly the echo of our own write. Reloading on each one
  // refetched every table and replaced the board underneath whoever was typing,
  // so the reload is held until the edits have settled.
  const reloadTimer = useRef(null)
  const scheduleReload = useCallback(() => {
    clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(function again() {
      if (pendingWrites.current > 0) { reloadTimer.current = setTimeout(again, 400); return }
      load()
    }, 900)
  }, [load])

  useEffect(() => {
    if (!supabase || !userId) return
    load()
    // Live sync: any change from any user refreshes every open board.
    const ch = supabase
      .channel('schedule-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'station_caps' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'day_overrides' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'part_numbers' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stage_log' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_steps' }, scheduleReload)
      .subscribe()
    return () => { supabase.removeChannel(ch); clearTimeout(reloadTimer.current) }
  }, [load, scheduleReload, userId])

  // Typing used to write a row per keystroke, and every write came straight back
  // as a realtime event that reloaded all five tables and replaced the jobs
  // array mid-edit — so characters landed and were then overwritten by the
  // refetch. Edits are now applied locally at once and persisted after a pause,
  // and a reload waits until nothing is in flight.
  const SAVE_AFTER = 500
  const queuedJobs = useRef(new Map())
  const jobTimers = useRef(new Map())

  const flushJob = useCallback(async (id) => {
    const patch = queuedJobs.current.get(id)
    queuedJobs.current.delete(id)
    jobTimers.current.delete(id)
    if (!patch) { pendingWrites.current = Math.max(0, pendingWrites.current - 1); return }
    const row = {}
    if (patch.unit !== undefined) row.unit = patch.unit
    if (patch.desc !== undefined) row.description = patch.desc
    if (patch.delivery !== undefined) row.delivery_date = isoDate(patch.delivery)
    if (patch.fab !== undefined) row.fab_days = patch.fab
    if (patch.paint !== undefined) row.paint_days = patch.paint
    if (patch.asm !== undefined) row.asm_days = patch.asm
    if (patch.partId !== undefined) row.part_number_id = patch.partId || null
    if (patch.stage !== undefined) row.stage = patch.stage
    if (patch.stageStarted !== undefined) row.stage_started = patch.stageStarted ? isoDate(patch.stageStarted) : null
    if (patch.daysLeft !== undefined) row.days_left = patch.daysLeft
    if (patch.pins !== undefined) OPS.forEach((o) => {
      row[`${o.key}_pinned_start`] = patch.pins[o.key] ? isoDate(patch.pins[o.key]) : null
    })
    const { error: e } = await supabase.from('jobs').update(row).eq('id', id)
    pendingWrites.current = Math.max(0, pendingWrites.current - 1)
    if (e) { setError(e.message); load() }
  }, [load])

  const saveJob = useCallback((id, patch) => {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)))
    if (!queuedJobs.current.has(id)) pendingWrites.current += 1
    queuedJobs.current.set(id, { ...(queuedJobs.current.get(id) || {}), ...patch })
    clearTimeout(jobTimers.current.get(id))
    jobTimers.current.set(id, setTimeout(() => flushJob(id), SAVE_AFTER))
  }, [flushJob])
  const addJob = async () => {
    const p = parts.find((x) => x.id === addPart)
    const row = {
      unit: 'NEW UNIT',
      description: p ? p.description : '',
      delivery_date: isoDate(addDays(today, 30)),
      fab_days: p ? p.fab_days : 8,
      paint_days: p ? p.paint_days : 2,
      asm_days: p ? p.asm_days : 4,
    }
    if (partsEnabled) row.part_number_id = p ? p.id : null
    if (trackingEnabled) row.stage = 'none'
    const { data, error: e } = await supabase.from('jobs').insert(row).select().single()
    if (e) { setError(e.message); return }
    setSelected(data.id)
    load()
  }
  // Stamp a part number's standard build onto a unit. Values are copied, not
  // linked, so the unit can be tuned afterwards without touching the catalog.
  const applyPart = (jobId, partId) => {
    const p = parts.find((x) => x.id === partId)
    if (!p) return saveJob(jobId, { partId: '' })
    saveJob(jobId, {
      partId: p.id, desc: p.description,
      fab: p.fab_days, paint: p.paint_days, asm: p.asm_days,
    })
  }

  const queuedParts = useRef(new Map())
  const partTimers = useRef(new Map())
  const flushPart = useCallback(async (id) => {
    const patch = queuedParts.current.get(id)
    queuedParts.current.delete(id)
    partTimers.current.delete(id)
    if (!patch) { pendingWrites.current = Math.max(0, pendingWrites.current - 1); return }
    const { error: e } = await supabase.from('part_numbers').update(patch).eq('id', id)
    pendingWrites.current = Math.max(0, pendingWrites.current - 1)
    if (e) { setError(e.message); load() }
  }, [load])
  const savePart = useCallback((id, patch) => {
    setParts((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
    if (!queuedParts.current.has(id)) pendingWrites.current += 1
    queuedParts.current.set(id, { ...(queuedParts.current.get(id) || {}), ...patch })
    clearTimeout(partTimers.current.get(id))
    partTimers.current.set(id, setTimeout(() => flushPart(id), SAVE_AFTER))
  }, [flushPart])

  // --- steps ---------------------------------------------------------------
  // Same shape as the part-number edits: apply locally at once, persist after a
  // pause, coalesced per row, so typing a step name is one write and not twelve.
  const queuedSteps = useRef(new Map())
  const stepTimers = useRef(new Map())
  const flushStep = useCallback(async (id) => {
    const patch = queuedSteps.current.get(id)
    queuedSteps.current.delete(id)
    stepTimers.current.delete(id)
    if (!patch) { pendingWrites.current = Math.max(0, pendingWrites.current - 1); return }
    const { error: e } = await supabase.from('job_steps').update(patch).eq('id', id)
    pendingWrites.current = Math.max(0, pendingWrites.current - 1)
    if (e) { setError(e.message); load() }
  }, [load])
  const saveStep = useCallback((id, patch) => {
    setSteps((ls) => ls.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    if (!queuedSteps.current.has(id)) pendingWrites.current += 1
    queuedSteps.current.set(id, { ...(queuedSteps.current.get(id) || {}), ...patch })
    clearTimeout(stepTimers.current.get(id))
    stepTimers.current.set(id, setTimeout(() => flushStep(id), SAVE_AFTER))
  }, [flushStep])

  const addStep = useCallback(async (job, stage) => {
    const cur = (steps || []).filter((r) => r.job_id === job.id && r.stage === stage)
    // A station being broken down for the first time keeps the length it
    // already had: the first step inherits the whole typed day count, so
    // nothing on the board jumps the moment a step is added.
    const first = cur.length === 0
    const row = {
      job_id: job.id, stage, name: '', done: false,
      days: first ? Math.max(1, job[stage] || 1) : 1,
      position: cur.reduce((n, r) => Math.max(n, r.position + 1), 0),
    }
    const { data, error: e } = await supabase.from('job_steps').insert(row).select().single()
    if (e) { setError(e.message); return }
    setSteps((ls) => [...ls, data])
  }, [steps])

  // Say that one step waits on another. A link that would put a step in its own
  // queue is refused rather than accepted and then reported as a cycle.
  const toggleNeed = useCallback((list, step, needId) => {
    const has = (step.needs || []).includes(needId)
    if (!has && (needId === step.id || stepDependsOn(list, needId, step.id))) {
      setError(`That would have ${step.name || 'this step'} waiting on itself.`)
      return
    }
    const needs = has
      ? step.needs.filter((x) => x !== needId)
      : [...(step.needs || []), needId]
    saveStep(step.id, { needs })
  }, [saveStep])

  const removeStep = useCallback(async (id) => {
    // Anything waiting on it stops waiting. The scheduler already ignores a link
    // to a step that is gone, but leaving the id behind would resurrect the wait
    // if a new step ever reused it.
    const orphaned = (steps || []).filter((r) => (r.needs || []).includes(id))
    setSteps((ls) => ls
      .filter((r) => r.id !== id)
      .map((r) => ((r.needs || []).includes(id) ? { ...r, needs: r.needs.filter((x) => x !== id) } : r)))
    const { error: e } = await supabase.from('job_steps').delete().eq('id', id)
    if (e) { setError(e.message); load(); return }
    await Promise.all(orphaned.map((r) => supabase.from('job_steps')
      .update({ needs: r.needs.filter((x) => x !== id) }).eq('id', r.id)))
  }, [steps, load])

  // Flush anything still queued if the tab goes away mid-edit.
  useEffect(() => {
    const flushAll = () => {
      jobTimers.current.forEach((t, id) => { clearTimeout(t); flushJob(id) })
      partTimers.current.forEach((t, id) => { clearTimeout(t); flushPart(id) })
      stepTimers.current.forEach((t, id) => { clearTimeout(t); flushStep(id) })
    }
    window.addEventListener('pagehide', flushAll)
    return () => { window.removeEventListener('pagehide', flushAll); flushAll() }
  }, [flushJob, flushPart, flushStep])
  const newPart = async () => {
    const taken = new Set(parts.map((p) => p.part_number))
    let name = 'NEW-PN'
    for (let n = 2; taken.has(name); n++) name = `NEW-PN-${n}`
    const { error: e } = await supabase.from('part_numbers')
      .insert({ part_number: name, description: '', fab_days: 8, paint_days: 2, asm_days: 4 })
    if (e) { setError(e.message); return }
    load()
  }
  const removePart = async (id) => {
    const { error: e } = await supabase.from('part_numbers').delete().eq('id', id)
    if (e) setError(e.message)
    load()
  }
  const removeJob = async (id) => {
    setSelected(null)
    const { error: e } = await supabase.from('jobs').delete().eq('id', id)
    if (e) setError(e.message)
    load()
  }
  // Move a unit on to the next station. The station being left is logged with
  // its planned and actual days, so estimates can be checked against reality.
  const advanceStage = async (job) => {
    if (!trackingEnabled) return
    const from = job.stage || 'none'
    if (from === 'done') return
    // Only record what was actually measured. Without a start date the days
    // spent are unknown, not zero — logging zero would teach the report that
    // the station takes no time, which is worse than having no figure at all.
    if (from !== 'none' && job.stageStarted) {
      const base = {
        job_id: job.id, stage: from,
        planned_days: job[from], actual_days: daysSpent(job, today, cal),
      }
      // The dates as well as the durations: the station opened the day the unit
      // went into it and closes today, which is what makes planned start and
      // finish readable against actual start and finish later on.
      const dated = { ...base, started_on: isoDate(job.stageStarted), finished_on: isoDate(today) }
      let { error: le } = await supabase.from('stage_log')
        .upsert(stageDatesEnabled ? dated : base)
      // A database still on the old stage_log rejects the two date columns.
      // Record the durations rather than losing the closure over it.
      if (le && stageDatesEnabled && /started_on|finished_on/.test(le.message || '')) {
        setStageDatesEnabled(false)
        ;({ error: le } = await supabase.from('stage_log').upsert(base))
      }
      if (le) setError(le.message)
    }
    const to = nextStage(from)
    await saveJob(job.id, to === 'done'
      ? { stage: 'done', stageStarted: null, daysLeft: null }
      : { stage: to, stageStarted: today, daysLeft: job[to] })
  }
  // Setting a stage by hand, for corrections.
  const setStage = (job, stage) => saveJob(job.id, stage === 'none' || stage === 'done'
    ? { stage, stageStarted: null, daysLeft: null }
    : { stage, stageStarted: today, daysLeft: job[stage] })

  // Click a date to close the shop that day (holiday, shutdown) or to open a
  // weekend for overtime. A day back at its Mon–Fri default drops its row.
  const toggleDay = async (d) => {
    if (!calendarEnabled) return
    const iso = isoDate(d)
    const working = !cal.isWorkday(d)
    const isDefault = working === !isWeekend(d)
    setDayOverrides((m) => {
      const n = new Map(m)
      if (isDefault) n.delete(iso); else n.set(iso, working)
      return n
    })
    const { error: e } = isDefault
      ? await supabase.from('day_overrides').delete().eq('day', iso)
      : await supabase.from('day_overrides').upsert({ day: iso, working })
    if (e) { setError(e.message); load() }
  }
  const capTimers = useRef(new Map())
  const saveCap = useCallback((station, cap) => {
    setCaps((c) => ({ ...c, [station]: cap }))
    if (!capTimers.current.has(station)) pendingWrites.current += 1
    clearTimeout(capTimers.current.get(station))
    capTimers.current.set(station, setTimeout(async () => {
      capTimers.current.delete(station)
      const { error: e } = await supabase.from('station_caps').upsert({ station, cap })
      pendingWrites.current = Math.max(0, pendingWrites.current - 1)
      if (e) { setError(e.message); load() }
    }, SAVE_AFTER))
  }, [load])

  // Correct the dates a station actually ran between.
  //
  // Where they live depends on the station. The one in progress keeps its start
  // on the unit itself — the same field as "Went into …" — and has no finish
  // until it is closed, so closing it is what sets one. A station already closed
  // keeps both dates on its stage log row, and the days it took are recomputed
  // from them, so the figures in the report can never drift away from the dates
  // shown beside them.
  const saveStageDates = useCallback(async (job, stage, patch) => {
    if ((job.stage || 'none') === stage) {
      if (patch.start !== undefined) saveJob(job.id, { stageStarted: patch.start })
      return
    }
    if (!stageDatesEnabled) return
    const cur = (stageLog || []).find((l) => l.job_id === job.id && l.stage === stage)
    const started = patch.start !== undefined ? patch.start
      : cur && cur.started_on ? parseDate(cur.started_on) : null
    // Falling back to closed_on the way the table does, so an edit acts on the
    // dates being shown. A row from before these columns existed thereby gets
    // its displayed finish written down properly the first time it is touched.
    const curFinish = cur && (cur.finished_on || cur.closed_on)
    const finished = patch.finish !== undefined ? patch.finish
      : curFinish ? parseDate(curFinish) : null

    // Both dates gone means nothing is known about the station any more, and a
    // row saying only that it was booked for eight days is worse than no row.
    if (!started && !finished) {
      setStageLog((ls) => ls.filter((l) => !(l.job_id === job.id && l.stage === stage)))
      const { error: e } = await supabase.from('stage_log').delete()
        .eq('job_id', job.id).eq('stage', stage)
      if (e) { setError(e.message); load() }
      return
    }

    const row = {
      job_id: job.id, stage,
      planned_days: cur ? cur.planned_days : Math.max(1, job[stage] || 1),
      // Half a pair of dates cannot say how long the station took, and unknown
      // is not zero — the report leaves such a row out rather than counting it.
      actual_days: started && finished ? workdaysInclusive(started, finished, cal) : null,
      started_on: started ? isoDate(started) : null,
      finished_on: finished ? isoDate(finished) : null,
    }
    setStageLog((ls) => [
      ...ls.filter((l) => !(l.job_id === job.id && l.stage === stage)),
      { closed_on: (cur && cur.closed_on) || isoDate(today), ...row },
    ])
    const { error: e } = await supabase.from('stage_log').upsert(row)
    if (e) { setError(e.message); load() }
  }, [stageLog, stageDatesEnabled, saveJob, cal, today, load])

  // Steps by unit, then by station, in the order the shop put them.
  const stepsByJob = useMemo(() => {
    const m = new Map()
    ;(steps || []).forEach((r) => {
      const e = m.get(r.job_id) || { fab: [], paint: [], asm: [] }
      if (e[r.stage]) e[r.stage].push({
        id: r.id, name: r.name || '', days: r.days, done: r.done,
        position: r.position, needs: r.needs || [], lag: r.lag || 0,
      })
      m.set(r.job_id, e)
    })
    m.forEach((e) => OPS.forEach((o) => e[o.key].sort((a, b) => a.position - b.position)))
    return m
  }, [steps])

  // A station with steps takes as long as the longest chain through them —
  // work that runs side by side is planned side by side, so the station is its
  // critical path and not the sum of its parts. The typed day count on the unit
  // stays untouched underneath and comes back the moment the last step is
  // deleted, so breaking a station down is never destructive.
  const units = useMemo(() => jobs.map((j) => {
    const st = stepsByJob.get(j.id)
    if (!st) return j
    let out = j
    OPS.forEach((o) => {
      if (!st[o.key].length) return
      if (out === j) out = { ...j }
      out[o.key] = stepPlan(st[o.key]).length
    })
    return out
  }), [jobs, stepsByJob])

  const { scheduled, scheduleError } = useMemo(() => {
    try {
      const list = leveled
        ? levelSchedule(units, caps, today, cal)
        : units.map((j) => scheduleJob(j, today, cal))
      return { scheduled: list.sort((a, b) => a.mustStart - b.mustStart), scheduleError: '' }
    } catch (err) {
      // A calendar with nearly everything switched off leaves the scheduler with
      // nowhere to put the work; say so instead of showing a half-built board.
      return { scheduled: [], scheduleError: String((err && err.message) || err) }
    }
  }, [units, caps, leveled, today, cal])

  // Dragging a planned bar places that stage by hand: the middle of the bar
  // moves it, either edge stretches it.
  //
  // Every drag pins, resizes included. The alternative — resize the days and let
  // the scheduler re-place the bar — reads as a bug: the plan is built backward
  // from the delivery date, so its end is the anchored edge, and dragging the
  // right edge rightwards would grow the bar leftwards instead. Pinning means
  // the stage ends up exactly where it was dropped, every time.
  const dragStage = useCallback((jobId, key, mode, deltaDays) => {
    if (!pinsEnabled) return
    const job = units.find((j) => j.id === jobId)
    const sched = scheduled.find((j) => j.id === jobId)
    if (!job || !sched) return
    // A station built from steps is as long as its steps; stretching the bar
    // would write a day count the rollup then ignores, so the bar would spring
    // back. Moving it is still fine — that changes when, not how long.
    const built = (stepsByJob.get(jobId) || {})[key]
    if (mode !== 'move' && built && built.length) return
    const span = sched.spans[key]
    // A stage cannot begin on a day the shop is shut, so a bar dropped on one
    // takes the nearest working day *in the direction it was dragged*. Always
    // rounding forward would cancel a small drag to the left outright: two days
    // back off a Monday is a Saturday, which would round straight back to the
    // Monday it came from.
    const onWork = (d, dir) => (cal.isWorkday(d) ? strip(d)
      : dir < 0 ? cal.prevWorkday(d) : cal.nextWorkday(d))
    let start = span.start
    let dur = Math.max(1, job[key] || 1)
    if (mode === 'move') {
      start = onWork(addDays(span.start, deltaDays), deltaDays)
    } else if (mode === 'end') {
      const end = addDays(span.end, deltaDays)
      dur = workdaysInclusive(span.start, end < span.start ? span.start : end, cal)
    } else {
      const moved = onWork(addDays(span.start, deltaDays), deltaDays)
      start = moved > span.end ? strip(span.end) : moved
      dur = workdaysInclusive(start, span.end, cal)
    }
    saveJob(jobId, {
      pins: { ...job.pins, [key]: start },
      ...(Math.max(1, dur) === job[key] ? {} : { [key]: Math.max(1, dur) }),
    })
  }, [units, scheduled, stepsByJob, cal, pinsEnabled, saveJob])

  // Dragging a step bar, the same two gestures the station bars take. An edge
  // changes how long the step takes; the middle holds it back.
  //
  // A step has no start date of its own — where it sits comes from what it
  // waits on — so moving one sets its lag: the working days it waits beyond
  // its prerequisites. Dragging left therefore stops at the earliest the step
  // could possibly start, which is the honest limit rather than an arbitrary
  // one, and dragging right can lengthen the station if the step is on its
  // critical path.
  const dragStep = useCallback((jobId, stage, stepId, mode, deltaDays) => {
    const list = (stepsByJob.get(jobId) || {})[stage]
    const step = list && list.find((x) => x.id === stepId)
    const sched = scheduled.find((j) => j.id === jobId)
    if (!step || !sched) return
    const plan = stepPlan(list)
    const spans = stepSpans(sched.spans[stage].start, list, cal)
    const span = spans.find((x) => x.id === stepId)
    if (!span) return

    if (mode === 'end') {
      const end = addDays(span.end, deltaDays)
      const days = workdaysInclusive(span.start, end < span.start ? span.start : end, cal)
      if (days !== step.days) saveStep(stepId, { days: Math.max(1, days) })
      return
    }
    // Where the drag wants the step to start, as a working-day offset from the
    // station, and what that means as a wait beyond its prerequisites.
    const want = addDays(span.start, deltaDays)
    const from = cal.isWorkday(want) ? strip(want)
      : deltaDays < 0 ? cal.prevWorkday(want) : cal.nextWorkday(want)
    const stationStart = sched.spans[stage].start
    const offset = Math.max(0, cal.workdaysBetween(stationStart, from))
    const lag = Math.max(0, offset - (plan.earliest.get(stepId) || 0))
    if (mode === 'start') {
      // The left edge moves the start and keeps the finish, so it is a resize
      // as well as a wait.
      const days = workdaysInclusive(from > span.end ? strip(span.end) : from, span.end, cal)
      saveStep(stepId, { lag, days: Math.max(1, days) })
      return
    }
    if (lag !== (step.lag || 0)) saveStep(stepId, { lag })
  }, [stepsByJob, scheduled, cal, saveStep])

  // Hand a stage back to the scheduler.
  const releasePin = useCallback((job, key) => {
    const pins = { ...job.pins }
    delete pins[key]
    saveJob(job.id, { pins })
  }, [saveJob])
  const releaseAllPins = useCallback((job) => saveJob(job.id, { pins: {} }), [saveJob])

  // Where the work actually lands: remaining work pushed forward from today.
  // The plan above says when work *should* happen; this says when it will.
  const { projected, projectError } = useMemo(() => {
    try { return { projected: projectSchedule(units, caps, today, cal), projectError: '' } }
    catch (err) { return { projected: [], projectError: String((err && err.message) || err) } }
  }, [units, caps, today, cal])
  const projById = useMemo(() => new Map(projected.map((p) => [p.id, p])), [projected])

  // Dragging the projection — the lower, solid lane. It is derived, so a drag
  // has to land somewhere real:
  //
  //   a station not started yet  middle pins it, an edge sets its days
  //   the station running now    an edge sets the days the shop says are left
  //
  // Moving the running station is refused. Its work is happening now; a bar
  // that says otherwise would be the board disagreeing with the shop floor.
  const dragProjected = useCallback((jobId, key, mode, deltaDays) => {
    const job = units.find((j) => j.id === jobId)
    const proj = projById.get(jobId)
    const span = proj && proj.spans[key]
    if (!job || !span) return
    const running = (job.stage || 'none') === key
    const onWork = (d, dir) => (cal.isWorkday(d) ? strip(d)
      : dir < 0 ? cal.prevWorkday(d) : cal.nextWorkday(d))

    if (mode === 'move' || (mode === 'start' && !running)) {
      if (running || !pinsEnabled) return
      const start = onWork(addDays(span.start, deltaDays), deltaDays)
      const patch = { pins: { ...job.pins, [key]: start } }
      // The left edge moves the start and holds the finish, so it resizes too.
      if (mode === 'start') {
        const days = workdaysInclusive(start > span.end ? strip(span.end) : start, span.end, cal)
        const built = (stepsByJob.get(jobId) || {})[key]
        if (!(built && built.length)) patch[key] = Math.max(1, days)
      }
      saveJob(jobId, patch)
      return
    }
    if (mode !== 'end') return
    const end = addDays(span.end, deltaDays)
    const days = Math.max(running ? 0 : 1,
      workdaysInclusive(span.start, end < span.start ? span.start : end, cal))
    if (running) {
      // What is left on the station the unit is standing in.
      if (days !== (job.daysLeft == null ? job[key] : job.daysLeft)) saveJob(jobId, { daysLeft: days })
      return
    }
    // A station built from steps is as long as its steps; the number would be
    // written and then ignored, so the bar would spring back.
    const built = (stepsByJob.get(jobId) || {})[key]
    if (built && built.length) return
    if (days !== job[key]) saveJob(jobId, { [key]: days })
  }, [units, projById, stepsByJob, cal, pinsEnabled, saveJob])
  const partsById = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts])

  // Closed stations by unit, then by station.
  const logByJob = useMemo(() => {
    const m = new Map()
    ;(stageLog || []).forEach((l) => {
      const e = m.get(l.job_id) || {}
      e[l.stage] = {
        plannedDays: l.planned_days,
        actualDays: l.actual_days,
        started: l.started_on ? parseDate(l.started_on) : null,
        // Rows closed before the dates were kept only know the day they were
        // written, which for those is the nearest thing to a finish date.
        finished: l.finished_on ? parseDate(l.finished_on)
          : l.closed_on ? parseDate(l.closed_on) : null,
      }
      m.set(l.job_id, e)
    })
    return m
  }, [stageLog])

  // The four dates per station, per unit: planned start and finish against
  // actual start and finish.
  //
  // The planned side is the plain just-in-time plan — straight back from the
  // delivery date, capacity ignored — and not the board's levelled plan, which
  // cannot answer the question. Levelling books no work before today, so for a
  // station that has already run it invents a date in the future and the
  // comparison turns to nonsense. Just-in-time is defined in the past as well:
  // the latest that station could have run and still made delivery. It also
  // holds still when the capacity toggle is flipped.
  const stagesById = useMemo(() => {
    const m = new Map()
    units.forEach((j) => {
      let plan = null
      // A calendar with nearly everything switched off leaves nowhere to put
      // the work; the actual dates are still worth showing without the plan.
      try { plan = scheduleJob(j, today, cal).spans } catch { plan = null }
      m.set(j.id, stageDates(j, plan, logByJob.get(j.id), projById.get(j.id), cal))
    })
    return m
  }, [units, logByJob, projById, today, cal])
  const slipping = projected.filter((p) => p.slipping).length
  const onFloor = units.filter(underway).length

  const { days, months } = useMemo(() => {
    let min = today, max = addDays(today, 14)
    scheduled.forEach((j) => {
      // Any stage can be pinned anywhere, so every span counts towards the
      // window — not just fabrication at the front and assembly at the back.
      OPS.forEach((o) => {
        if (j.spans[o.key].start < min) min = j.spans[o.key].start
        if (j.spans[o.key].end > max) max = j.spans[o.key].end
      })
      if (j.delivery > max) max = j.delivery
    })
    projected.forEach((p) => { if (p.projectedEnd && p.projectedEnd > max) max = p.projectedEnd })
    min = addDays(min, -3)
    max = addDays(max, 4)
    const days = []
    for (let d = min; d <= max; d = addDays(d, 1)) days.push(d)
    const months = []
    days.forEach((d) => {
      const label = d.toLocaleDateString('en-US', { month: 'long' })
      const last = months[months.length - 1]
      if (last && last.label === label) last.count++
      else months.push({ label, count: 1 })
    })
    return { days, months }
  }, [scheduled, projected, today])

  // The table is for working through the book, so order it by the date being
  // entered rather than by the computed start the board sorts on. The order is
  // held steady while you type: re-sorting on every keystroke would slide the
  // row out from under the cursor the moment a date passes its neighbour's, and
  // Enter would drop into a different unit than the one below. It settles again
  // when the table is opened, when units are added or removed, or on request.
  const [tableOrder, setTableOrder] = useState([])
  const [sort, setSort] = useState({ key: 'delivery', dir: 1 })

  // Sorting reads the projection and the catalogue as well as the unit itself,
  // and runs from an effect, so the current values go through refs.
  const scheduledRef = useRef(scheduled)
  const sortRef = useRef(sort)
  const projRef = useRef(projById)
  const partsRef = useRef(partsById)
  scheduledRef.current = scheduled
  sortRef.current = sort
  projRef.current = projById
  partsRef.current = partsById

  const resortTable = useCallback(() => {
    const { key, dir } = sortRef.current
    const value = (j) => {
      const p = projRef.current.get(j.id)
      const live = j.stage || 'none'
      switch (key) {
        case 'unit': return j.unit || ''
        case 'delivery': return +j.delivery
        case 'stage': return STAGE_RANK[live]
        case 'since': return j.stageStarted ? +j.stageStarted : null
        case 'left': return live === 'none' || live === 'done'
          ? null : (j.daysLeft == null ? j[live] : j.daysLeft)
        case 'projected': return p && p.projectedEnd ? +p.projectedEnd : null
        case 'variance': return p && !p.complete ? p.variance : null
        // null rather than '' so an untagged unit sorts to the bottom like every
        // other blank, instead of heading the list when sorted ascending
        case 'part': return (partsRef.current.get(j.partId) || {}).part_number || null
        case 'desc': return j.desc || null
        default: return j[key]
      }
    }
    setTableOrder(scheduledRef.current.slice().sort((a, b) => {
      const va = value(a), vb = value(b)
      // blanks sort to the bottom whichever way the column is pointing
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      const r = typeof va === 'string'
        ? va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' })
        : va - vb
      // work-order numbers break every tie, so the order is never arbitrary
      return r ? r * dir : String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true })
    }).map((j) => j.id))
  }, [])

  // The board sorts by the day fabrication has to start, which is exactly the
  // thing a drag changes — so left live, the row being dragged would leap to a
  // different place on the board the moment the pointer came up. Hold the order
  // and settle it when the units themselves change, the way the table does.
  const [boardOrder, setBoardOrder] = useState([])
  // What the rows are ordered by. The day fabrication has to start is the
  // shop's question — what to put on next. The two delivery dates are the
  // office's: what is promised when, and when it will really land.
  // Remembered per browser, like the column width: which question you want the
  // board ordered by is yours, and re-picking it every morning is a chore.
  const [boardSort, setBoardSort] = useState(() => {
    try {
      const v = window.localStorage.getItem('boardSort')
      return ['start', 'delivery', 'projected'].includes(v) ? v : 'start'
    } catch { return 'start' }
  })
  const pickSort = useCallback((v) => {
    setBoardSort(v)
    try { window.localStorage.setItem('boardSort', v) } catch { /* private window */ }
  }, [])
  const resettleBoard = useCallback(() => {
    const key = (j) => {
      if (boardSort === 'delivery') return +j.delivery
      if (boardSort === 'projected') {
        const p = projRef.current.get(j.id)
        // A unit with every station closed has no projected finish left to
        // sort on; it goes to the bottom rather than to the top as a zero.
        return p && p.projectedEnd ? +p.projectedEnd : null
      }
      return +j.mustStart
    }
    setBoardOrder(scheduledRef.current.slice()
      .sort((a, b) => {
        const va = key(a), vb = key(b)
        if (va == null && vb == null) return 0
        if (va == null) return 1
        if (vb == null) return -1
        return (va - vb) || String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true })
      })
      .map((j) => j.id))
  }, [boardSort])
  const boardRows = useMemo(() => {
    const byId = new Map(scheduled.map((j) => [j.id, j]))
    const ordered = boardOrder.map((id) => byId.get(id)).filter(Boolean)
    const seen = new Set(ordered.map((j) => j.id))
    return [...ordered, ...scheduled.filter((j) => !seen.has(j.id))]
  }, [scheduled, boardOrder])

  // A finished unit is still worth keeping -- somebody will ask when WO-26-0012
  // shipped -- but it is not the work in front of you, and a year of them
  // strung through the live rows is what makes the board hard to read. They get
  // their own group above the rest, folded away by default. The choice is
  // remembered per browser like the sort and the column width: re-folding two
  // years of history every morning is exactly the chore we keep removing.
  const [showDone, setShowDone] = useState(() => {
    try { return window.localStorage.getItem('showDone') === '1' } catch { return false }
  })
  const toggleDone = useCallback(() => {
    setShowDone((v) => {
      try { window.localStorage.setItem('showDone', v ? '0' : '1') } catch { /* private window */ }
      return !v
    })
  }, [])
  // The order of the table's columns. Different people read the book
  // differently -- the office wants the dates first, the shop wants the stage
  // and the days left -- so the order is theirs to set, and it stays put like
  // the sort choice and the column width. null means the order it ships with.
  const [columnOrder, setColumnOrder] = useState(() => {
    try {
      const v = JSON.parse(window.localStorage.getItem('tableColumns'))
      return Array.isArray(v) && v.every((k) => typeof k === 'string') ? v : null
    } catch { return null }
  })
  // How wide each column is, for the ones that have been dragged. A column
  // missing from here keeps the width it ships with, so this stays a short list
  // of what somebody actually changed rather than a copy of every default.
  const [columnWidths, setColumnWidths] = useState(() => {
    try {
      const v = JSON.parse(window.localStorage.getItem('tableWidths'))
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch { return null }
  })
  const resizeColumns = useCallback((widths) => {
    setColumnWidths(widths)
    try {
      if (widths) window.localStorage.setItem('tableWidths', JSON.stringify(widths))
      else window.localStorage.removeItem('tableWidths')
    } catch { /* private window */ }
  }, [])
  const moveColumns = useCallback((order) => {
    setColumnOrder(order)
    try {
      if (order) window.localStorage.setItem('tableColumns', JSON.stringify(order))
      else window.localStorage.removeItem('tableColumns')
    } catch { /* private window */ }
  }, [])

  // Complete is the stage the shop set, not something inferred from the dates:
  // a unit is done when someone says it is done.
  const [doneRows, liveRows] = useMemo(() => {
    const d = [], l = []
    boardRows.forEach((j) => { (j.stage === 'done' ? d : l).push(j) })
    return [d, l]
  }, [boardRows])

  // How wide the sticky column of unit names is. A shop with long part
  // descriptions wants it wider; the person reading it decides, so it is kept
  // in the browser rather than in the database.
  const LABEL_MIN = 150, LABEL_MAX = 620
  const gridRef = useRef(null)
  const gripRef = useRef(null)
  const [labelWidth, setLabelWidth] = useState(() => {
    try {
      const v = Number(window.localStorage.getItem('boardLabelWidth'))
      return v ? Math.min(LABEL_MAX, Math.max(LABEL_MIN, v)) : 230
    } catch { return 230 }
  })
  const liveWidth = useRef(labelWidth)

  // Dragging the divider writes straight to the DOM and only commits to state
  // when the pointer comes up. Re-rendering the board on every pointer move
  // would repaint a couple of thousand day cells and the drag would stutter.
  const gripDown = useCallback((e) => {
    if (e.button) return
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX, w0 = liveWidth.current
    const cols = gridRef.current ? gridRef.current.style.gridTemplateColumns.replace(/^[^ ]+ /, '') : ''
    const move = (ev) => {
      const w = Math.min(LABEL_MAX, Math.max(LABEL_MIN, Math.round(w0 + ev.clientX - x0)))
      liveWidth.current = w
      if (gridRef.current) gridRef.current.style.gridTemplateColumns = `${w}px ${cols}`
      if (gripRef.current) gripRef.current.style.left = `${w - 3}px`
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setLabelWidth(liveWidth.current)
      try { window.localStorage.setItem('boardLabelWidth', String(liveWidth.current)) } catch { /* private window */ }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [])

  // Whether the board has been put back where it was left. Until it has, its
  // own scrolling is not somebody choosing a position and must not overwrite
  // the stored one.
  const placed = useRef(false)
  const saveAt = useRef(0)
  const daysRef = useRef([])

  // The divider is positioned against the board's scrolled content, while the
  // column it sits beside is stuck to the left edge — so it has to be pushed
  // back by however far the board has been scrolled to stay on the seam.
  const onBoardScroll = useCallback((e) => {
    if (gripRef.current) gripRef.current.style.transform = `translateX(${e.currentTarget.scrollLeft}px)`
    // Remember where the board is, so coming back to it does not mean dragging
    // back to where you were. Kept as the date at the left edge, not a pixel
    // offset: the run of days moves whenever a delivery does, and an offset
    // would then point at a different week. Held until the scrolling stops --
    // writing on every scroll event would be a write per pixel.
    if (!placed.current) return
    const { scrollLeft, scrollTop } = e.currentTarget
    clearTimeout(saveAt.current)
    saveAt.current = setTimeout(() => {
      const d = daysRef.current[Math.round(scrollLeft / COL)]
      if (!d) return
      try {
        window.localStorage.setItem('boardAt', JSON.stringify({ d: isoDate(d), top: scrollTop }))
      } catch { /* private window */ }
    }, 250)
  }, [])

  // Grab the board itself and pull it around, the way you would a paper
  // schedule on a bench. The bars keep their own gesture — dragging one places
  // a stage — so panning only starts on the board's own background.
  const boardRef = useRef(null)
  const pan = useRef(null)
  const [panning, setPanning] = useState(false)

  const panDown = useCallback((e) => {
    const el = boardRef.current
    if (!el || e.button) return
    // Touch already drags the board, with momentum and rubber-banding the
    // browser does better than this would; panning it as well would scroll
    // twice as far as the finger moved.
    if (e.pointerType === 'touch') return
    // Anything that already does something when you drag or click it keeps it.
    if (e.target.closest('.bar, .colgrip, input, button, select, textarea, a, label')) return
    pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false }
    setPanning(true)
  }, [])

  // The move and release are watched on the window rather than held with
  // setPointerCapture. Capturing the pointer redirects the click that ends the
  // gesture to the capturing element, so the board swallowed every click on a
  // date and every click on a row label — the day toggles and unit selection
  // both stopped working. Window listeners follow the pointer just as well and
  // leave the click where it belongs.
  useEffect(() => {
    if (!panning) return
    const move = (e) => {
      const p = pan.current, el = boardRef.current
      if (!p || !el) return
      const dx = e.clientX - p.x, dy = e.clientY - p.y
      // A few pixels of slop, so a click that wobbles is still a click.
      if (!p.moved && Math.abs(dx) + Math.abs(dy) > 3) p.moved = true
      el.scrollLeft = p.left - dx
      el.scrollTop = p.top - dy
    }
    const up = () => {
      const p = pan.current
      pan.current = null
      setPanning(false)
      const el = boardRef.current
      if (!p || !p.moved || !el) return
      // Swallow the click this drag is about to fire. Panning across the date
      // row would otherwise close every day it passed over.
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault() }
      el.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    // A pointer released outside the browser never reports back; don't leave
    // the board stuck to the cursor.
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
    }
  }, [panning])

  const idKey = scheduled.map((j) => j.id).sort().join(',')
  // Levelling recomputes the day every unit has to start, which is the very
  // thing the rows are ordered by, so the order has to settle again with it.
  // Holding it is there to stop a row leaping away mid-drag; a toggle that
  // rebuilds the whole plan is not a drag, and leaving the old order in place
  // just leaves the board looking shuffled.
  useEffect(() => { resettleBoard() }, [idKey, leveled, resettleBoard])
  useEffect(() => { resortTable() }, [view, idKey, sort, resortTable])

  // Clicking the sorted column flips it. Variance and the day counts open
  // largest-first, since "what is worst" is the reason to sort by them.
  const sortBy = useCallback((key) => {
    setSort((cur) => cur.key === key
      ? { key, dir: -cur.dir }
      : { key, dir: ['variance', 'left', 'fab', 'paint', 'asm'].includes(key) ? -1 : 1 })
  }, [])

  const tableRows = useMemo(() => {
    const byId = new Map(scheduled.map((j) => [j.id, j]))
    const ordered = tableOrder.map((id) => byId.get(id)).filter(Boolean)
    const seen = new Set(ordered.map((j) => j.id))
    return [...ordered, ...scheduled.filter((j) => !seen.has(j.id))]
  }, [scheduled, tableOrder])

  // Every unit's stations, flattened for the report, in delivery order.
  const stageDateRows = useMemo(() => {
    const out = []
    ;[...units]
      .sort((a, b) => a.delivery - b.delivery
        || String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true }))
      .forEach((j) => (stagesById.get(j.id) || [])
        .forEach((st) => out.push({ ...st, jobId: j.id, unit: j.unit })))
    return out
  }, [units, stagesById])

  const dayIndex = (d) => daysBetween(days[0], d)
  daysRef.current = days

  // Put the board back where it was left, once, each time it is opened. Before
  // paint, so it does not show the left edge first and then jump. The stored
  // date may have fallen outside the run of days since -- a delivery moved, a
  // unit was finished -- so it is clamped rather than dropped: the nearest edge
  // is closer to where they were than the beginning of the year is.
  useLayoutEffect(() => {
    if (view !== 'board') { placed.current = false; return }
    const el = boardRef.current
    if (!el || !days.length || placed.current) return
    placed.current = true
    let at = null
    try { at = JSON.parse(window.localStorage.getItem('boardAt')) } catch { /* private window */ }
    if (!at || !at.d) return
    const i = Math.max(0, Math.min(days.length - 1, daysBetween(days[0], parseDate(at.d))))
    el.scrollLeft = i * COL
    el.scrollTop = at.top || 0
    if (gripRef.current) gripRef.current.style.transform = `translateX(${el.scrollLeft}px)`
  }, [view, days])

  const loads = useMemo(() => {
    const out = {}
    OPS.forEach((o) => { out[o.key] = days.map(() => 0) })
    scheduled.forEach((j) => OPS.forEach((o) => {
      const s = j.spans[o.key]
      for (let d = strip(s.start); d <= s.end; d = addDays(d, 1))
        if (cal.isWorkday(d)) out[o.key][daysBetween(days[0], d)]++
    }))
    return out
  }, [scheduled, days, cal])

  // Where the work actually is, station by station, day by day. The load rows
  // above count the plan, which under levelling can never exceed a cap and so
  // never reports the shop being over. This counts the projection, so six
  // trailers in a four-bay fabrication shop shows up as six.
  const floorLoads = useMemo(() => {
    const out = {}
    OPS.forEach((o) => { out[o.key] = days.map(() => 0) })
    projected.forEach((p) => OPS.forEach((o) => {
      const s = p.spans[o.key]
      if (!s) return                       // a station already closed has no span
      for (let d = strip(s.start); d <= s.end; d = addDays(d, 1)) {
        if (!cal.isWorkday(d)) continue
        const i = daysBetween(days[0], d)
        if (i >= 0 && i < out[o.key].length) out[o.key][i]++
      }
    }))
    return out
  }, [projected, days, cal])

  const floorOver = OPS.reduce(
    (n, o) => n + floorLoads[o.key].filter((c, i) => cal.isWorkday(days[i]) && c > caps[o.key]).length, 0)

  const overDays = OPS.reduce(
    (n, o) => n + loads[o.key].filter((c, i) => cal.isWorkday(days[i]) && c > caps[o.key]).length, 0)
  const daysOff = days.filter((d) => cal.isOverridden(d) && !cal.isWorkday(d)).length
  const daysOn = days.filter((d) => cal.isOverridden(d) && cal.isWorkday(d)).length
  const atRisk = scheduled.filter((j) => j.late).length
  const sel = scheduled.find((j) => j.id === selected)
  const selPart = sel ? partsById.get(sel.partId) : null
  const selProj = sel ? projById.get(sel.id) : null
  const selStages = sel ? stagesById.get(sel.id) : null
  const selSteps = sel ? stepsByJob.get(sel.id) : null
  // Days done on the station in progress according to the shop's own days-left,
  // which is known even when nobody recorded the day the station opened.
  const selLive = sel && sel.stage !== 'none' && sel.stage !== 'done' ? sel.stage : null
  const selDone = selLive ? sel[selLive] - (sel.daysLeft == null ? sel[selLive] : sel.daysLeft) : 0
  // A unit whose numbers have been tuned away from its part number's standard.
  const selDrift = selPart && (selPart.description !== sel.desc
    || OPS.some((o) => selPart[`${o.key}_days`] !== sel[o.key]))
  const todayT = today.getTime()

  if (status === 'unconfigured') return (
    <div className="shell"><Style />
      <div className="notice">Supabase isn't connected yet. Copy <code>.env.example</code> to <code>.env</code>, add your project URL and anon key, and restart. On Vercel, set the same two values as environment variables.</div>
    </div>
  )
  if (session === undefined) return <div className="shell"><Style /><div className="notice">Checking your sign-in…</div></div>
  if (session === null) return <SignIn />
  if (status === 'loading') return <div className="shell"><Style /><div className="notice">Loading the schedule…</div></div>
  if (status === 'error') return (
    <div className="shell"><Style />
      <div className="notice bad">Couldn't finish loading the schedule: {error}
        {bootErrors.length > 0 && (
          <div style={{ marginTop: 8 }}>Browser reported: {bootErrors.slice(0, 5).join(' | ')}</div>
        )}
      </div>
    </div>
  )

  // One row, rendered for both groups. Defined here rather than beside the
  // board markup so every value it reaches for is already declared -- a
  // reference that runs before its const is the bug that has blanked this page
  // more than once.
  const boardRow = (j) => (
    <Row key={j.id} j={j} days={days} dayIndex={dayIndex} todayT={todayT} cal={cal}
      pn={partsById.get(j.partId)?.part_number} proj={projById.get(j.id)} tracking={trackingEnabled}
      onDragStage={pinsEnabled ? dragStage : undefined}
      steps={stepsByJob.get(j.id)} open={openUnits.has(j.id)}
      onDragStep={stepsEnabled ? dragStep : undefined}
      onDragProjected={trackingEnabled ? dragProjected : undefined}
      onToggleOpen={() => setOpenUnits((o) => {
        const n = new Set(o)
        if (n.has(j.id)) n.delete(j.id); else n.add(j.id)
        return n
      })}
      selected={selected === j.id}
      onSelect={() => setSelected(selected === j.id ? null : j.id)} />
  )

  return (
    <div className="shell">
      <Style />
      <div className="head">
        <div className="title">Shop schedule <span>· scheduled backward from delivery</span></div>
        <div className="stats">
          <div className="views">
            {['board', 'table', 'calendar', ...(trackingEnabled && SHOW_REPORT ? ['report'] : [])].map((v) => (
              <button key={v} className={view === v ? 'on' : ''}
                onClick={() => { setView(v); setSelected(null) }}>
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <label className="toggle">
            <input type="checkbox" checked={leveled} onChange={(e) => setLeveled(e.target.checked)} />
            Level to capacity
          </label>
          <div><b>{scheduled.length}</b> units in plan</div>
          {!trackingEnabled && (
            <div className={atRisk ? 'bad' : ''}><b>{atRisk}</b> {leveled ? 'projected late' : 'behind required start'}</div>
          )}
          <div className={overDays ? 'bad' : ''}><b>{overDays}</b> overloaded station-days</div>
          {trackingEnabled && (<>
            <div className={slipping ? 'bad' : ''}><b>{slipping}</b> slipping</div>
            <div><b>{onFloor}</b> on the floor</div>
          </>)}
          {(daysOff || daysOn) ? (
            <div><b>{daysOff}</b> closed{daysOn ? <> · <b>{daysOn}</b> extra</> : null}</div>
          ) : null}
          <div className="who">
            {session.user.email}
            <button className="btn sm" onClick={() => setShowPassword(true)}>Change password</button>
            <button className="btn sm" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </div>
      </div>

      {view === 'board' ? (<>
      <div className="legend">
        {OPS.map((o) => <div key={o.key}><span className="chip" style={{ background: o.color }} />{o.label}</div>)}
        <div><span className="chip todaychip" />Today</div>
        <div>▼ Delivery</div>
        {trackingEnabled && <div><span className="lanekey" />Plan over projection</div>}
        {pinsEnabled && <div><span className="chip pinchipkey" />Placed by hand</div>}
        <div><span className="chip offchip" />Shop closed</div>
        <label className="sortpick">Sort rows by
          <select value={boardSort} onChange={(e) => pickSort(e.target.value)}>
            <option value="start">Fabrication start</option>
            <option value="delivery">Planned delivery date</option>
            <option value="projected">Projected delivery date</option>
          </select>
        </label>
        <button className="btn sm" onClick={resettleBoard}
          title="Apply the current sort again">Re-sort rows</button>
        {calendarEnabled
          ? <div className="hint">Click any date to close or open that day</div>
          : <div className="hint bad">Day toggles need the <code>day_overrides</code> table — see supabase/schema.sql</div>}
        {pinsEnabled
          ? <div className="hint">Drag the board to pan it; drag a planned bar to place a stage by hand, or an edge to change its days</div>
          : <div className="hint bad">Dragging stages needs the <code>*_pinned_start</code> columns on <code>jobs</code> — see supabase/schema.sql</div>}
      </div>

      <div ref={boardRef} className={`boardwrap${panning ? ' panning' : ''}`}
        onPointerDown={panDown} onScroll={onBoardScroll}>
        <div ref={gridRef} className="grid"
          style={{ gridTemplateColumns: `${labelWidth}px repeat(${days.length}, ${COL}px)` }}>
          <div className="corner" />
          {months.map((m, i) => <div key={i} className="month" style={{ gridColumn: `span ${m.count}` }}>{m.label}</div>)}
          <div className="corner" />
          {days.map((d, i) => {
            const off = !cal.isWorkday(d), set = cal.isOverridden(d)
            return (
              <div key={i}
                className={`dayhead ${off ? 'we' : ''} ${set ? 'ovr' : ''} ${d.getTime() === todayT ? 'today' : ''} ${calendarEnabled ? 'clickable' : ''}`}
                onClick={() => toggleDay(d)}
                title={calendarEnabled
                  ? `${fmt(d)} — ${off ? 'closed' : 'working'}${set ? ' (set by hand)' : ''}. Click to ${off ? 'open' : 'close'}.`
                  : undefined}>
                {d.getDate()}
              </div>
            )
          })}

          {doneRows.length > 0 && (<>
            <div className="secthead grouphead">
              <button className="twist" onClick={toggleDone}
                title={showDone ? 'Hide completed units' : 'Show completed units'}>
                {showDone ? '−' : '+'}</button>
              Complete — {doneRows.length} {doneRows.length === 1 ? 'unit' : 'units'}
            </div>
            <div className="sectfill" style={{ gridColumn: `span ${days.length}` }} />
          </>)}
          {(showDone ? doneRows : []).map(boardRow)}

          {doneRows.length > 0 && (<>
            <div className="secthead">In the shop — {liveRows.length} {liveRows.length === 1 ? 'unit' : 'units'}</div>
            <div className="sectfill" style={{ gridColumn: `span ${days.length}` }} />
          </>)}
          {liveRows.map(boardRow)}

          <div className="secthead">Planned load — units per day</div>
          <div className="sectfill" style={{ gridColumn: `span ${days.length}` }} />
          {OPS.map((o) => (
            <LoadRow key={o.key} op={o} counts={loads[o.key]} cap={caps[o.key]} days={days} todayT={todayT} cal={cal}
              onCap={(v) => saveCap(o.key, v)} />
          ))}

          {trackingEnabled && (<>
            <div className="secthead">On the floor — units per day
              {floorOver ? <span className="overtag"
                title="Station-days where more units are on a station than its cap allows">
                {floorOver} station-days over capacity</span> : null}
            </div>
            <div className="sectfill" style={{ gridColumn: `span ${days.length}` }} />
            {OPS.map((o) => (
              <LoadRow key={`f-${o.key}`} op={o} counts={floorLoads[o.key]} cap={caps[o.key]}
                days={days} todayT={todayT} cal={cal} />
            ))}
          </>)}
        </div>
        <div ref={gripRef} className="colgrip" style={{ left: labelWidth - 3 }}
          onPointerDown={gripDown}
          title="Drag to widen the unit column" />
      </div>
      </>) : view === 'table' ? (
        <OrdersTable rows={tableRows} parts={parts} partsEnabled={partsEnabled}
          onSave={saveJob} onApplyPart={applyPart} onResort={resortTable}
          projById={projById} tracking={trackingEnabled} onAdvance={advanceStage} today={today}
          sort={sort} onSort={sortBy} cal={cal}
          stepsByJob={stepsEnabled ? stepsByJob : null} openUnits={openUnits}
          onToggleOpen={(id) => setOpenUnits((o) => {
            const n = new Set(o)
            if (n.has(id)) n.delete(id); else n.add(id)
            return n
          })}
          onSaveStep={saveStep} onToggleNeed={toggleNeed}
          showDone={showDone} onToggleDone={toggleDone}
          columnOrder={columnOrder} onMoveColumns={moveColumns}
          columnWidths={columnWidths} onResizeColumns={resizeColumns} />
      ) : view === 'calendar' ? (
        <CalendarView rows={scheduled} projById={projById} partsById={partsById} cal={cal}
          today={today} tracking={trackingEnabled} selected={selected}
          onSelect={(id) => setSelected((cur) => (cur === id ? null : id))} />
      ) : (
        <StageReport log={stageLog} jobs={jobs} partsById={partsById}
          stages={stageDateRows} datesEnabled={stageDatesEnabled} />
      )}

      {view !== 'report' && (sel ? (
        <div className="panel">
          <h3>{sel.unit}{sel.desc ? ` — ${sel.desc}` : ''}</h3>
          <div className="field"><span>Unit</span>
            <input value={sel.unit} onChange={(e) => saveJob(sel.id, { unit: e.target.value })} /></div>
          <div className="field"><span>Description</span>
            <input value={sel.desc} onChange={(e) => saveJob(sel.id, { desc: e.target.value })} /></div>
          <div className="field"><span>Delivery date</span>
            <input type="date" value={isoDate(sel.delivery)}
              onChange={(e) => e.target.value && saveJob(sel.id, { delivery: parseDate(e.target.value) })} /></div>
          {partsEnabled && (
            <div className="field"><span>Part number</span>
              <select value={sel.partId || ''} onChange={(e) => applyPart(sel.id, e.target.value)}>
                <option value="">— none —</option>
                {parts.map((p) => <option key={p.id} value={p.id}>{p.part_number}</option>)}
              </select>
            </div>
          )}
          {OPS.map((o) => {
            const list = selSteps ? selSteps[o.key] : []
            const built = list.length > 0
            return (
              <div className="field" key={o.key}>
                <span>{o.label} (working days)</span>
                {/* A station built from steps shows what they add up to; the
                    number is no longer something to type. */}
                {built
                  ? <span className="num built" title={`${list.length} step${list.length === 1 ? '' : 's'} — edit them below`}>
                      {sel[o.key]} <i>from steps</i>
                    </span>
                  : <input className="num" type="number" min="1" value={sel[o.key]}
                      onChange={(e) => saveJob(sel.id, { [o.key]: Math.max(1, parseInt(e.target.value) || 1) })} />}
              </div>
            )
          })}

          {stepsEnabled && (
            <div className="panelsect">
              <h4>Steps</h4>
              {OPS.map((o) => {
                const list = selSteps ? selSteps[o.key] : []
                const plan = stepPlan(list)
                return (
                  <div className="stepgroup" key={o.key}>
                    <div className="stephead">
                      <span className={`chip ${o.key}`}><i />{o.label}</span>
                      <span className="muted">{list.length
                        ? `${list.filter((x) => x.done).length} of ${list.length} done · ${sel[o.key]} d`
                          + (plan.length < list.reduce((n, x) => n + x.days, 0) ? ' (longest chain)' : '')
                        : `${sel[o.key]} d, not broken down`}</span>
                      <button className="btn sm" onClick={() => addStep(sel, o.key)}>Add step</button>
                    </div>
                    {list.map((st, i) => {
                      const off = plan.offset.get(st.id) || 0
                      const label = (x) => (x.name || `Step ${list.indexOf(x) + 1}`)
                      return (
                        <div className={`stepitem${st.done ? ' done' : ''}`} key={st.id}>
                          <div className="steprow">
                            <input type="checkbox" checked={st.done} title="Done"
                              onChange={(e) => saveStep(st.id, { done: e.target.checked })} />
                            <input className="stepname" value={st.name} placeholder={`What happens in step ${i + 1}`}
                              onChange={(e) => saveStep(st.id, { name: e.target.value })} />
                            <input className="stepdays" type="number" min="1" value={st.days}
                              title="Working days"
                              onChange={(e) => saveStep(st.id, { days: Math.max(1, parseInt(e.target.value) || 1) })} />
                            <span className="dlabel">d</span>
                            <span className="stepat" title="Working day of the station this step starts on">
                              day {off + 1}
                            </span>
                            <button className="stepdel" title="Remove this step"
                              onClick={() => removeStep(st.id)}>×</button>
                          </div>
                          {list.length > 1 && (
                            <div className="stepneeds">
                              <span className="nlab">waits for</span>
                              {list.filter((x) => x.id !== st.id).map((x) => (
                                <button key={x.id} type="button"
                                  className={`needchip${(st.needs || []).includes(x.id) ? ' on' : ''}`}
                                  title={`${label(st)} waits for ${label(x)}`}
                                  onClick={() => toggleNeed(list, st, x.id)}>{label(x)}</button>
                              ))}
                              {!(st.needs || []).length && <em>nothing — starts with the station</em>}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
              <p className="foot">Steps do not have to run one after another. Each says what must
                finish before it can start, and a station takes as long as the longest chain through
                them — so work that genuinely happens side by side is planned side by side. A step
                waiting for nothing starts with the station. The typed day count is kept underneath
                and comes back if every step is removed, and ticking a step marks it done without
                shortening the station, because the work still took the days it took.</p>
            </div>
          )}
          {trackingEnabled && (
            <div className="stagebox">
              <div className="field"><span>Stage</span>
                <select value={sel.stage || 'none'} onChange={(e) => setStage(sel, e.target.value)}>
                  {['none', 'fab', 'paint', 'asm', 'done'].map((k) => (
                    <option key={k} value={k}>{STAGE_LABEL[k]}</option>
                  ))}
                </select>
              </div>
              {sel.stage && sel.stage !== 'none' && sel.stage !== 'done' && (
                <>
                  <div className="field"><span>Went into {STAGE_LABEL[sel.stage].toLowerCase()}</span>
                    <input type="date" max={isoDate(today)}
                      value={sel.stageStarted ? isoDate(sel.stageStarted) : ''}
                      onChange={(e) => saveJob(sel.id, { stageStarted: e.target.value ? parseDate(e.target.value) : null })} />
                  </div>
                  <div className="field"><span>Days left on {STAGE_LABEL[sel.stage].toLowerCase()}</span>
                    <input className="num" type="number" min="0"
                      value={sel.daysLeft == null ? sel[sel.stage] : sel.daysLeft}
                      onChange={(e) => saveJob(sel.id, { daysLeft: Math.max(0, parseInt(e.target.value) || 0) })} />
                  </div>
                  <div className="stageline">
                    {!sel.stageStarted
                      ? <span>
                          {selDone > 0
                            ? `${selDone} of ${sel[sel.stage]} days done by the day count, but no start date, `
                            : 'No start date, '}
                          so the days spent aren't counted. Set it if you know when this unit went
                          into {STAGE_LABEL[sel.stage].toLowerCase()}.</span>
                      : selProj && selProj.spent > sel[sel.stage]
                        ? <span className="bad">{selProj.spent} days spent against {sel[sel.stage]} planned — over by {selProj.spent - sel[sel.stage]}.</span>
                        : <span>{selProj ? selProj.spent : 0} of {sel[sel.stage]} planned days spent.</span>}
                  </div>
                </>
              )}
              {sel.stage !== 'done' && (
                <div className="btnrow">
                  <button className="btn" onClick={() => advanceStage(sel)}>
                    Move to {STAGE_LABEL[nextStage(sel.stage || 'none')].toLowerCase()}
                  </button>
                </div>
              )}
            </div>
          )}
          {trackingEnabled && selStages && (
            <div className="panelsect">
              <h4>Stage dates — planned against actual</h4>
              <div className="tablescroll">
                <StageDateTable rows={selStages} compact today={today}
                  logEditable={stageDatesEnabled}
                  onEdit={(r, which, d) => saveStageDates(sel, r.key, { [which]: d })} />
              </div>
              <p className="foot">Planned is the just-in-time plan — the latest each station could
                run and still make {fmt(sel.delivery)} — so it moves when the delivery date, the day
                counts or the shop calendar do. Actual dates are stamped as a station is closed and
                can be corrected here afterwards; the days a closed station took are recounted from
                them. The station on now takes its start from the same field as <em>Went into …</em>
                above and gets its finish when you close it. Clearing both dates forgets that
                station's dates altogether — unknown is not zero.
                {!stageDatesEnabled && ' Correcting a closed station needs the started_on and finished_on columns on stage_log — see supabase/schema.sql.'}</p>
            </div>
          )}
          {pinsEnabled && hasPins(sel) && (
            <div className="pinline">
              <span>Placed by hand — the scheduler works around these rather than choosing their dates:</span>
              <span className="pins">
                {OPS.filter((o) => sel.pins && sel.pins[o.key]).map((o) => (
                  <span key={o.key} className="pintag" style={{ borderColor: o.color, color: o.color }}>
                    {SHORT[o.key]} {fmt(sel.spans[o.key].start)}
                    <button onClick={() => releasePin(sel, o.key)}
                      title={`Hand ${o.label.toLowerCase()} back to the scheduler`}>×</button>
                  </span>
                ))}
                <button className="btn sm" onClick={() => releaseAllPins(sel)}>Release all</button>
              </span>
              {sel.conflict && <span className="bad">A stage sits across one that has to come before
                it. Move it, or release the pin.</span>}
            </div>
          )}
          {selDrift && (
            <div className="driftline">
              Tuned away from {selPart.part_number}'s standard
              ({OPS.map((o) => selPart[`${o.key}_days`]).join(' / ')} days).
              <button className="btn sm" onClick={() => applyPart(sel.id, selPart.id)}>Reset to standard</button>
            </div>
          )}
          <div className={`mustline ${sel.late ? 'bad' : ''}`}>
            {leveled
              ? sel.late
                ? `Not enough station capacity to finish by ${fmt(sel.delivery)} — projected completion ${fmt(sel.spans.asm.end)}, ${sel.lateDays} working day${sel.lateDays === 1 ? '' : 's'} late. Free up capacity, shorten an operation, or move the delivery.`
                : `Scheduled just-in-time within capacity — fabrication starts ${fmt(sel.mustStart)}, ${sel.slack} working day${sel.slack === 1 ? '' : 's'} of slack.`
              : sel.late
                ? `Fabrication needed to start ${fmt(sel.mustStart)} — ${Math.abs(sel.slack)} working day${Math.abs(sel.slack) === 1 ? '' : 's'} behind.`
                : `Fabrication must start by ${fmt(sel.mustStart)} — ${sel.slack} working day${sel.slack === 1 ? '' : 's'} of slack.`}
          </div>
          <div className="btnrow">
            <button className="btn" onClick={() => setSelected(null)}>Close</button>
            <button className="btn danger" onClick={() => removeJob(sel.id)}>Remove unit</button>
          </div>
        </div>
      ) : (
        <div className="addrow">
          {partsEnabled && (
            <select value={addPart} onChange={(e) => setAddPart(e.target.value)} title="Start this unit from a part number">
              <option value="">Blank unit</option>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>{p.part_number}{p.description ? ` — ${p.description}` : ''}</option>
              ))}
            </select>
          )}
          <button className="btn" onClick={addJob}>Add unit</button>
          {partsEnabled
            ? <button className="btn" onClick={() => setShowParts((v) => !v)}>
                {showParts ? 'Hide' : 'Edit'} part numbers ({parts.length})
              </button>
            : <span className="hint bad">Part numbers need the <code>part_numbers</code> table — see supabase/schema.sql</span>}
        </div>
      ))}
      {showParts && partsEnabled && view !== 'report' && (
        <div className="panel wide">
          <h3>Part numbers</h3>
          <p className="sub">The standard build for each model. Picking one when you add a unit copies
            these onto that unit — editing a part number here never reschedules units already in the shop.</p>
          <div className="parthead">
            <span>Part number</span><span>Description</span>
            {OPS.map((o) => <span key={o.key}>{SHORT[o.key]}</span>)}
            <span />
          </div>
          {parts.map((p) => (
            <div className="partrow" key={p.id}>
              <input value={p.part_number} onChange={(e) => savePart(p.id, { part_number: e.target.value })} />
              <input value={p.description} onChange={(e) => savePart(p.id, { description: e.target.value })} />
              {OPS.map((o) => (
                <input key={o.key} type="number" min="1" value={p[`${o.key}_days`]}
                  onChange={(e) => savePart(p.id, { [`${o.key}_days`]: Math.max(1, parseInt(e.target.value) || 1) })} />
              ))}
              <button className="btn danger sm" onClick={() => removePart(p.id)}>Remove</button>
            </div>
          ))}
          {parts.length === 0 && (
            <div className="sub">No part numbers yet — add one, then pick it when you add a unit.</div>
          )}
          <div className="btnrow"><button className="btn" onClick={newPart}>Add part number</button></div>
        </div>
      )}
      {showPassword && <ChangePassword email={session.user.email} onClose={() => setShowPassword(false)} />}
      {scheduleError && <div className="notice bad">Couldn't build the schedule: {scheduleError}</div>}
      {projectError && <div className="notice bad">Couldn't project remaining work: {projectError}</div>}
      {error && status === 'ready' && <div className="notice bad">Last change didn't save: {error}</div>}
    </div>
  )
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    // On success the auth listener swaps this screen for the board.
    if (error) { setErr(error.message); setBusy(false) }
  }

  return (
    <div className="shell center">
      <Style />
      <form className="loginbox" onSubmit={submit}>
        <h1>Choice Trailers</h1>
        <p className="sub">Shop schedule — sign in to continue.</p>
        <label>Email
          <input type="email" autoComplete="username" required autoFocus
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>Password
          <input type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <div className="loginerr">{err}</div>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="sub small">Need an account, or forgotten your password? Ask whoever set up the board.</p>
      </form>
    </div>
  )
}

function OrdersTable({ rows, parts, partsEnabled, onSave, onApplyPart, onResort, projById, tracking,
  onAdvance, today, sort, onSort, cal, stepsByJob, openUnits, onToggleOpen, onSaveStep, onToggleNeed,
  showDone, onToggleDone, columnOrder, onMoveColumns, columnWidths, onResizeColumns }) {
  // Which column is being dragged, and which one the pointer is over. Transient
  // -- where the columns end up is the caller's to keep.
  const [dragCol, setDragCol] = useState(null)
  const [overCol, setOverCol] = useState(null)
  // The width a column is being dragged to, live. Committed on release, so a
  // resize is one write rather than one per pixel.
  const [sizing, setSizing] = useState(null)
  // A pointer down on a resize grip must not also start a column drag. The
  // check happens inside dragstart, which is why it is a ref: a state flag set
  // in pointerdown might not have re-rendered by then.
  const resizingRef = useRef(false)
  // The widths as they stand now, for the handlers to build on. A handler that
  // spread its own render's copy would drop a width set since it was made --
  // the same trap as reading the dragged column out of state.
  const widthsRef = useRef(columnWidths)
  widthsRef.current = columnWidths
  // Hooks first, then the empty case: a return above them would make the hook
  // calls conditional the moment the last unit is deleted.
  if (rows.length === 0) return <div className="notice">No units yet. Add one below.</div>
  // How wide a step's own row has to be to reach the end of the table.
  const colSpan = 2 + (tracking ? 3 : 0) + 2 + (partsEnabled ? 1 : 0) + 1 + OPS.length
  // Tabbing out of a date crosses every other field before reaching the next
  // one, which is the wrong shape for working down the book. Enter jumps
  // straight to the date below. Arrow keys are left alone — the browser uses
  // them to step the day/month/year the cursor is sitting on.
  const toNextDate = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const next = document.querySelector(`[data-daterow="${Number(e.currentTarget.dataset.daterow) + 1}"]`)
    if (next) next.focus()
    else e.currentTarget.blur()
  }
  const variance = (p) => {
    if (!p) return { text: '—', cls: '' }
    if (p.complete) return { text: 'complete', cls: 'good' }
    if (p.variance > 0) return { text: `+${p.variance}d late`, cls: 'bad' }
    if (p.variance < 0) return { text: `${Math.abs(p.variance)}d slack`, cls: 'good' }
    return { text: 'on target', cls: '' }
  }

  // The columns, in the order they are drawn, each one carrying its own heading
  // and its own cell. One list rather than two matching ones: a heading and the
  // cells under it cannot drift apart if they are the same entry, which is what
  // makes the order safe to move.
  const defs = [
    {
      key: 'unit', label: 'Unit', cls: 'w-unit',
      cell: ({ j, hasSteps, open }) => (
        <td key="unit" className="unitcell"><div className="cellflex">
          {hasSteps
            ? <button className="twist" title={open ? 'Hide steps' : 'Show steps'}
                onClick={() => onToggleOpen(j.id)}>{open ? '−' : '+'}</button>
            : <span className="twist gap" />}
          <input value={j.unit} onChange={(e) => onSave(j.id, { unit: e.target.value })} />
        </div></td>
      ),
    },
    {
      key: 'delivery', label: 'Target date', cls: 'w-date',
      cell: ({ j, i }) => (
        <td key="delivery">
          <input type="date" data-daterow={i} value={isoDate(j.delivery)}
            onKeyDown={toNextDate}
            onChange={(e) => e.target.value && onSave(j.id, { delivery: parseDate(e.target.value) })} />
        </td>
      ),
    },
    tracking && {
      key: 'stage', label: 'Stage', cls: 'w-stage',
      cell: ({ j, live }) => (
        <td key="stage">
          <button className="stagebtn" onClick={() => onAdvance(j)} disabled={live === 'done'}
            title={live === 'done' ? 'Complete'
              : `Move ${j.unit} to ${STAGE_LABEL[nextStage(live)]}`
                + (live !== 'none' && !j.stageStarted ? ' — no start date set, so the days spent are not counted' : '')}>
            <span className={`chip ${live}`}><i />{STAGE_LABEL[live]}</span>
          </button>
        </td>
      ),
    },
    tracking && {
      key: 'since', label: 'In stage since', cls: 'w-since',
      cell: ({ j, p, live, planned, over, done }) => (
        <td key="since">
          {planned ? (
            <div className="since">
              <input type="date" max={isoDate(today)}
                value={j.stageStarted ? isoDate(j.stageStarted) : ''}
                title={`When ${j.unit} went into ${STAGE_LABEL[live].toLowerCase()}`}
                onChange={(e) => onSave(j.id, { stageStarted: e.target.value ? parseDate(e.target.value) : null })} />
              <span className={`sincedays ${over ? 'bad' : ''}`}>
                {j.stageStarted ? `${p.spent} of ${planned} d${over ? ' ⚠' : ''}`
                  : done > 0 ? `${done} of ${planned} d done · no start date`
                  : `not started · ${planned} d booked`}
              </span>
            </div>
          ) : <span className="calc">—</span>}
        </td>
      ),
    },
    tracking && {
      key: 'left', label: 'Left', cls: 'w-num',
      cell: ({ j, planned }) => (
        <td key="left">
          {planned
            ? <input type="number" min="0" value={j.daysLeft == null ? planned : j.daysLeft}
                onChange={(e) => onSave(j.id, { daysLeft: Math.max(0, parseInt(e.target.value) || 0) })} />
            : <span className="calc">—</span>}
        </td>
      ),
    },
    {
      key: 'projected', label: 'Projected', cls: 'w-calc',
      cell: ({ p }) => <td key="projected" className="calc">{p && p.projectedEnd ? fmtNum(p.projectedEnd) : '—'}</td>,
    },
    {
      key: 'variance', label: 'Variance', cls: 'w-calc',
      cell: ({ vr }) => <td key="variance" className={`calc ${vr.cls}`}>{vr.text}</td>,
    },
    partsEnabled && {
      key: 'part', label: 'Part number', cls: 'w-pn',
      cell: ({ j }) => (
        <td key="part">
          <select value={j.partId || ''} onChange={(e) => onApplyPart(j.id, e.target.value)}>
            <option value="">—</option>
            {parts.map((p2) => <option key={p2.id} value={p2.id}>{p2.part_number}</option>)}
          </select>
        </td>
      ),
    },
    {
      key: 'desc', label: 'Description',
      cell: ({ j }) => (
        <td key="desc"><input value={j.desc} onChange={(e) => onSave(j.id, { desc: e.target.value })} /></td>
      ),
    },
    ...OPS.map((o) => ({
      key: o.key, label: SHORT[o.key], cls: 'w-num',
      cell: ({ j, st }) => {
        const built = Boolean(st && st[o.key].length)
        return (
          <td key={o.key}>
            {/* built from steps: the number is the longest chain, not something to type */}
            {built
              ? <span className="calc built" title="Built from this station's steps">{j[o.key]}</span>
              : <input type="number" min="1" value={j[o.key]}
                  onChange={(e) => onSave(j.id, { [o.key]: Math.max(1, parseInt(e.target.value) || 1) })} />}
          </td>
        )
      },
    })),
  ].filter(Boolean)

  // A remembered order goes stale: a column can be switched off since it was
  // saved, and a new one will not be in it at all. Keep the columns it names in
  // the order it names them, then put anything it is missing back at the place
  // it would have had by default, rather than dumping it on the end.
  const cols = (() => {
    const pos = new Map((columnOrder || []).map((k, n) => [k, n]))
    const out = defs.filter((d) => pos.has(d.key)).sort((a, b) => pos.get(a.key) - pos.get(b.key))
    defs.forEach((d, n) => { if (!pos.has(d.key)) out.splice(Math.min(n, out.length), 0, d) })
    return out
  })()
  const moved = cols.some((c, n) => c.key !== defs[n].key)
    || Boolean(columnWidths && Object.keys(columnWidths).length)

  // Dropping on a column puts the dragged one in its place: after it when the
  // drag came from the left, before it when it came from the right -- which is
  // the side the pointer is already on. Which column is moving comes off the
  // drag itself rather than out of state: the state is there to grey the
  // heading, and reading a render's copy of it to decide where a column lands
  // would be trusting a re-render to have happened first.
  const dropOn = (from, target) => {
    const keys = cols.map((c) => c.key)
    if (!from || from === target || !keys.includes(from)) return
    const after = keys.indexOf(from) < keys.indexOf(target)
    const next = keys.filter((k) => k !== from)
    next.splice(next.indexOf(target) + (after ? 1 : 0), 0, from)
    onMoveColumns(next)
    setDragCol(null)
    setOverCol(null)
  }

  // Dragging a column's right edge sets its width. Window listeners rather than
  // a captured pointer: capturing redirects the click that follows to the
  // capturing element, which is how the board once lost its day toggles.
  const COLW_MIN = 56, COLW_MAX = 640
  const widthAt = (start, x0, x) => Math.round(Math.min(COLW_MAX, Math.max(COLW_MIN, start + x - x0)))
  const startResize = (e, key) => {
    if (e.button) return
    // No preventDefault here: cancelling pointerdown takes the mouse events
    // built on top of it with it, and the double-click is one of those. Text
    // selection is already off on the heading, which is what it would be for.
    e.stopPropagation()
    resizingRef.current = true
    const start = e.currentTarget.parentElement.getBoundingClientRect().width
    const x0 = e.clientX
    const move = (ev) => setSizing({ key, width: widthAt(start, x0, ev.clientX) })
    const up = (ev) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      resizingRef.current = false
      setSizing(null)
      // Worked out from the pointer again rather than read back out of state,
      // which on the last move may not have rendered yet.
      const width = widthAt(start, x0, ev.clientX)
      // A click on the grip that moved nothing is not a resize. Recording it
      // would pin the column at its default and light up Reset columns for a
      // change nobody made.
      if (width !== Math.round(start)) onResizeColumns({ ...(widthsRef.current || {}), [key]: width })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // Double-clicking the divider sizes the column to fit what is in it -- the
  // heading included, and only the rows on screen, because a folded-away group
  // is not what anyone is looking at.
  const autoFit = (key) => {
    const cells = document.querySelectorAll(`.orders [data-col="${key}"]`)
    if (!cells.length) return
    let w = 0
    cells.forEach((c) => { w = Math.max(w, fitWidth(c)) })
    onResizeColumns({ ...(widthsRef.current || {}),
      [key]: Math.round(Math.min(COLW_MAX, Math.max(COLW_MIN, w + 2))) })
  }
  const widthOf = (key) => (sizing && sizing.key === key ? sizing.width
    : columnWidths ? columnWidths[key] : undefined)

  // Every column sorts, and every column moves. The arrow marks the one sorted
  // and which way; dragging the heading puts the column somewhere else. A click
  // still sorts -- a drag is a drag, and the browser tells the two apart for
  // us. That is why this is HTML drag and drop rather than the pointer handling
  // the bars use: capturing a pointer here would swallow the click.
  const th = (col) => (
    <th key={col.key} data-col={col.key} className={`${col.cls || ''} draghead`
      + (dragCol === col.key ? ' dragging' : '')
      + (overCol === col.key && dragCol && dragCol !== col.key ? ' dropinto' : '')}
      style={widthOf(col.key) ? { width: widthOf(col.key) } : undefined}
      draggable
      onDragStart={(e) => {
        if (resizingRef.current) { e.preventDefault(); return }
        e.dataTransfer.effectAllowed = 'move'
        // Firefox starts no drag at all unless the transfer carries something.
        e.dataTransfer.setData('text/plain', col.key)
        setDragCol(col.key)
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverCol(col.key) }}
      onDragLeave={() => setOverCol((k) => (k === col.key ? null : k))}
      onDrop={(e) => { e.preventDefault(); dropOn(e.dataTransfer.getData('text/plain') || dragCol, col.key) }}
      onDragEnd={() => { setDragCol(null); setOverCol(null) }}>
      <button type="button" className={`sortbtn ${sort.key === col.key ? 'on' : ''}`}
        onClick={() => onSort(col.key)}
        title={`Sort by ${col.label.toLowerCase()} — or drag the heading to move the column`}
        aria-sort={sort.key === col.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
        {col.label}<span className="arrow">{sort.key === col.key ? (sort.dir > 0 ? '▲' : '▼') : ''}</span>
      </button>
      <span className="thgrip" draggable={false}
        onPointerDown={(e) => startResize(e, col.key)}
        onDoubleClick={() => autoFit(col.key)}
        title="Drag to resize this column, double-click to fit its contents" />
    </th>
  )


  // Finished units are listed together above the live ones rather than mixed
  // through them, and fold away as a group. The running index carries across
  // both so Enter still steps from one target date to the next.
  const doneList = rows.filter((j) => j.stage === 'done')
  const liveList = rows.filter((j) => j.stage !== 'done')
  const shown = showDone ? doneList : []

  // One unit's rows -- the work order itself and, when it is open, its
  // steps. Named rather than inlined so the completed group and the live
  // group render exactly the same thing.
  const rowFor = (j, i) => {
    const p = projById.get(j.id)
    const live = j.stage || 'none'
    const planned = live === 'none' || live === 'done' ? 0 : j[live]
    const over = planned > 0 && p && p.spent > planned
    // Days already done, taken from what the shop says is left rather
    // than from the calendar. A unit put on the board part-way through a
    // station has no start date — the normal case when tracking begins —
    // but its days-left still says work has happened, and reporting the
    // whole booking instead would call the row untouched.
    const done = planned > 0 ? planned - (j.daysLeft == null ? planned : j.daysLeft) : 0
    const vr = variance(p)
    const st = stepsByJob ? stepsByJob.get(j.id) : null
    const hasSteps = Boolean(st && OPS.some((o) => st[o.key].length))
    const open = Boolean(openUnits && openUnits.has(j.id))
    // Everything a cell might need, worked out once for the row rather than
    // once per column.
    const cell = { j, i, p, live, planned, over, done, vr, st, hasSteps, open }
    return (
      <Fragment key={j.id}>
      <tr className={p && p.slipping ? 'late' : ''}>
        {/* the column's name on every cell, so fitting one can find its own */}
        {cols.map((c) => cloneElement(c.cell(cell), { 'data-col': c.key }))}
      </tr>
  
      {/* The unit's steps, listed under it the way a work order reads:
          what happens, how long it takes, when it runs, what it waits
          on. Parallel steps show the same dates as each other, which is
          the whole point of them. */}
      {open && hasSteps && OPS.map((o) => {
        const list = st[o.key]
        if (!list.length) return null
        const spans = stepSpans(j.spans[o.key].start, list, cal)
        return spans.map((x) => {
          const label = (y) => (y.name || `Step ${list.findIndex((z) => z.id === y.id) + 1}`)
          return (
            <tr key={x.id} className={`tstep${x.done ? ' done' : ''}`}>
              {/* One cell across the whole table. The Unit column is
                  130px of work-order number and a step name needs more
                  room than that, so the row indents instead of trying
                  to line up with columns that mean something else. */}
              <td colSpan={colSpan} className="stepcell"><div className="cellflex">
                <span className="twist gap" />
                <input type="checkbox" checked={x.done} title="Done"
                  onChange={(e) => onSaveStep(x.id, { done: e.target.checked })} />
                <input className="stepname-t" value={x.name}
                  placeholder={`Step ${list.findIndex((z) => z.id === x.id) + 1}`}
                  onChange={(e) => onSaveStep(x.id, { name: e.target.value })} />
                <span className={`chip ${o.key} fixed`}><i />{SHORT[o.key]}</span>
                <span className="daysbox">
                  <input className="stepdays" type="number" min="1" value={x.days} title="Working days"
                    onChange={(e) => onSaveStep(x.id, { days: Math.max(1, parseInt(e.target.value) || 1) })} />
                  <span className="dlabel">d</span>
                </span>
                <span className="tdates">{fmt(x.start)} – {fmt(x.end)}</span>
                {list.length > 1 && (
                  <span className="stepneeds inline">
                    <span className="nlab">waits for</span>
                    {list.filter((y) => y.id !== x.id).map((y) => (
                      <button key={y.id} type="button"
                        className={`needchip${(x.needs || []).includes(y.id) ? ' on' : ''}`}
                        title={`${label(x)} waits for ${label(y)}`}
                        onClick={() => onToggleNeed(list, x, y.id)}>{label(y)}</button>
                    ))}
                    {!(x.needs || []).length && <em>nothing</em>}
                  </span>
                )}
              </div></td>
            </tr>
          )
        })
      })}
      </Fragment>
    )
  }

  return (
    <div className="tablewrap">
      <div className="tablehint">
        <span>Click a column to sort, drag its heading to move it, drag its right edge to resize it.
          Enter a target date and press <kbd>Enter</kbd> to drop to the next one — rows hold their
          place while you type.</span>
        <button className="btn sm" onClick={onResort} title="Apply the current sort again">Re-sort</button>
        {/* only worth offering once the order has actually been changed */}
        {moved && (
          <button className="btn sm" onClick={() => { onMoveColumns(null); onResizeColumns(null) }}
            title="Put the columns back in their original order and width">Reset columns</button>
        )}
      </div>
      <table className="orders">
        <thead>
          <tr>{cols.map(th)}</tr>
        </thead>
        <tbody>
          {doneList.length > 0 && (
            <tr className="grouprow">
              <td colSpan={colSpan}><div className="cellflex">
                <button className="twist" onClick={onToggleDone}
                  title={showDone ? 'Hide completed units' : 'Show completed units'}>
                  {showDone ? '−' : '+'}</button>
                <span>Complete — {doneList.length} {doneList.length === 1 ? 'unit' : 'units'}</span>
              </div></td>
            </tr>
          )}
          {shown.map(rowFor)}
          {doneList.length > 0 && (
            <tr className="grouprow">
              <td colSpan={colSpan}><div className="cellflex">
                <span className="twist gap" />
                <span>In the shop — {liveList.length} {liveList.length === 1 ? 'unit' : 'units'}</span>
              </div></td>
            </tr>
          )}
          {liveList.map((j, i) => rowFor(j, i + shown.length))}
        </tbody>
      </table>
    </div>
  )
}

const MIN_PASSWORD = 8

function ChangePassword({ email, onClose }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async (e) => {
    e.preventDefault()
    if (next !== confirm) return setErr("The two new passwords don't match.")
    if (next.length < MIN_PASSWORD) return setErr(`Use at least ${MIN_PASSWORD} characters.`)
    setBusy(true)
    setErr('')
    // Check the current password first: a signed-in session left open on a shop
    // machine shouldn't be enough on its own to take the account over.
    const { error: badCurrent } = await supabase.auth.signInWithPassword({ email, password: current })
    if (badCurrent) {
      setBusy(false)
      return setErr('Current password is incorrect.')
    }
    const { error } = await supabase.auth.updateUser({ password: next })
    setBusy(false)
    if (error) return setErr(error.message)
    setDone(true)
  }

  return (
    <div className="modalwrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="loginbox" onSubmit={submit}>
        <h1>Change password</h1>
        <p className="sub">Signed in as {email}.</p>
        {done ? (
          <>
            <div className="loginok">Password changed. Use the new one next time you sign in.</div>
            <button className="btn primary" type="button" onClick={onClose}>Done</button>
          </>
        ) : (
          <>
            <label>Current password
              <input type="password" autoComplete="current-password" required autoFocus
                value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
            <label>New password
              <input type="password" autoComplete="new-password" required
                value={next} onChange={(e) => setNext(e.target.value)} />
            </label>
            <label>New password again
              <input type="password" autoComplete="new-password" required
                value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {err && <div className="loginerr">{err}</div>}
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Change password'}
            </button>
            <button className="btn linkish" type="button" onClick={onClose}>Cancel</button>
            <p className="sub small">At least {MIN_PASSWORD} characters. There's no email reset on this
              board — if you forget it, whoever set the board up has to reset it for you.</p>
          </>
        )}
      </form>
    </div>
  )
}

// Deliveries laid out on a month grid. The board answers "when does the work
// happen"; this answers "what is going out the door in October", which is the
// question the front office asks and the board is a poor shape for.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = (d) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

function CalendarView({ rows, projById, partsById, cal, today, tracking, selected, onSelect }) {
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const step = (n) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1))

  const byDay = useMemo(() => {
    const m = new Map()
    rows.forEach((j) => {
      const k = isoDate(j.delivery)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(j)
    })
    m.forEach((list) => list.sort((a, b) =>
      String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true })))
    return m
  }, [rows])

  // Whole weeks, Sunday to Saturday, so the grid is always seven across.
  const cells = useMemo(() => {
    const first = strip(new Date(month.getFullYear(), month.getMonth(), 1))
    const last = strip(new Date(month.getFullYear(), month.getMonth() + 1, 0))
    const out = []
    for (let d = addDays(first, -first.getDay()); d <= addDays(last, 6 - last.getDay()); d = addDays(d, 1)) out.push(d)
    return out
  }, [month])

  const inMonth = rows.filter((j) => j.delivery.getFullYear() === month.getFullYear()
    && j.delivery.getMonth() === month.getMonth())
  const slipping = tracking
    ? inMonth.filter((j) => { const p = projById.get(j.id); return p && p.slipping }).length
    : inMonth.filter((j) => j.late).length
  // Where the work actually is, so "nothing this month" doesn't look like a bug
  // when every delivery is a month either side of the one being looked at.
  const near = useMemo(() => {
    const ms = rows.map((j) => j.delivery).sort((a, b) => a - b)
    return { first: ms[0] || null, last: ms[ms.length - 1] || null }
  }, [rows])
  const todayT = today.getTime()

  return (
    <div className="calwrap">
      <div className="calhead">
        <div className="calnav">
          <button className="btn sm" onClick={() => step(-1)} aria-label="Previous month">‹</button>
          <h3>{MONTH(month)}</h3>
          <button className="btn sm" onClick={() => step(1)} aria-label="Next month">›</button>
          <button className="btn sm" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>
            Today
          </button>
        </div>
        <div className="calstats">
          <div><b>{inMonth.length}</b> {inMonth.length === 1 ? 'delivery' : 'deliveries'} this month</div>
          {tracking && <div className={slipping ? 'bad' : ''}><b>{slipping}</b> not projected to make it</div>}
          {inMonth.length === 0 && near.first && (
            <div className="muted">
              Deliveries run {fmt(near.first)} to {fmt(near.last)}
              {near.last.getFullYear() !== today.getFullYear() ? ` ${near.last.getFullYear()}` : ''}
            </div>
          )}
        </div>
      </div>

      <div className="calgrid">
        {DOW.map((d) => <div key={d} className="caldow">{d}</div>)}
        {cells.map((d) => {
          const list = byDay.get(isoDate(d)) || []
          const other = d.getMonth() !== month.getMonth()
          const off = !cal.isWorkday(d)
          return (
            <div key={isoDate(d)}
              className={`calcell${other ? ' other' : ''}${off ? ' off' : ''}${d.getTime() === todayT ? ' today' : ''}`}>
              <div className="caldate">{d.getDate()}
                {/* Only days set by hand get a word. Every Saturday being
                    labelled "closed" is noise; a closed Thanksgiving, or a
                    Saturday opened for overtime, is the thing worth reading. */}
                {!other && cal.isOverridden(d) && (
                  <span className={`calclosed${off ? '' : ' on'}`}
                    title={off ? 'Shop closed this day' : 'Shop open this day'}>
                    {off ? 'closed' : 'open'}
                  </span>
                )}
              </div>
              {list.map((j) => {
                const p = projById.get(j.id)
                const late = tracking ? p && p.slipping : j.late
                const done = tracking && p && p.complete
                const pn = (partsById.get(j.partId) || {}).part_number
                return (
                  <button key={j.id} type="button"
                    className={`dlv${late ? ' slip' : ''}${done ? ' done' : ''}${selected === j.id ? ' sel' : ''}`}
                    onClick={() => onSelect(j.id)}
                    title={`${j.unit}${j.desc ? ` — ${j.desc}` : ''}\nDue ${fmt(j.delivery)}`
                      + (tracking && p && p.projectedEnd ? `\nProjected ${fmt(p.projectedEnd)}` : '')
                      + (late ? ` — ${p ? p.variance : j.lateDays} working days late` : '')}>
                    <span className="u">{j.unit}</span>
                    {late && <span className="v">+{p ? p.variance : j.lateDays}d</span>}
                    {(pn || j.desc) && <span className="m">{pn || j.desc}</span>}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      <p className="calfoot">Each unit sits on the date it is due out. Click one to open it below.
        Days the shop is closed are shaded — a delivery landing on one is worth a second look.</p>
    </div>
  )
}

// The four dates for a station: what the plan says it should run, and what it
// actually did. A station not yet closed has no actual finish — the projection
// stands in for it, marked as a projection, because a guess printed as a fact
// is how a board stops being believed.
function StageDateTable({ rows, showUnit, showVar, showState, compact, onEdit, logEditable, today }) {
  const date = (d) => (d ? fmtNum(d) : <span className="muted">—</span>)
  // What can be corrected by hand, and what has to be corrected some other way.
  // A station that hasn't run has no actual dates to give; the one in progress
  // has a start but no finish, because a station finishes by being closed —
  // typing a date into it would close it behind the user's back.
  const canEdit = (r, which) => !onEdit ? false
    : r.state === 'pending' ? false
    : r.state === 'active' ? which === 'start'
    : logEditable
  const edit = (r, which, value, bounds) => (
    <input type="date" className="dateedit" value={value ? isoDate(value) : ''}
      {...bounds}
      title={`When ${r.unit ? `${r.unit} ` : ''}${which === 'start' ? 'went into' : 'came out of'} ${STAGE_LABEL[r.key].toLowerCase()}`}
      onChange={(e) => onEdit(r, which, e.target.value ? parseDate(e.target.value) : null)} />
  )
  const delta = (n) => {
    if (n == null) return <span className="muted">—</span>
    if (n === 0) return <span className="good">on plan</span>
    return <span className={n > 0 ? 'bad' : 'good'}>{n > 0 ? `+${n}` : n} d</span>
  }
  const STATE = { closed: 'Closed', active: 'On now', pending: 'Not started' }
  return (
    <table className="report stagedates">
      <thead>
        <tr>
          {showUnit && <th>Unit</th>}
          <th>Station</th>
          <th>Planned start</th><th>Planned finish</th>
          <th>Actual start</th><th>Actual finish</th>
          {showVar && <><th className="r">Start Δ</th><th className="r">Finish Δ</th></>}
          {showState && <th>Status</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.jobId ? `${r.jobId}-${r.key}` : r.key} className={r.state === 'active' ? 'onnow' : ''}>
            {showUnit && <td className="strong">{r.unit}</td>}
            <td><span className={`chip ${r.key}`}><i />{compact ? SHORT[r.key] : STAGE_LABEL[r.key]}</span></td>
            <td className="n">{date(r.plan && r.plan.start)}</td>
            <td className="n">{date(r.plan && r.plan.end)}</td>
            <td className="n">
              {canEdit(r, 'start')
                // A station cannot have opened after it closed, nor in the future.
                ? edit(r, 'start', r.actual.start, {
                    max: isoDate(r.actual.finish && r.actual.finish < today ? r.actual.finish : today),
                  })
                : date(r.actual.start)}
            </td>
            <td className="n">
              {canEdit(r, 'finish')
                ? edit(r, 'finish', r.actual.finish, {
                    min: r.actual.start ? isoDate(r.actual.start) : undefined,
                    max: isoDate(today),
                  })
                : r.actual.finish ? fmt(r.actual.finish)
                : r.projected ? <span className="muted">proj {fmt(r.projected.end)}</span>
                : <span className="muted">—</span>}
            </td>
            {showVar && <>
              <td className="r n">{delta(r.startVar)}</td>
              <td className="r n">{delta(r.finishVar)}</td>
            </>}
            {showState && <td className="muted">{STATE[r.state]}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// How each closed station actually went against what was booked for it.
function StageReport({ log, jobs, partsById, stages, datesEnabled }) {
  const rows = useMemo(() => {
    const byJob = new Map(jobs.map((j) => [j.id, j]))
    // A station whose dates are only half filled in has no days figure yet.
    // It still shows in the stage-date table above; it just can't be averaged.
    return (log || []).filter((l) => l.actual_days != null).map((l) => {
      const j = byJob.get(l.job_id)
      const part = j ? partsById.get(j.partId) : null
      return {
        key: `${l.job_id}-${l.stage}`,
        stage: l.stage,
        unit: j ? j.unit : '—',
        // the catalogue entry when there is one; the unit's own description is
        // the next best thing, since that is where the model name lives today
        model: (part && part.part_number) || (j && j.desc) || '—',
        planned: l.planned_days,
        actual: l.actual_days,
        diff: l.actual_days - l.planned_days,
        started: l.started_on ? parseDate(l.started_on) : null,
        finished: l.finished_on ? parseDate(l.finished_on) : null,
        closed: l.closed_on ? parseDate(l.closed_on) : null,
      }
    }).sort((a, b) => ((b.finished || b.closed) || 0) - ((a.finished || a.closed) || 0))
  }, [log, jobs, partsById])

  const roll = (rs) => {
    const planned = rs.reduce((n, r) => n + r.planned, 0)
    const actual = rs.reduce((n, r) => n + r.actual, 0)
    return { n: rs.length, planned, actual, diff: actual - planned,
      pct: planned ? Math.round((actual - planned) / planned * 100) : 0 }
  }
  const overall = roll(rows)
  const byStation = OPS.map((o) => ({ op: o, ...roll(rows.filter((r) => r.stage === o.key)) }))
  const byModel = useMemo(() => {
    const names = [...new Set(rows.map((r) => r.model))]
    return names.map((model) => {
      const rs = rows.filter((r) => r.model === model)
      const per = {}
      OPS.forEach((o) => {
        const sub = rs.filter((r) => r.stage === o.key)
        per[o.key] = sub.length ? { n: sub.length, ...roll(sub) } : null
      })
      return { model, per, ...roll(rs) }
    }).sort((a, b) => b.n - a.n || b.pct - a.pct)
  }, [rows])

  const pct = (v) => (v > 0 ? `+${v}%` : v < 0 ? `${v}%` : 'on estimate')
  const cls = (v) => (v > 5 ? 'bad' : v < -5 ? 'good' : '')
  const avg = (t, n) => (n ? (t / n).toFixed(t / n % 1 ? 1 : 0) : '—')

  // Planned against actual dates. This stands whether or not anything has been
  // closed out yet — before the first closure it is still the answer to when
  // each station is meant to run.
  const dateSection = (
    <div className="repsect">
      <h3>Stage dates — planned against actual</h3>
      <div className="tablescroll">
        <StageDateTable rows={stages || []} showUnit showVar showState />
      </div>
      <p className="foot">
        Planned start and finish are the just-in-time plan — the latest each station could run and
        still make the delivery date, capacity aside — so they move when a delivery date, a day
        count or the shop calendar changes, but not when levelling is switched on or off. Actual
        start is the day the unit went into the station and actual finish the day that station was
        closed; both are stamped as it closes and can be corrected afterwards on the unit itself, in
        the panel under the board or table. Δ is working days against plan, so a negative start
        means the station opened earlier than it had to. A station still open shows where the
        projection puts its finish.
        {datesEnabled === false && ' Actual dates need the started_on and finished_on columns on stage_log — see supabase/schema.sql.'}
      </p>
    </div>
  )

  if (rows.length === 0) return (
    <div className="reportwrap">
      <div className="empty">
        <h3>Nothing closed out yet</h3>
        <p>Every time a station is closed with <strong>Move to …</strong>, the days it was
          booked for and the days it actually took are recorded here. After a dozen trailers
          this answers whether an 80-ton RGN really takes twelve fab days.</p>
        <p style={{ marginTop: 10 }}>Stations closed without a start date aren't recorded — the
          days they took are unknown, not zero. Units already on the floor before tracking began
          will usually go uncounted for their current station, and start counting at the next one.</p>
      </div>
      {dateSection}
    </div>
  )

  return (
    <div className="reportwrap">
      <div className="rephead">
        <div><b>{overall.n}</b> stations closed</div>
        <div className={cls(overall.pct)}><b>{pct(overall.pct)}</b> against estimate overall</div>
        <div><b>{overall.actual - overall.planned > 0 ? '+' : ''}{overall.diff}</b> working days</div>
      </div>

      <div className="repsect">
        <h3>By station</h3>
        <div className="tablescroll">
          <table className="report">
            <thead><tr><th>Station</th><th className="r">Closed</th><th className="r">Booked</th>
              <th className="r">Took</th><th>Against estimate</th></tr></thead>
            <tbody>
              {byStation.map(({ op, n, planned, actual, pct: p }) => (
                <tr key={op.key}>
                  <td><span className="chip2"><i style={{ background: op.color }} />{op.label}</span></td>
                  <td className="r n">{n || '—'}</td>
                  <td className="r n">{n ? `${avg(planned, n)} d` : '—'}</td>
                  <td className="r n">{n ? `${avg(actual, n)} d` : '—'}</td>
                  <td>{n ? (
                    <div className="meter">
                      <span className="mtrack">
                        <span className="mplan" />
                        <span className="mact" style={{
                          width: `${Math.min(200, planned ? actual / planned * 100 : 0) / 2}%`,
                          background: p > 5 ? '#B3382E' : op.color,
                        }} />
                      </span>
                      <span className={`mnum ${cls(p)}`}>{pct(p)}</span>
                    </div>
                  ) : <span className="muted">no closures yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="foot">Averages per closure. The rule on each bar is the booked estimate; the
          fill is what it actually took, so a fill past the rule is an overrun.</p>
      </div>

      <div className="repsect">
        <h3>By model</h3>
        <div className="tablescroll">
          <table className="report">
            <thead><tr><th>Model</th><th className="r">Closed</th>
              {OPS.map((o) => <th key={o.key} className="r">{SHORT[o.key]} booked → took</th>)}
              <th className="r">Overall</th></tr></thead>
            <tbody>
              {byModel.map((m) => (
                <tr key={m.model}>
                  <td className="strong">{m.model}</td>
                  <td className="r n">{m.n}</td>
                  {OPS.map((o) => {
                    const c = m.per[o.key]
                    return <td key={o.key} className="r n">
                      {c ? <span className={cls(c.pct)}>{avg(c.planned, c.n)} → {avg(c.actual, c.n)} d</span> : '—'}
                    </td>
                  })}
                  <td className={`r n ${cls(m.pct)}`}>{pct(m.pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="foot">Grouped by part number where a unit has one, otherwise by its description.</p>
      </div>

      {dateSection}

      <div className="repsect">
        <h3>Recent closures</h3>
        <div className="tablescroll">
          <table className="report">
            <thead><tr><th>Unit</th><th>Model</th><th>Station</th><th className="r">Booked</th>
              <th className="r">Took</th><th className="r">Difference</th>
              <th className="r">Started</th><th className="r">Finished</th></tr></thead>
            <tbody>
              {rows.slice(0, 25).map((r) => (
                <tr key={r.key}>
                  <td className="strong">{r.unit}</td>
                  <td className="muted">{r.model}</td>
                  <td><span className={`chip ${r.stage}`}><i />{STAGE_LABEL[r.stage]}</span></td>
                  <td className="r n">{r.planned} d</td>
                  <td className="r n">{r.actual} d</td>
                  <td className={`r n ${r.diff > 0 ? 'bad' : r.diff < 0 ? 'good' : ''}`}>
                    {r.diff > 0 ? `+${r.diff}` : r.diff || '0'} d
                  </td>
                  <td className="r n muted">{r.started ? fmt(r.started) : '—'}</td>
                  <td className="r n muted">{r.finished ? fmt(r.finished) : r.closed ? fmt(r.closed) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="foot">
          {rows.length > 25 ? `Showing the 25 most recent of ${rows.length}. ` : ''}
          Stations closed without a start date are not counted here, nor are those whose start and
          finish are only half filled in — unknown is not the same as zero.
        </p>
      </div>
    </div>
  )
}

function Row({ j, days, dayIndex, todayT, cal, pn, proj, tracking, selected, onSelect, onDragStage,
  steps, open, onToggleOpen, onDragStep, onDragProjected }) {
  const hasSteps = steps && OPS.some((o) => steps[o.key].length)
  // Parallel steps overlap in time, so each station's steps are spread over as
  // many lines as it takes for none of them to sit on top of another, and the
  // row grows to fit the busiest station.
  const laid = open && hasSteps
    ? OPS.map((o) => {
        const list = steps[o.key]
        if (!list.length) return null
        const spans = stepSpans(j.spans[o.key].start, list, cal)
        return { op: o, spans, ...stepLanes(spans) }
      }).filter(Boolean)
    : []
  const laneCount = laid.reduce((n, l) => Math.max(n, l.count), 0)
  const rowH = laneCount ? 44 + laneCount * 18 + 4 : 46
  // The drag in progress, held on the row so a pointer move repaints one row
  // rather than the whole board. It is a preview only — nothing is written
  // until the pointer comes up, so a drag can be abandoned by putting the bar
  // back where it came from.
  const [drag, setDrag] = useState(null)
  const snap = drag ? Math.round(drag.dx / COL) * COL : 0

  // One gesture, three kinds of bar. `lane` says which, so the preview knows
  // what to move and the release knows where to write.
  const handler = { plan: onDragStage, proj: onDragProjected, step: onDragStep }
  const down = (e, lane, key, stepId) => {
    if (e.button || !handler[lane]) return
    const g = e.target.classList
    const mode = g.contains('grip') ? (g.contains('l') ? 'start' : 'end') : 'move'
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ lane, key, stepId, mode, x0: e.clientX, dx: 0 })
  }
  const move = (e) => setDrag((d) => (d ? { ...d, dx: e.clientX - d.x0 } : d))
  const up = () => setDrag((d) => {
    if (d) {
      const n = Math.round(d.dx / COL)
      if (n !== 0) {
        if (d.lane === 'step') onDragStep(j.id, d.key, d.stepId, d.mode, n)
        else if (d.lane === 'proj') onDragProjected(j.id, d.key, d.mode, n)
        else onDragStage(j.id, d.key, d.mode, n)
      }
    }
    return null
  })

  return (
    <>
      <div className={`rowlabel ${selected ? 'sel' : ''}`} onClick={onSelect}>
        <div className="unit">
          {hasSteps && (
            <button className="twist" title={open ? 'Hide steps' : 'Show steps'}
              onClick={(e) => { e.stopPropagation(); onToggleOpen() }}>{open ? '−' : '+'}</button>
          )}
          {j.unit}
          {tracking && proj && proj.slipping && <span className="flag">+{proj.variance}d</span>}
          {!tracking && j.late && <span className="flag">{j.lateDays ? `LATE +${j.lateDays}d` : 'BEHIND'}</span>}
          {j.conflict && <span className="flag seq" title="A stage is pinned across one that has to come before it. Move it, or release the pin.">OVERLAP</span>}
        </div>
        <div className="desc" title={`${pn ? `${pn} · ` : ''}${j.desc ? `${j.desc} · ` : ''}deliver ${fmt(j.delivery)}`}>
          {pn && <span className="pntag">{pn}</span>}{j.desc ? `${j.desc} · ` : ''}deliver {fmt(j.delivery)}
        </div>
      </div>
      <div className="rowtrack" style={{ gridColumn: `span ${days.length}` }}>
        <div className="cellrow" style={{ gridTemplateColumns: `repeat(${days.length}, ${COL}px)` }}>
          {days.map((d, i) => (
            <div key={i} style={{ height: rowH }}
              className={`cell${!cal.isWorkday(d) ? ' we' : ''}${d.getTime() === todayT ? ' todaycol' : ''}`} />
          ))}
        </div>
        {/* upper lane: the plan the unit was sold on — and the lane you drag */}
        {OPS.map((o) => {
          const s = j.spans[o.key]
          let x = dayIndex(s.start) * COL, w = (dayIndex(s.end) - dayIndex(s.start) + 1) * COL
          const live = drag && drag.lane === 'plan' && drag.key === o.key
          if (live) {
            if (drag.mode === 'move') x += snap
            else if (drag.mode === 'end') w = Math.max(COL, w + snap)
            // the left edge stretches the bar while its far end stays put
            else { const d = Math.min(snap, w - COL); x += d; w -= d }
          }
          const pinned = Boolean(j.pins && j.pins[o.key])
          const built = Boolean(steps && steps[o.key].length)
          // The red ring says one thing: this needed to start by now and has
          // not. It belongs on fabrication, the station a unit starts at, and
          // only while the unit is still standing in front of it -- a unit in
          // paint or assembly started fabrication weeks ago, and ringing that
          // bar tells the shop it is late on work it has already finished.
          // Measured on fabrication's own planned start, not on whether the
          // unit will make its delivery: the delivery is said by the flag on
          // the label and by bars running past the delivery mark.
          const overdue = o.key === 'fab' && j.slack < 0 && (j.stage || 'none') === 'none'
          return <div key={o.key}
            className={`bar plan${overdue ? ' latefab' : ''}`
              + `${pinned ? ' pinned' : ''}${live ? ' dragging' : ''}${onDragStage ? ' draggable' : ''}`}
            onPointerDown={onDragStage ? (e) => down(e, 'plan', o.key) : undefined}
            onPointerMove={onDragStage ? move : undefined}
            onPointerUp={onDragStage ? up : undefined}
            onPointerCancel={onDragStage ? up : undefined}
            title={`Planned ${o.label.toLowerCase()}: ${fmt(s.start)} – ${fmt(s.end)}`
              + (overdue ? ` — should have started ${Math.abs(j.slack)} working day${Math.abs(j.slack) === 1 ? '' : 's'} ago` : '')
              + (pinned ? ' — placed by hand' : '')
              + (built ? (steps[o.key].length === 1
                  ? `. 1 step, ${j[o.key]} days — edit it to change the station's length`
                  : `. ${steps[o.key].length} steps add up to ${j[o.key]} days — edit them to change the station's length`) : '')
              + (onDragStage ? '. Drag to move it.' : '')}
            style={{ left: x + 1, width: w - 3, background: o.light, borderColor: o.color, color: o.color }}>
            {onDragStage && !built && <><span className="grip l" /><span className="grip r" /></>}
          </div>
        })}
        {/* lower lane: where the remaining work actually lands. Same colour as
            the plan above it, filled solid rather than outlined, so the pair
            reads as one station in two states. Colour says which station; how
            late a unit is running is the flag on its label and how far its bars
            run past the delivery mark.
            Drawn for every unit that still has work, not only the ones running
            late. A unit that will make its date has a projection too, and it is
            the one worth seeing: it says which week the work is expected to
            start, and a row with nothing in this lane reads as a row with no
            answer rather than as good news. Only a finished unit has no bars
            here, because it has no work left to land. */}
        {tracking && proj && OPS.map((o) => {
          const s = proj.spans[o.key]
          if (!s) return null
          let x = dayIndex(s.start) * COL, w = (dayIndex(s.end) - dayIndex(s.start) + 1) * COL
          const liveProj = drag && drag.lane === 'proj' && drag.key === o.key
          if (liveProj) {
            if (drag.mode === 'move') x += snap
            else if (drag.mode === 'end') w = Math.max(COL, w + snap)
            else { const d = Math.min(snap, w - COL); x += d; w -= d }
          }
          // The station the unit is standing in is running: its work is
          // happening now, so it can be shortened or lengthened but not moved.
          const running = (j.stage || 'none') === o.key
          const built = Boolean(steps && steps[o.key].length)
          return (
            <div key={`p-${o.key}`}
              className={`bar proj${onDragProjected ? ' draggable' : ''}${running ? ' running' : ''}${liveProj ? ' dragging' : ''}`}
              onPointerDown={onDragProjected ? (e) => down(e, 'proj', o.key) : undefined}
              onPointerMove={onDragProjected ? move : undefined}
              onPointerUp={onDragProjected ? up : undefined}
              onPointerCancel={onDragProjected ? up : undefined}
              title={`Projected ${o.label.toLowerCase()}: ${fmt(s.start)} – ${fmt(s.end)}`
                + (!onDragProjected ? ''
                  : running ? '. Running now — drag the right edge to change the days left'
                  : built ? '. Drag to place it; its length comes from its steps'
                  : '. Drag to place it, drag an edge to change its days')}
              style={{ left: x + 1, width: w - 3, background: o.color }}>
              {onDragProjected && !running && <span className="grip l" />}
              {onDragProjected && !(built && !running) && <span className="grip r" />}
            </div>
          )
        })}
        {/* the steps each station breaks into. Two that run side by side are
            drawn side by side, on their own lines, because that is what the
            station's length is now built from. */}
        {laid.map(({ op, spans, lane }) => spans.map((st) => {
          let x = dayIndex(st.start) * COL
          let w = (dayIndex(st.end) - dayIndex(st.start) + 1) * COL
          const liveStep = drag && drag.lane === 'step' && drag.stepId === st.id
          if (liveStep) {
            if (drag.mode === 'move') x += snap
            else if (drag.mode === 'end') w = Math.max(COL, w + snap)
            else { const d = Math.min(snap, w - COL); x += d; w -= d }
          }
          const waits = (st.needs || []).length
          return (
            <div key={st.id}
              className={`bar step${st.done ? ' done' : ''}${onDragStep ? ' draggable' : ''}${liveStep ? ' dragging' : ''}`}
              onPointerDown={onDragStep ? (e) => down(e, 'step', op.key, st.id) : undefined}
              onPointerMove={onDragStep ? move : undefined}
              onPointerUp={onDragStep ? up : undefined}
              onPointerCancel={onDragStep ? up : undefined}
              title={`${op.label}: ${st.name || 'unnamed step'} — ${st.days} d, ${fmt(st.start)} – ${fmt(st.end)}`
                + `, starts on day ${st.offset + 1} of the station`
                + (waits ? `, after ${waits} other${waits === 1 ? '' : 's'}` : ', with the station')
                + (st.lag ? `, held back ${st.lag} d` : '')
                + (st.done ? ' (done)' : '')
                + (onDragStep ? '. Drag to hold it back, drag an edge to change its days.' : '')}
              style={{ left: x + 1, width: w - 3, top: 41 + lane.get(st.id) * 18,
                background: op.light, borderColor: op.color, color: op.color }}>
              {onDragStep && <><span className="grip l" /><span className="grip r" /></>}
              <span>{st.name || '—'}</span>
            </div>
          )
        }))}
        <div className="delmark" style={{ left: dayIndex(j.delivery) * COL + COL / 2 }} />
      </div>
    </>
  )
}

function LoadRow({ op, counts, cap, days, todayT, cal, onCap }) {
  return (
    <>
      <div className="loadlabel">
        <span className="nm"><span className="chip" style={{ background: op.color }} />{op.label}</span>
        {/* The cap belongs to the station, not to a row, so only the planned
            rows above offer it; the floor rows read it back. */}
        <span className="cap">cap {onCap
          ? <input type="number" min="1" value={cap}
              onChange={(e) => onCap(Math.max(1, parseInt(e.target.value) || 1))} />
          : <b>{cap}</b>}</span>
      </div>
      <div className="cellrow" style={{ gridColumn: `span ${days.length}`, gridTemplateColumns: `repeat(${days.length}, ${COL}px)` }}>
        {days.map((d, i) => {
          const c = counts[i], work = cal.isWorkday(d), over = work && c > cap
          return (
            <div key={i}
              className={`lcell ${!work ? 'we' : ''} ${d.getTime() === todayT ? 'todaycol' : ''} ${over ? 'over' : ''}`}
              style={!over && work && c > 0 ? { background: op.light, color: op.color } : undefined}
              title={work ? `${op.label}: ${c} of ${cap}` : undefined}>
              {work && c > 0 ? c : ''}
            </div>
          )
        })}
      </div>
    </>
  )
}

function Style() {
  return <style>{`
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Archivo', 'Segoe UI', sans-serif; background: #EEF0F1; color: #1B2126; }
    .shell { min-height: 100vh; }
    .shell.center { display: flex; align-items: center; justify-content: center; padding: 24px; }
    .loginbox { background: #FFF; border: 1px solid #D4D9DC; border-radius: 8px; padding: 26px 26px 20px; width: 100%; max-width: 360px; box-shadow: 0 1px 3px rgba(27,33,38,.06); }
    .loginbox h1 { margin: 0; font-size: 19px; font-weight: 700; }
    .loginbox .sub { margin: 5px 0 18px; font-size: 13px; color: #5B6670; }
    .loginbox .sub.small { margin: 14px 0 0; font-size: 11px; line-height: 1.5; }
    .loginbox label { display: block; font-size: 12px; font-weight: 600; color: #3A434B; margin-bottom: 12px; }
    .loginbox input { display: block; width: 100%; margin-top: 5px; font-family: inherit; font-size: 14px; padding: 9px 10px; border: 1px solid #C6CDD1; border-radius: 4px; }
    .loginbox input:focus { outline: 2px solid #44688F; outline-offset: -1px; border-color: #44688F; }
    .loginerr { font-size: 12px; background: #F8E7E5; color: #7C221B; border-radius: 4px; padding: 8px 10px; margin-bottom: 12px; line-height: 1.4; }
    .btn.primary { background: #1B2126; color: #FFF; border-color: #1B2126; width: 100%; padding: 9px 14px; }
    .btn.primary:hover { background: #333C44; }
    .btn.primary:disabled { opacity: .6; cursor: default; }
    .modalwrap { position: fixed; inset: 0; background: rgba(27,33,38,.4); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 20; }
    .loginok { font-size: 12px; background: #E1EEE6; color: #245039; border-radius: 4px; padding: 9px 11px; margin-bottom: 12px; line-height: 1.45; }
    .btn.linkish { width: 100%; margin-top: 8px; border-color: transparent; background: transparent; color: #5B6670; }
    .btn.linkish:hover { background: #F2F4F5; }
    .who { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #5B6670; padding-left: 12px; border-left: 1px solid #C6CDD1; }
    .notice { margin: 24px; padding: 14px 16px; background: #FFF; border: 1px solid #D4D9DC; border-radius: 6px; font-size: 14px; max-width: 640px; line-height: 1.5; }
    .notice.bad { background: #F8E7E5; border-color: #DCB4B0; color: #7C221B; }
    .notice code { background: #EEF0F1; padding: 1px 5px; border-radius: 3px; }
    .head { display: flex; align-items: baseline; justify-content: space-between; padding: 20px 24px 14px; flex-wrap: wrap; gap: 10px; }
    .title { font-size: 22px; font-weight: 700; }
    .title span { font-weight: 400; color: #5B6670; }
    .stats { display: flex; gap: 22px; font-size: 13px; color: #3A434B; align-items: center; flex-wrap: wrap; }
    .stats b { font-size: 16px; }
    .stats .bad b { color: #B3382E; }
    .toggle { display: flex; gap: 7px; align-items: center; font-weight: 600; cursor: pointer; padding-right: 12px; border-right: 1px solid #C6CDD1; }
    .toggle input { accent-color: #1B2126; width: 15px; height: 15px; cursor: pointer; }
    .legend { display: flex; gap: 16px; padding: 0 24px 12px; font-size: 12px; color: #3A434B; align-items: center; flex-wrap: wrap; }
    .chip { width: 14px; height: 10px; border-radius: 2px; display: inline-block; margin-right: 6px; vertical-align: -1px; }
    .todaychip { background: #fff; border: 1px solid #1B2126; width: 3px; height: 12px; }
    .boardwrap { margin: 0 24px 20px; background: #FFF; border: 1px solid #D4D9DC; border-radius: 6px; overflow-x: auto; cursor: grab; position: relative; }
    /* the seam between the unit names and the calendar — drag it to read more */
    .colgrip { position: absolute; top: 0; bottom: 0; width: 7px; z-index: 6; cursor: col-resize; }
    .colgrip::after { content: ''; position: absolute; inset: 0 3px; background: #44688F; opacity: 0; transition: opacity .12s; }
    .colgrip:hover::after, .colgrip:active::after { opacity: 1; }
    /* while panning the whole board answers to the pointer, inner cursors and all */
    .boardwrap.panning, .boardwrap.panning * { cursor: grabbing !important; user-select: none; }
    .grid { display: grid; }
    .corner { position: sticky; left: 0; background: #FFF; z-index: 3; border-right: 1px solid #D4D9DC; }
    .month { font-size: 11px; font-weight: 600; color: #5B6670; padding: 6px 0 2px 4px; border-left: 1px solid #E4E8EA; overflow: hidden; white-space: nowrap; }
    .dayhead { font-size: 10px; text-align: center; color: #7A848C; padding: 2px 0 6px; border-left: 1px solid #F0F2F3; position: relative; user-select: none; }
    .dayhead.we { background: #F5F6F7; color: #B9C0C5; }
    .dayhead.today { color: #1B2126; font-weight: 700; }
    .dayhead.clickable { cursor: pointer; }
    .dayhead.clickable:hover { background: #E7ECEF; color: #1B2126; }
    /* A day set by hand, so an off Thursday reads differently from a weekend. */
    .dayhead.ovr::before { content: ''; position: absolute; left: 3px; right: 3px; bottom: 1px; height: 2px; border-radius: 1px; background: #C0722F; }
    .offchip { background: #F5F6F7; border: 1px solid #C6CDD1; }
    .hint { color: #7A848C; }
    .hint.bad { color: #B3382E; }
    .hint code { background: #E4E8EA; padding: 1px 4px; border-radius: 3px; }
    .rowlabel { position: sticky; left: 0; background: #FFF; z-index: 2; border-top: 1px solid #E4E8EA; border-right: 1px solid #D4D9DC; padding: 8px 10px; cursor: pointer; }
    .rowlabel:hover { background: #F6F8F9; }
    .rowlabel.sel { background: #EDF2F6; }
    .unit { font-size: 13px; font-weight: 700; display: flex; gap: 8px; align-items: center; }
    .desc { font-size: 11px; color: #5B6670; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .flag { font-size: 10px; font-weight: 700; color: #fff; background: #B3382E; border-radius: 3px; padding: 1px 5px; white-space: nowrap; }
    .rowtrack { position: relative; }
    .cellrow { display: grid; }
    .cell { border-top: 1px solid #E4E8EA; border-left: 1px solid #F0F2F3; height: 46px; position: relative; }
    /* the step lines under each unit; the lane sets each one's top in the markup */
    .bar.step { height: 15px; border: 1px solid; border-radius: 2px; overflow: hidden;
      display: flex; align-items: center; padding: 0 4px; }
    .bar.step span { font-size: 9px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bar.step.done { opacity: .55; }
    .bar.step.done span { text-decoration: line-through; }
    .bar.step.draggable { cursor: grab; touch-action: none; }
    .bar.step.dragging { cursor: grabbing; z-index: 5; box-shadow: 0 1px 6px rgba(0,0,0,.28); }
    .bar.step .grip { top: -1px; bottom: -1px; }
    /* the only thing that says a unit has steps, so it has to be findable:
       big enough to read at a glance and a target you can hit without aiming */
    .twist { border: 1px solid #C6CDD1; background: #FFF; cursor: pointer; font-size: 14px;
      font-weight: 700; line-height: 1; color: #3A434B; width: 20px; height: 20px; flex: none;
      border-radius: 4px; display: inline-flex; align-items: center; justify-content: center;
      padding: 0; font-family: inherit; }
    .twist:hover { background: #44688F; color: #FFF; }
    .twist:focus-visible { outline: 2px solid #44688F; outline-offset: 1px; }
    .cell.we { background: #F5F6F7; }
    .cell.todaycol::after, .lcell.todaycol::after { content: ''; position: absolute; inset: 0; border-left: 2px solid #1B2126; }
    /* two lanes: the plan on top, where the work actually lands beneath it */
    .bar { position: absolute; top: 12px; height: 20px; border-radius: 3px; }
    .bar.plan { top: 7px; height: 13px; border: 1px solid; }
    .bar.proj { top: 24px; height: 13px; }
    .bar.proj.draggable { cursor: grab; touch-action: none; }
    .bar.proj.draggable.running { cursor: default; }
    .bar.proj.dragging { cursor: grabbing; z-index: 4; box-shadow: 0 1px 6px rgba(0,0,0,.28); }
    .bar.proj.draggable:hover .grip { background: #FFF; opacity: .5; border-radius: 2px; }
    .bar.latefab { outline: 2px solid #B3382E; }
    /* the plan is the lane you drag: move from the middle, stretch from an edge */
    .bar.plan.draggable { cursor: grab; touch-action: none; }
    .bar.plan.dragging { cursor: grabbing; z-index: 4; box-shadow: 0 1px 6px rgba(0,0,0,.28); }
    .bar.plan.pinned { border-width: 2px; }
    .bar.plan.pinned::after { content: ''; position: absolute; left: 3px; top: 50%; margin-top: -2px;
      width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
    /* Sit inside the bar. Overhanging the edge put one bar's right grip on top
       of the next bar's left grip in the 2px gap between them, so grabbing the
       end of paint moved the start of assembly instead. */
    .grip { position: absolute; top: -2px; bottom: -2px; width: 7px; cursor: col-resize; }
    .grip.l { left: 0; } .grip.r { right: 0; }
    .bar.plan.draggable:hover .grip { background: currentColor; opacity: .45; border-radius: 2px; }
    .flag.seq { background: #96581F; }
    .pinchipkey { background: #FFF; border: 2px solid #5B6670; box-sizing: border-box; }
    .pinline { margin: 14px 0 4px; padding: 10px 12px; background: #F9FAFB; border: 1px solid #E4E8EA;
      border-radius: 5px; font-size: 12px; color: #5B6670; display: flex; flex-direction: column; gap: 8px; }
    .pinline .bad { color: #B3382E; font-weight: 600; }
    .pinline .pins { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .pintag { display: inline-flex; align-items: center; gap: 4px; border: 1px solid; border-radius: 3px;
      padding: 2px 4px 2px 7px; font-weight: 600; font-variant-numeric: tabular-nums; background: #FFF; }
    .pintag button { border: 0; background: none; cursor: pointer; color: inherit; font-size: 14px;
      line-height: 1; padding: 0 3px; border-radius: 2px; }
    .pintag button:hover { background: rgba(0,0,0,.1); }
    .sortpick { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .sortpick select { font-family: inherit; font-size: 12px; padding: 3px 5px; border: 1px solid #C6CDD1; border-radius: 4px; background: #FFF; }
    .lanekey { width: 14px; height: 12px; border-radius: 2px; display: inline-block; margin-right: 6px; vertical-align: -2px;
      background: linear-gradient(#E3EAF2 0 50%, #44688F 50% 100%); border: 1px solid #44688F; }
    /* stage chips */
    .chip.none, .chip.fab, .chip.paint, .chip.asm, .chip.done {
      display: inline-flex; align-items: center; gap: 5px; width: auto; height: auto; border-radius: 3px;
      font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 3px 7px; }
    .chip.none i, .chip.fab i, .chip.paint i, .chip.asm i, .chip.done i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
    .chip.none { background: #EEF0F1; color: #5B6670; } .chip.none i { background: #9AA4AB; }
    .chip.fab { background: #E3EAF2; color: #33557A; } .chip.fab i { background: #44688F; }
    .chip.paint { background: #F5E8DA; color: #96581F; } .chip.paint i { background: #C0722F; }
    .chip.asm { background: #E1EEE6; color: #2D6044; } .chip.asm i { background: #3E7C59; }
    .chip.done { background: #E1EEE6; color: #2D6044; } .chip.done i { background: #3E7C59; }
    .stagebtn { border: 0; background: none; padding: 0; cursor: pointer; font-family: inherit; }
    .stagebtn:disabled { cursor: default; }
    .stagebtn:focus-visible { outline: 2px solid #44688F; outline-offset: 2px; border-radius: 3px; }
    .stagebox { border: 1px solid #E4E8EA; border-radius: 5px; padding: 12px 14px 4px; margin: 14px 0 4px; background: #F9FAFB; }
    .stageline { font-size: 12px; color: #5B6670; margin: -2px 0 10px; }
    .stageline .bad { color: #B3382E; font-weight: 600; }
    .orders td.calc.good { color: #2D6044; }
    .orders .w-stage { width: 118px; }
    .orders .w-since { width: 152px; }
    .orders th { padding: 0; }
    .sortbtn { font-family: inherit; font-size: inherit; font-weight: inherit; letter-spacing: inherit; text-transform: inherit; color: inherit; background: none; border: 0; width: 100%; text-align: left; padding: 9px 10px; cursor: pointer; display: flex; align-items: center; gap: 5px; white-space: nowrap; }
    .sortbtn:hover { background: #EDF2F6; color: #1B2126; }
    .sortbtn.on { color: #1B2126; }
    .sortbtn:focus-visible { outline: 2px solid #44688F; outline-offset: -2px; }
    .sortbtn .arrow { font-size: 8px; line-height: 1; }
    .since { display: flex; flex-direction: column; gap: 1px; }
    .since input { padding-block: 4px; }
    .sincedays { font-size: 10px; color: #7A848C; font-variant-numeric: tabular-nums; padding-left: 8px; }
    .sincedays.bad { color: #B3382E; font-weight: 600; }
    /* delivery calendar */
    .calwrap { margin: 0 24px 24px; }
    .calhead { display: flex; flex-wrap: wrap; gap: 10px 26px; align-items: center; justify-content: space-between;
      background: #FFF; border: 1px solid #D4D9DC; border-radius: 6px 6px 0 0; border-bottom: 0; padding: 10px 14px; }
    .calnav { display: flex; align-items: center; gap: 8px; }
    .calnav h3 { margin: 0; font-size: 15px; font-weight: 700; min-width: 168px; }
    .calstats { display: flex; flex-wrap: wrap; gap: 6px 22px; align-items: baseline; font-size: 13px; color: #3A434B; }
    .calstats b { font-size: 15px; font-variant-numeric: tabular-nums; }
    .calstats .bad b { color: #B3382E; }
    .calgrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr));
      border: 1px solid #D4D9DC; border-radius: 0 0 6px 6px; overflow: hidden; background: #D4D9DC; gap: 1px; }
    .caldow { background: #F6F8F9; font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .06em; color: #7A848C; padding: 7px 9px; }
    .calcell { background: #FFF; min-height: 104px; padding: 5px 5px 7px; display: flex; flex-direction: column; gap: 3px; }
    .calcell.other { background: #FAFBFB; }
    .calcell.other .caldate { color: #B8C0C6; }
    .calcell.off { background: #F3F5F6; }
    .calcell.off.other { background: #F7F8F9; }
    .calcell.today { box-shadow: inset 0 0 0 2px #1B2126; }
    .caldate { font-size: 11px; font-weight: 700; color: #5B6670; display: flex; align-items: baseline;
      justify-content: space-between; gap: 6px; padding: 1px 2px 2px; }
    .calcell.today .caldate { color: #1B2126; }
    .calclosed { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #9AA4AB; }
    .calclosed.on { color: #3E7C59; }
    .dlv { display: block; width: 100%; text-align: left; font-family: inherit; cursor: pointer;
      border: 1px solid #C6CDD1; border-left: 3px solid #5B6670; background: #FFF; border-radius: 3px;
      padding: 3px 6px; line-height: 1.3; }
    .dlv:hover { background: #F6F8F9; }
    .dlv.sel { background: #EDF2F6; border-color: #44688F; border-left-color: #44688F; }
    .dlv.slip { border-left-color: #B3382E; }
    .dlv.done { border-left-color: #3E7C59; }
    .dlv .u { font-size: 12px; font-weight: 700; color: #1B2126; }
    .dlv .v { font-size: 10px; font-weight: 700; color: #B3382E; margin-left: 5px; }
    .dlv .m { display: block; font-size: 10px; color: #7A848C; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .calfoot { margin: 8px 0 0; font-size: 11px; color: #7A848C; line-height: 1.5; max-width: 76ch; }
    @media (max-width: 860px) {
      .calcell { min-height: 78px; }
      .dlv .m { display: none; }
    }
    /* stage report */
    .reportwrap { margin: 0 24px 24px; display: flex; flex-direction: column; gap: 18px; }
    .rephead { display: flex; flex-wrap: wrap; gap: 10px 28px; align-items: baseline; background: #FFF; border: 1px solid #D4D9DC; border-radius: 6px; padding: 14px 18px; font-size: 13px; color: #3A434B; }
    .rephead b { font-size: 17px; font-variant-numeric: tabular-nums; }
    .rephead .bad b { color: #B3382E; } .rephead .good b { color: #2D6044; }
    .repsect { display: flex; flex-direction: column; gap: 8px; }
    .repsect h3 { margin: 0; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #5B6670; }
    .repsect .foot { margin: 0; font-size: 11px; color: #7A848C; line-height: 1.5; max-width: 76ch; }
    table.report { border-collapse: collapse; width: 100%; font-size: 13px; background: #FFF; }
    table.report th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700; color: #7A848C; padding: 9px 12px; background: #F6F8F9; border-bottom: 1px solid #D4D9DC; white-space: nowrap; }
    table.report td { padding: 9px 12px; border-bottom: 1px solid #E4E8EA; white-space: nowrap; }
    table.report tr:last-child td { border-bottom: 0; }
    table.report th.r, table.report td.r { text-align: right; }
    table.report td.n { font-variant-numeric: tabular-nums; }
    table.report td.strong { font-weight: 700; }
    table.report td.muted, .muted { color: #7A848C; }
    table.report .bad { color: #B3382E; font-weight: 600; }
    table.report .good { color: #2D6044; font-weight: 600; }
    .chip2 { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; }
    .chip2 i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
    /* wide tables scroll sideways rather than pushing the page out */
    .tablescroll { overflow-x: auto; border: 1px solid #D4D9DC; border-radius: 6px; }
    /* planned against actual dates */
    table.stagedates td { padding: 7px 12px; }
    table.stagedates tr.onnow td { background: #FBF7EF; }
    table.stagedates .muted { font-weight: 400; }
    .dateedit { font-family: inherit; font-size: inherit; color: inherit; width: 100%; min-width: 118px;
      border: 1px solid transparent; border-radius: 3px; background: none; padding: 2px 4px; margin: -2px -4px; }
    .dateedit:hover { border-color: #C6CDD1; background: #FFF; }
    .dateedit:focus { outline: 2px solid #44688F; outline-offset: -1px; border-color: transparent; background: #FFF; }
    .panelsect { margin: 14px 0 4px; display: flex; flex-direction: column; gap: 7px; }
    .panelsect h4 { margin: 0; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #5B6670; }
    .panelsect .foot { margin: 0; font-size: 11px; color: #7A848C; line-height: 1.5; }
    .num.built { font-variant-numeric: tabular-nums; font-weight: 600; color: #3A434B; padding: 6px 0; }
    .num.built i { font-style: normal; font-size: 11px; font-weight: 400; color: #7A848C; }
    .stepgroup { border-top: 1px solid #E4E8EA; padding: 8px 0 4px; }
    .stepgroup:first-of-type { border-top: 0; }
    .stephead { display: flex; align-items: center; gap: 9px; margin-bottom: 5px; }
    .stephead .muted { flex: 1; font-size: 11px; }
    .stepitem { padding: 3px 0; }
    .steprow { display: flex; align-items: center; gap: 7px; padding: 2px 0 2px 4px; }
    .stepat { font-size: 10px; color: #7A848C; font-variant-numeric: tabular-nums; white-space: nowrap; min-width: 40px; }
    .stepneeds { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 3px 0 1px 29px; }
    .stepneeds .nlab, .stepneeds em { font-size: 10px; color: #9AA4AB; font-style: normal; }
    .needchip { font-family: inherit; font-size: 10px; max-width: 132px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; border: 1px solid #C6CDD1; background: #FFF;
      color: #5B6670; border-radius: 3px; padding: 1px 6px; cursor: pointer; }
    .needchip:hover { border-color: #44688F; color: #1B2126; }
    .needchip.on { background: #EDF2F6; border-color: #44688F; color: #33557A; font-weight: 700; }
    /* steps listed under their unit in the table. The flex goes on a wrapper,
       never on the <td> itself — a flexed cell stops being a table cell and its
       colSpan is ignored, which collapses the whole row into one column. */
    .cellflex { display: flex; align-items: center; gap: 8px; }
    .orders td.unitcell .cellflex > input { flex: 1; min-width: 0; }
    /* keeps a step's name lined up under a unit that has the real thing */
    .twist.gap { width: 20px; height: 20px; display: inline-block; flex: none; background: none; border: 0; }
    .orders tr.tstep td { background: #FAFBFC; }
    /* the width:100% on table inputs would stretch every control on this row.
       Matches nested inputs too — the days field sits inside its own box. */
    .orders tr.tstep input { width: auto; flex: none; }
    .orders tr.tstep input.stepname-t { flex: 1; min-width: 120px; max-width: 320px; }
    /* beats the width:auto above, which itself beats .stepdays' own width */
    .orders tr.tstep input.stepdays { width: 44px; text-align: center; }
    .orders tr.tstep.done input.stepname-t { color: #7A848C; text-decoration: line-through; }
    .orders td.stepcell { padding-left: 22px; }
    .orders tr.tstep input[type=checkbox] { accent-color: #3E7C59; width: 14px; height: 14px; cursor: pointer; flex: none; }
    .orders tr.tstep .chip { flex: none; }
    /* the station chips differ in width, so pin them so the days line up */
    .orders tr.tstep .chip.fixed { min-width: 78px; justify-content: center; }
    .daysbox { display: inline-flex; align-items: center; gap: 2px; flex: none; }
    .tdates { font-size: 11px; color: #5B6670; font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
    .stepneeds.inline { padding: 0; }
    .orders .calc.built { font-variant-numeric: tabular-nums; font-weight: 600; color: #3A434B; }
    .steprow input[type=checkbox] { accent-color: #3E7C59; width: 14px; height: 14px; cursor: pointer; flex: none; }
    .stepname { flex: 1; min-width: 0; font-family: inherit; font-size: 12px; padding: 4px 7px; border: 1px solid #C6CDD1; border-radius: 3px; }
    .stepdays { width: 46px; flex: none; font-family: inherit; font-size: 12px; padding: 4px 5px; border: 1px solid #C6CDD1; border-radius: 3px; text-align: center; }
    .dlabel { font-size: 11px; color: #7A848C; }
    .stepdel { border: 0; background: none; cursor: pointer; color: #7A848C; font-size: 15px; line-height: 1; padding: 0 4px; border-radius: 3px; }
    .stepdel:hover { background: #F3D2CE; color: #7C221B; }
    .steprow.done .stepname { color: #7A848C; text-decoration: line-through; }
    .panelsect table.report { font-size: 12px; }
    .panelsect table.report th { padding: 6px 7px; font-size: 9px; letter-spacing: .04em; }
    .panelsect table.report td { padding: 6px 7px; }
    /* booked vs took: the rule is the estimate, the fill is reality */
    .meter { display: flex; align-items: center; gap: 10px; min-width: 210px; }
    .mtrack { position: relative; flex: 1; height: 9px; background: #EEF0F1; border-radius: 5px; overflow: hidden; min-width: 120px; }
    .mplan { position: absolute; left: 50%; top: -2px; bottom: -2px; width: 2px; background: #1B2126; z-index: 1; }
    .mact { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; }
    .mnum { font-size: 11px; font-variant-numeric: tabular-nums; color: #5B6670; min-width: 74px; text-align: right; }
    .mnum.bad { color: #B3382E; font-weight: 600; } .mnum.good { color: #2D6044; font-weight: 600; }
    .empty { background: #FFF; border: 1px solid #D4D9DC; border-radius: 6px; padding: 26px 24px; max-width: 620px; }
    .empty h3 { margin: 0 0 8px; font-size: 15px; font-weight: 700; text-transform: none; letter-spacing: 0; color: #1B2126; }
    .empty p { margin: 0; font-size: 13px; color: #5B6670; line-height: 1.6; }
    .delmark { position: absolute; top: 8px; width: 2px; height: 28px; background: #1B2126; }
    .delmark::after { content: ''; position: absolute; top: -4px; left: -3px; border: 4px solid transparent; border-top: 6px solid #1B2126; }
    .secthead { position: sticky; left: 0; z-index: 2; background: #F6F8F9; border-top: 2px solid #C6CDD1; border-right: 1px solid #D4D9DC; font-size: 11px; font-weight: 700; color: #3A434B; padding: 8px 10px 6px; white-space: nowrap; }
    .overtag { margin-left: 7px; font-size: 10px; font-weight: 700; color: #fff; background: #B3382E; border-radius: 3px; padding: 1px 5px; }
    .loadlabel .cap b { font-variant-numeric: tabular-nums; color: #3A434B; }
    .sectfill { background: #F6F8F9; border-top: 2px solid #C6CDD1; }
    /* the completed group's own head: same bar as the load sections, with the
       fold control sitting on the baseline of the label rather than above it */
    .secthead.grouphead { display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
    .secthead.grouphead .twist { font-size: 13px; }
    /* a heading you can pick up and move. The grab cursor is the only thing
       that says so, so it is on the whole cell rather than on a handle. */
    .orders th.draghead { cursor: grab; user-select: none; position: relative; }
    /* the resize grip, kept inside its own heading: overhanging the edge would
       put it on top of the next column's, and the wrong one would answer */
    .orders th .thgrip { position: absolute; top: 0; bottom: 0; right: 0; width: 7px;
      cursor: col-resize; z-index: 3; }
    .orders th .thgrip::after { content: ''; position: absolute; inset: 5px 3px;
      background: #44688F; opacity: 0; transition: opacity .12s; }
    .orders th .thgrip:hover::after, .orders th .thgrip:active::after { opacity: 1; }
    .orders th.draghead.dragging { opacity: .45; cursor: grabbing; }
    /* where it would land, marked on the column being dropped onto */
    .orders th.draghead.dropinto { background: #EDF2F6; box-shadow: inset 0 -3px 0 #44688F; }
    /* the same grouping in the table: one bar across every column */
    .orders tr.grouprow td { background: #F6F8F9; border-top: 2px solid #C6CDD1;
      font-size: 11px; font-weight: 700; color: #3A434B; padding: 7px 10px; }
    .loadlabel { position: sticky; left: 0; z-index: 2; background: #FFF; border-top: 1px solid #E4E8EA; border-right: 1px solid #D4D9DC; padding: 5px 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
    .loadlabel .nm { font-weight: 600; }
    .loadlabel input { font-family: inherit; font-size: 12px; width: 44px; padding: 2px 4px; border: 1px solid #C6CDD1; border-radius: 3px; text-align: center; }
    .loadlabel .cap { font-size: 10px; color: #7A848C; white-space: nowrap; }
    .lcell { border-top: 1px solid #E4E8EA; border-left: 1px solid #F0F2F3; height: 30px; font-size: 11px; display: flex; align-items: center; justify-content: center; position: relative; font-weight: 600; }
    .lcell.we { background: #F5F6F7; }
    .lcell.over { background: #F3D2CE !important; color: #7C221B !important; font-weight: 700; }
    /* wide enough for the four stage dates to sit side by side without scrolling */
    .panel { margin: 0 24px 28px; background: #FFF; border: 1px solid #D4D9DC; border-radius: 6px; padding: 16px 18px; max-width: 600px; }
    .panel.wide { max-width: 780px; }
    .panel h3 { margin: 0 0 12px; font-size: 15px; font-weight: 700; }
    .panel .sub { margin: -6px 0 14px; font-size: 12px; color: #5B6670; line-height: 1.5; }
    .parthead, .partrow { display: grid; grid-template-columns: 130px minmax(0, 1fr) 62px 62px 62px 82px; gap: 8px; align-items: center; }
    .parthead { font-size: 11px; font-weight: 600; color: #7A848C; padding-bottom: 5px; border-bottom: 1px solid #E4E8EA; margin-bottom: 8px; }
    .partrow { margin-bottom: 8px; }
    .partrow input { font-family: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid #C6CDD1; border-radius: 4px; width: 100%; }
    .partrow input[type=number] { text-align: center; }
    .btn.sm { padding: 5px 10px; font-size: 12px; }
    .pntag { display: inline-block; font-size: 10px; font-weight: 700; color: #44688F; background: #E3EAF2; border-radius: 3px; padding: 1px 5px; margin-right: 6px; }
    .field select { font-family: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid #C6CDD1; border-radius: 4px; width: 160px; }
    .driftline { font-size: 12px; background: #F5E8DA; color: #7A4A16; border-radius: 4px; padding: 9px 12px; margin: 12px 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; line-height: 1.4; }
    .addrow select { font-family: inherit; font-size: 13px; padding: 7px 8px; border: 1px solid #C6CDD1; border-radius: 4px; max-width: 320px; }
    .field { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; font-size: 13px; }
    .field input { font-family: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid #C6CDD1; border-radius: 4px; width: 160px; }
    .field input.num { width: 64px; }
    .mustline { font-size: 13px; padding: 10px 12px; border-radius: 4px; margin: 12px 0; background: #EDF2F6; line-height: 1.45; }
    .mustline.bad { background: #F8E7E5; color: #7C221B; }
    .btn { font-family: inherit; font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 4px; border: 1px solid #C6CDD1; background: #fff; cursor: pointer; }
    .btn:hover { background: #F2F4F5; }
    .btn.danger { color: #B3382E; border-color: #DCB4B0; }
    .btnrow { display: flex; gap: 10px; }
    .views { display: flex; border: 1px solid #C6CDD1; border-radius: 4px; overflow: hidden; }
    .views button { font-family: inherit; font-size: 12px; font-weight: 600; padding: 5px 13px; border: 0; background: #FFF; color: #5B6670; cursor: pointer; }
    .views button + button { border-left: 1px solid #C6CDD1; }
    .views button.on { background: #1B2126; color: #FFF; }
    .tablewrap { margin: 0 24px 20px; background: #FFF; border: 1px solid #D4D9DC; border-radius: 6px; overflow-x: auto; }
    .tablehint { font-size: 11px; color: #7A848C; padding: 9px 12px 2px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .tablehint kbd { font-family: inherit; font-size: 10px; background: #EEF0F1; border: 1px solid #D4D9DC; border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; }
    /* fixed: under auto layout the browser treats a column width as a hint and
       hands the slack back to whatever has the longest content, so a column
       dragged wider springs part-way back. Description carries no width of its
       own and so takes up the remainder. */
    .orders { border-collapse: collapse; width: 100%; font-size: 13px; table-layout: fixed; }
    .orders th { text-align: left; font-size: 11px; font-weight: 600; color: #7A848C; padding: 9px 10px; border-bottom: 1px solid #D4D9DC; white-space: nowrap; background: #F6F8F9; }
    .orders td { padding: 4px 6px; border-bottom: 1px solid #E4E8EA; }
    .orders tr:last-child td { border-bottom: 0; }
    .orders tr.late td { background: #FCF4F3; }
    .orders input, .orders select { font-family: inherit; font-size: 13px; padding: 6px 7px; border: 1px solid transparent; border-radius: 4px; width: 100%; background: transparent; }
    .orders input:hover, .orders select:hover { border-color: #D4D9DC; }
    .orders input:focus, .orders select:focus { outline: none; border-color: #44688F; background: #FFF; box-shadow: 0 0 0 2px rgba(68,104,143,.15); }
    .orders td.calc { color: #5B6670; white-space: nowrap; padding-left: 10px; }
    .orders td.calc.bad { color: #B3382E; font-weight: 600; }
    .orders .w-unit { width: 130px; } .orders .w-pn { width: 110px; }
    .orders .w-date { width: 150px; } .orders .w-num { width: 66px; } .orders .w-calc { width: 110px; }
    .orders .w-num input { text-align: center; }
    .addrow { margin: 0 24px 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  `}</style>
}
