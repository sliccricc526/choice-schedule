import { useState, useMemo, useEffect, useCallback } from 'react'
import { supabase, configured } from './supabase.js'
import {
  OPS, strip, addDays, daysBetween, isWeekend, createCalendar, scheduleJob, levelSchedule,
  isoDate, parseDate,
} from './engine.js'

const COL = 26
const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export default function App() {
  const today = useMemo(() => strip(new Date()), [])
  const [jobs, setJobs] = useState([])
  const [caps, setCaps] = useState({ fab: 2, paint: 1, asm: 2 })
  // ISO date -> whether the shop works that day, overriding the Mon–Fri default.
  const [dayOverrides, setDayOverrides] = useState(() => new Map())
  // False when the day_overrides table isn't there yet, so the board still works.
  const [calendarEnabled, setCalendarEnabled] = useState(true)
  const [leveled, setLeveled] = useState(true)
  const [selected, setSelected] = useState(null)
  const [status, setStatus] = useState(configured ? 'loading' : 'unconfigured')
  const [error, setError] = useState('')
  const [bootErrors, setBootErrors] = useState([])

  const load = useCallback(async () => {
    if (!supabase) return
    try {
      const [jr, cr, dr] = await Promise.all([
        supabase.from('jobs').select('*').order('delivery_date'),
        supabase.from('station_caps').select('*'),
        supabase.from('day_overrides').select('*'),
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
      })))
      const c = { fab: 2, paint: 1, asm: 2 }
      ;(cr.data || []).forEach((r) => { c[r.station] = r.cap })
      setCaps(c)
      // The calendar is optional: if the table hasn't been created yet, fall back
      // to plain weekends rather than failing the whole board.
      setCalendarEnabled(!dr.error)
      setDayOverrides(dr.error ? new Map() : new Map((dr.data || []).map((r) => [r.day, r.working])))
      setStatus('ready')
    } catch (err) {
      setStatus('error')
      setError(String((err && err.message) || err))
    }
  }, [])

  useEffect(() => {
    const onErr = (e) => setBootErrors((b) => [...b, String(e.reason?.message || e.message || e.reason || e.error || 'unknown error')])
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onErr)
    const watchdog = setTimeout(() => {
      setStatus((s) => (s === 'loading' ? 'error' : s))
      setError((prev) => prev || 'Loading stalled after 10 seconds without a reported cause. The messages below (if any) are the underlying errors.')
    }, 10000)
    return () => {
      window.removeEventListener('error', onErr)
      window.removeEventListener('unhandledrejection', onErr)
      clearTimeout(watchdog)
    }
  }, [])

  useEffect(() => {
    load()
    if (!supabase) return
    // Live sync: any change from any user refreshes every open board.
    const ch = supabase
      .channel('schedule-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'station_caps' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'day_overrides' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  const saveJob = async (id, patch) => {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)))
    const row = {}
    if (patch.unit !== undefined) row.unit = patch.unit
    if (patch.desc !== undefined) row.description = patch.desc
    if (patch.delivery !== undefined) row.delivery_date = isoDate(patch.delivery)
    if (patch.fab !== undefined) row.fab_days = patch.fab
    if (patch.paint !== undefined) row.paint_days = patch.paint
    if (patch.asm !== undefined) row.asm_days = patch.asm
    const { error: e } = await supabase.from('jobs').update(row).eq('id', id)
    if (e) { setError(e.message); load() }
  }
  const addJob = async () => {
    const delivery = addDays(today, 30)
    const { data, error: e } = await supabase.from('jobs')
      .insert({ unit: 'NEW UNIT', description: '', delivery_date: isoDate(delivery), fab_days: 8, paint_days: 2, asm_days: 4 })
      .select().single()
    if (e) { setError(e.message); return }
    setSelected(data.id)
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
  const todayT = today.getTime()

  if (status === 'unconfigured') return (
    <div className="shell"><Style />
      <div className="notice">Supabase isn't connected yet. Copy <code>.env.example</code> to <code>.env</code>, add your project URL and anon key, and restart. On Vercel, set the same two values as environment variables.</div>
    </div>
  )
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
        </div>
      </div>

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
          {OPS.map((o) => (
            <div className="field" key={o.key}><span>{o.label} (working days)</span>
              <input className="num" type="number" min="1" value={sel[o.key]}
                onChange={(e) => saveJob(sel.id, { [o.key]: Math.max(1, parseInt(e.target.value) || 1) })} /></div>
          ))}
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
        <div className="addrow"><button className="btn" onClick={addJob}>Add unit</button></div>
      )}
      {scheduleError && <div className="notice bad">Couldn't build the schedule: {scheduleError}</div>}
      {error && status === 'ready' && <div className="notice bad">Last change didn't save: {error}</div>}
    </div>
  )
}

function Row({ j, days, dayIndex, todayT, cal, selected, onSelect }) {
  return (
    <>
      <div className={`rowlabel ${selected ? 'sel' : ''}`} onClick={onSelect}>
        <div className="unit">{j.unit}{j.late && <span className="flag">{j.lateDays ? `LATE +${j.lateDays}d` : 'BEHIND'}</span>}</div>
        <div className="desc">{j.desc ? `${j.desc} · ` : ''}deliver {fmt(j.delivery)}</div>
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
    .desc { font-size: 11px; color: #5B6670; margin-top: 1px; }
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
    .panel h3 { margin: 0 0 12px; font-size: 15px; font-weight: 700; }
    .field { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; font-size: 13px; }
    .field input { font-family: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid #C6CDD1; border-radius: 4px; width: 160px; }
    .field input.num { width: 64px; }
    .mustline { font-size: 13px; padding: 10px 12px; border-radius: 4px; margin: 12px 0; background: #EDF2F6; line-height: 1.45; }
    .mustline.bad { background: #F8E7E5; color: #7C221B; }
    .btn { font-family: inherit; font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 4px; border: 1px solid #C6CDD1; background: #fff; cursor: pointer; }
    .btn:hover { background: #F2F4F5; }
    .btn.danger { color: #B3382E; border-color: #DCB4B0; }
    .btnrow { display: flex; gap: 10px; }
    .addrow { margin: 0 24px 16px; }
  `}</style>
}
