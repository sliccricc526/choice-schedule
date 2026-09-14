import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { supabase, configured } from './supabase.js'
import {
  OPS, strip, addDays, daysBetween, isWeekend, createCalendar, scheduleJob, levelSchedule,
  isoDate, parseDate,
} from './engine.js'

const COL = 26
const SHORT = { fab: 'Fab', paint: 'Paint', asm: 'Assembly' }
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

  const load = useCallback(async () => {
    if (!supabase) return
    try {
      const [jr, cr, dr, pr] = await Promise.all([
        supabase.from('jobs').select('*').order('delivery_date'),
        supabase.from('station_caps').select('*'),
        supabase.from('day_overrides').select('*'),
        supabase.from('part_numbers').select('*').order('part_number'),
      ])
      if (jr.error || cr.error) {
        setStatus('error')
        setError((jr.error || cr.error).message)
        return
      }
      setJobs((jr.data || []).map((r) => ({
        id: r.id, unit: r.unit, desc: r.description || '',
        delivery: parseDate(r.delivery_date),
        fab: r.fab_days, paint: r.paint_days, asm: r.asm_days,
        partId: r.part_number_id || '',
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
  useEffect(() => {
    if (!supabase || !userId) return
    load()
    // Live sync: any change from any user refreshes every open board.
    const ch = supabase
      .channel('schedule-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'station_caps' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'day_overrides' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'part_numbers' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load, userId])

  const saveJob = async (id, patch) => {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)))
    const row = {}
    if (patch.unit !== undefined) row.unit = patch.unit
    if (patch.desc !== undefined) row.description = patch.desc
    if (patch.delivery !== undefined) row.delivery_date = isoDate(patch.delivery)
    if (patch.fab !== undefined) row.fab_days = patch.fab
    if (patch.paint !== undefined) row.paint_days = patch.paint
    if (patch.asm !== undefined) row.asm_days = patch.asm
    if (patch.partId !== undefined) row.part_number_id = patch.partId || null
    const { error: e } = await supabase.from('jobs').update(row).eq('id', id)
    if (e) { setError(e.message); load() }
  }
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

  const savePart = async (id, patch) => {
    setParts((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
    const { error: e } = await supabase.from('part_numbers').update(patch).eq('id', id)
    if (e) { setError(e.message); load() }
  }
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
  const saveCap = async (station, cap) => {
    setCaps((c) => ({ ...c, [station]: cap }))
    const { error: e } = await supabase.from('station_caps').upsert({ station, cap })
    if (e) { setError(e.message); load() }
  }

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

  const { days, months } = useMemo(() => {
    let min = today, max = addDays(today, 14)
    scheduled.forEach((j) => {
      if (j.spans.fab.start < min) min = j.spans.fab.start
      if (j.delivery > max) max = j.delivery
      if (j.spans.asm.end > max) max = j.spans.asm.end
    })
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
  }, [scheduled, today])

  // The table is for working through the book, so order it by the date being
  // entered rather than by the computed start the board sorts on. The order is
  // held steady while you type: re-sorting on every keystroke would slide the
  // row out from under the cursor the moment a date passes its neighbour's, and
  // Enter would drop into a different unit than the one below. It settles again
  // when the table is opened, when units are added or removed, or on request.
  const [tableOrder, setTableOrder] = useState([])
  const scheduledRef = useRef(scheduled)
  scheduledRef.current = scheduled
  const resortTable = useCallback(() => {
    setTableOrder(scheduledRef.current
      .slice()
      .sort((a, b) => (a.delivery - b.delivery) || a.unit.localeCompare(b.unit))
      .map((j) => j.id))
  }, [])
  const idKey = scheduled.map((j) => j.id).sort().join(',')
  useEffect(() => { resortTable() }, [view, idKey, resortTable])

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
  const partsById = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts])
  const selPart = sel ? partsById.get(sel.partId) : null
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
            {['board', 'table'].map((v) => (
              <button key={v} className={view === v ? 'on' : ''}
                onClick={() => { setView(v); setSelected(null) }}>
                {v === 'board' ? 'Board' : 'Table'}
              </button>
            ))}
          </div>
          <label className="toggle">
            <input type="checkbox" checked={leveled} onChange={(e) => setLeveled(e.target.checked)} />
            Level to capacity
          </label>
          <div><b>{scheduled.length}</b> units in plan</div>
          <div className={atRisk ? 'bad' : ''}><b>{atRisk}</b> {leveled ? 'projected late' : 'behind required start'}</div>
          <div className={overDays ? 'bad' : ''}><b>{overDays}</b> overloaded station-days</div>
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
              pn={partsById.get(j.partId)?.part_number}
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
      </>) : (
        <OrdersTable rows={tableRows} parts={parts} partsEnabled={partsEnabled}
          onSave={saveJob} onApplyPart={applyPart} onResort={resortTable} />
      )}

      {sel ? (
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
      )}
      {showParts && partsEnabled && (
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

function OrdersTable({ rows, parts, partsEnabled, onSave, onApplyPart, onResort }) {
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
  const status = (j) => (j.late
    ? { text: j.lateDays ? `${j.lateDays}d late` : `${Math.abs(j.slack)}d behind`, bad: true }
    : { text: `${j.slack}d slack`, bad: false })

  return (
    <div className="tablewrap">
      <div className="tablehint">
        <span>Enter a target date and press <kbd>Enter</kbd> to drop to the next one.
          Rows hold their place while you type.</span>
        <button className="btn sm" onClick={onResort}>Re-sort by date</button>
      </div>
      <table className="orders">
        <thead>
          <tr>
            <th className="w-unit">Unit</th>
            <th className="w-date">Target date</th>
            {partsEnabled && <th className="w-pn">Part number</th>}
            <th>Description</th>
            {OPS.map((o) => <th key={o.key} className="w-num">{SHORT[o.key]}</th>)}
            <th className="w-calc">Fab starts</th>
            <th className="w-calc">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((j, i) => {
            const st = status(j)
            return (
              <tr key={j.id} className={j.late ? 'late' : ''}>
                <td><input value={j.unit} onChange={(e) => onSave(j.id, { unit: e.target.value })} /></td>
                <td>
                  <input type="date" data-daterow={i} value={isoDate(j.delivery)}
                    onKeyDown={toNextDate}
                    onChange={(e) => e.target.value && onSave(j.id, { delivery: parseDate(e.target.value) })} />
                </td>
                {partsEnabled && (
                  <td>
                    <select value={j.partId || ''} onChange={(e) => onApplyPart(j.id, e.target.value)}>
                      <option value="">—</option>
                      {parts.map((p) => <option key={p.id} value={p.id}>{p.part_number}</option>)}
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
                <td className="calc">{fmt(j.mustStart)}</td>
                <td className={`calc ${st.bad ? 'bad' : ''}`}>{st.text}</td>
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

function Row({ j, days, dayIndex, todayT, cal, pn, selected, onSelect }) {
  return (
    <>
      <div className={`rowlabel ${selected ? 'sel' : ''}`} onClick={onSelect}>
        <div className="unit">{j.unit}{j.late && <span className="flag">{j.lateDays ? `LATE +${j.lateDays}d` : 'BEHIND'}</span>}</div>
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
        {OPS.map((o) => {
          const s = j.spans[o.key]
          const x = dayIndex(s.start) * COL, w = (dayIndex(s.end) - dayIndex(s.start) + 1) * COL
          return <div key={o.key} className={`bar ${j.late && o.key === 'fab' ? 'latefab' : ''}`}
            title={`${o.label}: ${fmt(s.start)} – ${fmt(s.end)}`}
            style={{ left: x + 1, width: w - 3, background: o.color }} />
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
    .bar { position: absolute; top: 12px; height: 20px; border-radius: 3px; }
    .bar.latefab { outline: 2px solid #B3382E; }
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
