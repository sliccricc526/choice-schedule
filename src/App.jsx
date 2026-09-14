import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { supabase, configured } from './supabase.js'
import {
  OPS, strip, addDays, daysBetween, isWeekend, createCalendar, scheduleJob, levelSchedule,
  isoDate, parseDate, projectSchedule, nextStage, daysSpent, STAGE_LABEL,
} from './engine.js'

const COL = 26
const SHORT = { fab: 'Fab', paint: 'Paint', asm: 'Assembly' }
const STAGE_RANK = { none: 0, fab: 1, paint: 2, asm: 3, done: 4 }
const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

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
  const [leveled, setLeveled] = useState(true)
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
  // Closed stations, planned against actual. Empty until a station is closed.
  const [stageLog, setStageLog] = useState([])

  const load = useCallback(async () => {
    if (!supabase) return
    try {
      const [jr, cr, dr, pr, sr] = await Promise.all([
        supabase.from('jobs').select('*').order('delivery_date'),
        supabase.from('station_caps').select('*'),
        supabase.from('day_overrides').select('*'),
        supabase.from('part_numbers').select('*').order('part_number'),
        supabase.from('stage_log').select('*'),
      ])
      if (jr.error || cr.error) {
        setStatus('error')
        setError((jr.error || cr.error).message)
        return
      }
      const jrows = jr.data || []
      setTrackingEnabled(jrows.length === 0 || Object.prototype.hasOwnProperty.call(jrows[0], 'stage'))
      setJobs(jrows.map((r) => ({
        id: r.id, unit: r.unit, desc: r.description || '',
        delivery: parseDate(r.delivery_date),
        fab: r.fab_days, paint: r.paint_days, asm: r.asm_days,
        partId: r.part_number_id || '',
        stage: r.stage || 'none',
        stageStarted: r.stage_started ? parseDate(r.stage_started) : null,
        daysLeft: r.days_left == null ? null : r.days_left,
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
      setStageLog(sr.error ? [] : (sr.data || []))
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

  const userId = session ? session.user.id : null
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
      .subscribe()
    return () => { supabase.removeChannel(ch); clearTimeout(reloadTimer.current) }
  }, [load, scheduleReload, userId])

  // Typing used to write a row per keystroke, and every write came straight back
  // as a realtime event that reloaded all five tables and replaced the jobs
  // array mid-edit — so characters landed and were then overwritten by the
  // refetch. Edits are now applied locally at once and persisted after a pause,
  // and a reload waits until nothing is in flight.
  const SAVE_AFTER = 500
  const pendingWrites = useRef(0)
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

  // Flush anything still queued if the tab goes away mid-edit.
  useEffect(() => {
    const flushAll = () => {
      jobTimers.current.forEach((t, id) => { clearTimeout(t); flushJob(id) })
      partTimers.current.forEach((t, id) => { clearTimeout(t); flushPart(id) })
    }
    window.addEventListener('pagehide', flushAll)
    return () => { window.removeEventListener('pagehide', flushAll); flushAll() }
  }, [flushJob, flushPart])
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
      const { error: le } = await supabase.from('stage_log').upsert({
        job_id: job.id, stage: from,
        planned_days: job[from], actual_days: daysSpent(job, today, cal),
      })
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

  const cal = useMemo(() => createCalendar(dayOverrides), [dayOverrides])

  const { scheduled, scheduleError } = useMemo(() => {
    try {
      const list = leveled
        ? levelSchedule(jobs, caps, today, cal)
        : jobs.map((j) => scheduleJob(j, today, cal))
      return { scheduled: list.sort((a, b) => a.mustStart - b.mustStart), scheduleError: '' }
    } catch (err) {
      // A calendar with nearly everything switched off leaves the scheduler with
      // nowhere to put the work; say so instead of showing a half-built board.
      return { scheduled: [], scheduleError: String((err && err.message) || err) }
    }
  }, [jobs, caps, leveled, today, cal])

  // Where the work actually lands: remaining work pushed forward from today.
  // The plan above says when work *should* happen; this says when it will.
  const { projected, projectError } = useMemo(() => {
    try { return { projected: projectSchedule(jobs, caps, today, cal), projectError: '' } }
    catch (err) { return { projected: [], projectError: String((err && err.message) || err) } }
  }, [jobs, caps, today, cal])
  const projById = useMemo(() => new Map(projected.map((p) => [p.id, p])), [projected])
  const partsById = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts])
  const slipping = projected.filter((p) => p.slipping).length
  const onFloor = jobs.filter(underway).length

  const { days, months } = useMemo(() => {
    let min = today, max = addDays(today, 14)
    scheduled.forEach((j) => {
      if (j.spans.fab.start < min) min = j.spans.fab.start
      if (j.delivery > max) max = j.delivery
      if (j.spans.asm.end > max) max = j.spans.asm.end
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

  const idKey = scheduled.map((j) => j.id).sort().join(',')
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

  const dayIndex = (d) => daysBetween(days[0], d)

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

  const overDays = OPS.reduce(
    (n, o) => n + loads[o.key].filter((c, i) => cal.isWorkday(days[i]) && c > caps[o.key]).length, 0)
  const daysOff = days.filter((d) => cal.isOverridden(d) && !cal.isWorkday(d)).length
  const daysOn = days.filter((d) => cal.isOverridden(d) && cal.isWorkday(d)).length
  const atRisk = scheduled.filter((j) => j.late).length
  const sel = scheduled.find((j) => j.id === selected)
  const selPart = sel ? partsById.get(sel.partId) : null
  const selProj = sel ? projById.get(sel.id) : null
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

  return (
    <div className="shell">
      <Style />
      <div className="head">
        <div className="title">Shop schedule <span>· scheduled backward from delivery</span></div>
        <div className="stats">
          <div className="views">
            {['board', 'table', ...(trackingEnabled ? ['report'] : [])].map((v) => (
              <button key={v} className={view === v ? 'on' : ''}
                onClick={() => { setView(v); setSelected(null) }}>
                {v === 'board' ? 'Board' : v === 'table' ? 'Table' : 'Report'}
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
        <div><span className="chip offchip" />Shop closed</div>
        {calendarEnabled
          ? <div className="hint">Click any date to close or open that day</div>
          : <div className="hint bad">Day toggles need the <code>day_overrides</code> table — see supabase/schema.sql</div>}
      </div>

      <div className="boardwrap">
        <div className="grid" style={{ gridTemplateColumns: `230px repeat(${days.length}, ${COL}px)` }}>
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

          {scheduled.map((j) => (
            <Row key={j.id} j={j} days={days} dayIndex={dayIndex} todayT={todayT} cal={cal}
              pn={partsById.get(j.partId)?.part_number} proj={projById.get(j.id)} tracking={trackingEnabled}
              selected={selected === j.id}
              onSelect={() => setSelected(selected === j.id ? null : j.id)} />
          ))}

          <div className="secthead">Station load — units per day</div>
          <div className="sectfill" style={{ gridColumn: `span ${days.length}` }} />
          {OPS.map((o) => (
            <LoadRow key={o.key} op={o} counts={loads[o.key]} cap={caps[o.key]} days={days} todayT={todayT} cal={cal}
              onCap={(v) => saveCap(o.key, v)} />
          ))}
        </div>
      </div>
      </>) : view === 'table' ? (
        <OrdersTable rows={tableRows} parts={parts} partsEnabled={partsEnabled}
          onSave={saveJob} onApplyPart={applyPart} onResort={resortTable}
          projById={projById} tracking={trackingEnabled} onAdvance={advanceStage} today={today}
          sort={sort} onSort={sortBy} />
      ) : (
        <StageReport log={stageLog} jobs={jobs} partsById={partsById} />
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
          {OPS.map((o) => (
            <div className="field" key={o.key}><span>{o.label} (working days)</span>
              <input className="num" type="number" min="1" value={sel[o.key]}
                onChange={(e) => saveJob(sel.id, { [o.key]: Math.max(1, parseInt(e.target.value) || 1) })} /></div>
          ))}
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
                      ? <span>No start date, so the days spent are unknown. Closing this station
                          won't be recorded in the report — set the date first if you know it.</span>
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

function OrdersTable({ rows, parts, partsEnabled, onSave, onApplyPart, onResort, projById, tracking, onAdvance, today, sort, onSort }) {
  if (rows.length === 0) return <div className="notice">No units yet. Add one below.</div>
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
  // Every column sorts. The arrow marks the one in force and which way.
  const th = (key, label, className) => (
    <th key={key} className={className}>
      <button type="button" className={`sortbtn ${sort.key === key ? 'on' : ''}`}
        onClick={() => onSort(key)}
        title={`Sort by ${label.toLowerCase()}`}
        aria-sort={sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
        {label}<span className="arrow">{sort.key === key ? (sort.dir > 0 ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  )

  const variance = (p) => {
    if (!p) return { text: '—', cls: '' }
    if (p.complete) return { text: 'complete', cls: 'good' }
    if (p.variance > 0) return { text: `+${p.variance}d late`, cls: 'bad' }
    if (p.variance < 0) return { text: `${Math.abs(p.variance)}d slack`, cls: 'good' }
    return { text: 'on target', cls: '' }
  }

  return (
    <div className="tablewrap">
      <div className="tablehint">
        <span>Click a column to sort. Enter a target date and press <kbd>Enter</kbd> to drop
          to the next one — rows hold their place while you type.</span>
        <button className="btn sm" onClick={onResort} title="Apply the current sort again">Re-sort</button>
      </div>
      <table className="orders">
        <thead>
          <tr>
            {th('unit', 'Unit', 'w-unit')}
            {th('delivery', 'Target date', 'w-date')}
            {tracking && th('stage', 'Stage', 'w-stage')}
            {tracking && th('since', 'In stage since', 'w-since')}
            {tracking && th('left', 'Left', 'w-num')}
            {th('projected', 'Projected', 'w-calc')}
            {th('variance', 'Variance', 'w-calc')}
            {partsEnabled && th('part', 'Part number', 'w-pn')}
            {th('desc', 'Description')}
            {OPS.map((o) => th(o.key, SHORT[o.key], 'w-num'))}
          </tr>
        </thead>
        <tbody>
          {rows.map((j, i) => {
            const p = projById.get(j.id)
            const live = j.stage || 'none'
            const planned = live === 'none' || live === 'done' ? 0 : j[live]
            const over = planned > 0 && p && p.spent > planned
            const vr = variance(p)
            return (
              <tr key={j.id} className={p && p.slipping ? 'late' : ''}>
                <td><input value={j.unit} onChange={(e) => onSave(j.id, { unit: e.target.value })} /></td>
                <td>
                  <input type="date" data-daterow={i} value={isoDate(j.delivery)}
                    onKeyDown={toNextDate}
                    onChange={(e) => e.target.value && onSave(j.id, { delivery: parseDate(e.target.value) })} />
                </td>
                {tracking && (
                  <td>
                    <button className="stagebtn" onClick={() => onAdvance(j)} disabled={live === 'done'}
                      title={live === 'done' ? 'Complete'
                        : `Move ${j.unit} to ${STAGE_LABEL[nextStage(live)]}`
                          + (live !== 'none' && !j.stageStarted ? ' — no start date, so this closure is not recorded' : '')}>
                      <span className={`chip ${live}`}><i />{STAGE_LABEL[live]}</span>
                    </button>
                  </td>
                )}
                {tracking && (
                  <td>
                    {planned ? (
                      <div className="since">
                        <input type="date" max={isoDate(today)}
                          value={j.stageStarted ? isoDate(j.stageStarted) : ''}
                          title={`When ${j.unit} went into ${STAGE_LABEL[live].toLowerCase()}`}
                          onChange={(e) => onSave(j.id, { stageStarted: e.target.value ? parseDate(e.target.value) : null })} />
                        <span className={`sincedays ${over ? 'bad' : ''}`}>
                          {j.stageStarted ? `${p.spent} of ${planned} d${over ? ' ⚠' : ''}` : `not set · ${planned} d booked`}
                        </span>
                      </div>
                    ) : <span className="calc">—</span>}
                  </td>
                )}
                {tracking && (
                  <td>
                    {planned
                      ? <input type="number" min="0" value={j.daysLeft == null ? planned : j.daysLeft}
                          onChange={(e) => onSave(j.id, { daysLeft: Math.max(0, parseInt(e.target.value) || 0) })} />
                      : <span className="calc">—</span>}
                  </td>
                )}
                <td className="calc">{p && p.projectedEnd ? fmt(p.projectedEnd) : '—'}</td>
                <td className={`calc ${vr.cls}`}>{vr.text}</td>
                {partsEnabled && (
                  <td>
                    <select value={j.partId || ''} onChange={(e) => onApplyPart(j.id, e.target.value)}>
                      <option value="">—</option>
                      {parts.map((p2) => <option key={p2.id} value={p2.id}>{p2.part_number}</option>)}
                    </select>
                  </td>
                )}
                <td><input value={j.desc} onChange={(e) => onSave(j.id, { desc: e.target.value })} /></td>
                {OPS.map((o) => (
                  <td key={o.key}>
                    <input type="number" min="1" value={j[o.key]}
                      onChange={(e) => onSave(j.id, { [o.key]: Math.max(1, parseInt(e.target.value) || 1) })} />
                  </td>
                ))}
              </tr>
            )
          })}
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

// How each closed station actually went against what was booked for it.
function StageReport({ log, jobs, partsById }) {
  const rows = useMemo(() => {
    const byJob = new Map(jobs.map((j) => [j.id, j]))
    return (log || []).map((l) => {
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
        closed: l.closed_on ? parseDate(l.closed_on) : null,
      }
    }).sort((a, b) => (b.closed || 0) - (a.closed || 0))
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

      <div className="repsect">
        <h3>Recent closures</h3>
        <div className="tablescroll">
          <table className="report">
            <thead><tr><th>Unit</th><th>Model</th><th>Station</th><th className="r">Booked</th>
              <th className="r">Took</th><th className="r">Difference</th><th className="r">Closed</th></tr></thead>
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
                  <td className="r n muted">{r.closed ? fmt(r.closed) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="foot">
          {rows.length > 25 ? `Showing the 25 most recent of ${rows.length}. ` : ''}
          Stations closed without a start date are not counted here — unknown is not the same as zero.
        </p>
      </div>
    </div>
  )
}

const underway = (j) => j.stage && j.stage !== 'none' && j.stage !== 'done'

function Row({ j, days, dayIndex, todayT, cal, pn, proj, tracking, selected, onSelect }) {
  return (
    <>
      <div className={`rowlabel ${selected ? 'sel' : ''}`} onClick={onSelect}>
        <div className="unit">{j.unit}
          {tracking && proj && proj.slipping && <span className="flag">+{proj.variance}d</span>}
          {!tracking && j.late && <span className="flag">{j.lateDays ? `LATE +${j.lateDays}d` : 'BEHIND'}</span>}
        </div>
        <div className="desc" title={`${pn ? `${pn} · ` : ''}${j.desc ? `${j.desc} · ` : ''}deliver ${fmt(j.delivery)}`}>
          {pn && <span className="pntag">{pn}</span>}{j.desc ? `${j.desc} · ` : ''}deliver {fmt(j.delivery)}
        </div>
      </div>
      <div className="rowtrack" style={{ gridColumn: `span ${days.length}` }}>
        <div className="cellrow" style={{ gridTemplateColumns: `repeat(${days.length}, ${COL}px)` }}>
          {days.map((d, i) => (
            <div key={i} className={`cell ${!cal.isWorkday(d) ? 'we' : ''} ${d.getTime() === todayT ? 'todaycol' : ''}`} />
          ))}
        </div>
        {/* upper lane: the plan the unit was sold on */}
        {OPS.map((o) => {
          const s = j.spans[o.key]
          const x = dayIndex(s.start) * COL, w = (dayIndex(s.end) - dayIndex(s.start) + 1) * COL
          return <div key={o.key} className={`bar plan ${j.late && o.key === 'fab' ? 'latefab' : ''}`}
            title={`Planned ${o.label.toLowerCase()}: ${fmt(s.start)} – ${fmt(s.end)}`}
            style={{ left: x + 1, width: w - 3, background: o.light, borderColor: o.color }} />
        })}
        {/* lower lane: where the remaining work actually lands */}
        {tracking && proj && (underway(j) || proj.slipping) && OPS.map((o) => {
          const s = proj.spans[o.key]
          if (!s) return null
          const x = dayIndex(s.start) * COL, w = (dayIndex(s.end) - dayIndex(s.start) + 1) * COL
          return <div key={`p-${o.key}`} className={`bar proj ${proj.slipping ? 'slip' : ''}`}
            title={`Projected ${o.label.toLowerCase()}: ${fmt(s.start)} – ${fmt(s.end)}`}
            style={{ left: x + 1, width: w - 3, background: proj.slipping ? '#B3382E' : o.color }} />
        })}
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
        <span className="cap">cap <input type="number" min="1" value={cap}
          onChange={(e) => onCap(Math.max(1, parseInt(e.target.value) || 1))} /></span>
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
    .boardwrap { margin: 0 24px 20px; background: #FFF; border: 1px solid #D4D9DC; border-radius: 6px; overflow-x: auto; }
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
    .cell.we { background: #F5F6F7; }
    .cell.todaycol::after, .lcell.todaycol::after { content: ''; position: absolute; inset: 0; border-left: 2px solid #1B2126; }
    /* two lanes: the plan on top, where the work actually lands beneath it */
    .bar { position: absolute; top: 12px; height: 20px; border-radius: 3px; }
    .bar.plan { top: 7px; height: 13px; border: 1px solid; }
    .bar.proj { top: 24px; height: 13px; }
    .bar.latefab { outline: 2px solid #B3382E; }
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
    .sectfill { background: #F6F8F9; border-top: 2px solid #C6CDD1; }
    .loadlabel { position: sticky; left: 0; z-index: 2; background: #FFF; border-top: 1px solid #E4E8EA; border-right: 1px solid #D4D9DC; padding: 5px 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
    .loadlabel .nm { font-weight: 600; }
    .loadlabel input { font-family: inherit; font-size: 12px; width: 44px; padding: 2px 4px; border: 1px solid #C6CDD1; border-radius: 3px; text-align: center; }
    .loadlabel .cap { font-size: 10px; color: #7A848C; white-space: nowrap; }
    .lcell { border-top: 1px solid #E4E8EA; border-left: 1px solid #F0F2F3; height: 30px; font-size: 11px; display: flex; align-items: center; justify-content: center; position: relative; font-weight: 600; }
    .lcell.we { background: #F5F6F7; }
    .lcell.over { background: #F3D2CE !important; color: #7C221B !important; font-weight: 700; }
    .panel { margin: 0 24px 28px; background: #FFF; border: 1px solid #D4D9DC; border-radius: 6px; padding: 16px 18px; max-width: 560px; }
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
    .orders { border-collapse: collapse; width: 100%; font-size: 13px; }
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
    .orders .w-date { width: 150px; } .orders .w-num { width: 66px; } .orders .w-calc { width: 96px; }
    .orders .w-num input { text-align: center; }
    .addrow { margin: 0 24px 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  `}</style>
}
