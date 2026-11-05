import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Check, ChevronDown, ChevronRight, Inbox, LoaderCircle, Pencil, SkipForward } from 'lucide-react';
import { formatEuros } from '../shared/accounts';
import type { BudgetData, BudgetLine, BudgetMovement } from '../shared/budget';
import { budgetRowStatus, type BudgetRow, type budgetOverview } from '../shared/budget-view';
import { api } from './api';
import './budget-month.css';

type Overview = ReturnType<typeof budgetOverview>;

const whole = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(cents / 100);
const shortDate = (value: string) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`));
const normalize = (text: string) => text.toLocaleLowerCase('es').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, ' ');
const stopWords = new Set(['transferencia', 'emitida', 'recibida', 'pago', 'cargo', 'compra', 'tarjeta', 'recibo', 'para', 'desde', 'con', 'del', 'los', 'las', 'por', 'de', 'la', 'el', 'en', 'y']);
const tokens = (text: string) => new Set(normalize(text).split(/\s+/).filter(word => word.length >= 3 && !stopWords.has(word)));

/** Fraction of the selected period already elapsed (0–1), or null when it does not apply. */
function elapsedFraction(periods: string[]) {
  if (periods.length !== 1) return null;
  const [y, m] = periods[0].split('-').map(Number);
  const today = new Date();
  const current = today.getFullYear() * 12 + today.getMonth();
  const selected = y * 12 + (m - 1);
  if (selected < current) return 1;
  if (selected > current) return 0;
  return today.getDate() / new Date(y, m, 0).getDate();
}

/** Ranks budget lines for a movement: previous assignments with similar concepts first, then name matches, then the biggest lines of the month. */
function suggestLines(movement: BudgetMovement, lines: BudgetLine[], history: BudgetMovement[], rows: BudgetRow[]) {
  const income = movement.amountCents > 0;
  const allowed = lines.filter(line => income ? line.kind === 'income' : line.kind === 'expense' || line.kind === 'saving');
  const allowedIds = new Set(allowed.map(line => line.id));
  const words = tokens(`${movement.description} ${movement.bankCategory}`);
  const score = new Map<string, number>();
  const learned = new Set<string>();
  const add = (id: string, value: number) => { if (allowedIds.has(id)) score.set(id, (score.get(id) ?? 0) + value); };
  for (const past of history) {
    if (!past.lineId || past.id === movement.id) continue;
    const other = tokens(`${past.description} ${past.bankCategory}`);
    let shared = 0; for (const word of words) if (other.has(word)) shared++;
    if (shared) learned.add(past.lineId);
    if (shared) add(past.lineId, 10 * shared / Math.max(words.size, other.size) + (Math.abs(past.amountCents) === Math.abs(movement.amountCents) ? 4 : 0));
  }
  for (const line of allowed) {
    let shared = 0; for (const word of tokens(`${line.name} ${line.group}`)) if (words.has(word)) shared++;
    if (shared) add(line.id, 3 * shared);
  }
  const planned = new Map(rows.map(row => [row.id, row.plannedCents]));
  return [...allowed].sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || (planned.get(b.id) ?? 0) - (planned.get(a.id) ?? 0)).map(line => ({ line, matched: learned.has(line.id) && allowedIds.has(line.id) }));
}

function MovementInbox({ data, periods, rows, onChanged }: { data: BudgetData; periods: string[]; rows: BudgetRow[]; onChanged: () => void }) {
  const [movements, setMovements] = useState<BudgetMovement[] | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(0);
  useEffect(() => {
    let alive = true; setMovements(null); setSkipped(new Set()); setDone(0);
    api<{ movements: BudgetMovement[] }>(`/api/budget/${data.year}/movements`).then(result => { if (alive) setMovements(result.movements); }).catch(err => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [data.year]);
  const pending = (movements ?? []).filter(row => !row.lineId && !row.excluded && periods.some(p => row.date.startsWith(p)));
  const queue = [...pending.filter(row => !skipped.has(row.id)), ...pending.filter(row => skipped.has(row.id))];
  const movement = queue[0];
  const suggestions = useMemo(() => movement ? suggestLines(movement, data.lines, movements ?? [], rows) : [], [movement, data.lines, movements, rows]);
  const quick = suggestions.slice(0, 5);

  async function assign(value: string) {
    if (!movement || busy) return;
    setBusy(true); setError('');
    try {
      await api('/api/budget/assignments', { method: 'POST', body: JSON.stringify({ items: [{ entryId: movement.id, expectedVersion: movement.version }], lineId: value === '__excluded' ? null : value, excluded: value === '__excluded' }) });
      setMovements(old => (old ?? []).map(row => row.id === movement.id ? { ...row, lineId: value === '__excluded' ? null : value, excluded: value === '__excluded', version: row.version + 1 } : row));
      setDone(n => n + 1);
      onChanged();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!movement || busy || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, select, textarea, dialog')) return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < quick.length) { event.preventDefault(); void assign(quick[index].line.id); }
      else if (event.key.toLowerCase() === 't') { event.preventDefault(); void assign('__excluded'); }
      else if (event.key.toLowerCase() === 's') { event.preventDefault(); setSkipped(old => new Set(old).add(movement.id)); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (movements === null) return error ? <p className="form-error">{error}</p> : <section className="inbox-card loading"><LoaderCircle className="spin" size={18}/> Buscando movimientos sin clasificar…</section>;
  if (!movement) return done > 0 ? <section className="inbox-card all-done"><Check size={20}/><div><strong>Todo clasificado</strong><span>Has clasificado {done} {done === 1 ? 'movimiento' : 'movimientos'}. El gasto real ya está completo para este periodo.</span></div></section> : null;
  const income = movement.amountCents > 0;
  return <section className="inbox-card" aria-label="Movimientos por clasificar">
    <header className="inbox-head">
      <div><Inbox size={18}/><strong>{pending.length} {pending.length === 1 ? 'movimiento por clasificar' : 'movimientos por clasificar'}</strong></div>
      <span>Mientras haya movimientos sin clasificar, lo gastado sale más bajo de lo que es.</span>
    </header>
    <div className="inbox-movement">
      <div className="inbox-movement-text"><span className="inbox-date">{shortDate(movement.date)} · {movement.accountName}</span><strong>{movement.description}</strong>{movement.bankCategory && <small>Categoría del banco: {movement.bankCategory}</small>}</div>
      <span className={`inbox-amount ${income ? 'in' : 'out'}`}>{formatEuros(movement.amountCents)}</span>
    </div>
    <p className="inbox-question">{income ? '¿Qué ingreso es?' : '¿A qué partida va este gasto?'}</p>
    <div className="inbox-choices">
      {quick.map(({ line, matched }, index) => <button key={line.id} className={`inbox-choice ${matched && index === 0 ? 'best' : ''}`} disabled={busy} onClick={() => void assign(line.id)}><kbd>{index + 1}</kbd><span>{line.name}<small>{matched && index === 0 ? 'Como la última vez' : line.group}</small></span></button>)}
    </div>
    <div className="inbox-actions">
      <select aria-label="Otra partida" value="" disabled={busy} onChange={e => e.target.value && void assign(e.target.value)}><option value="">Otra partida…</option>{suggestions.slice(5).map(({ line }) => <option key={line.id} value={line.id}>{line.name} · {line.group}</option>)}</select>
      <button className="button secondary" disabled={busy} onClick={() => void assign('__excluded')} title="Traspaso entre tus cuentas: no cuenta como ingreso ni gasto"><ArrowLeftRight size={15}/> Traspaso interno <kbd>T</kbd></button>
      <button className="text-button" disabled={busy || queue.length < 2} onClick={() => setSkipped(old => new Set(old).add(movement.id))}><SkipForward size={15}/> Luego <kbd>S</kbd></button>
      {busy && <LoaderCircle className="spin" size={17}/>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

function GroupCard({ name, color, rows, onEditPlan, onMovements }: { name: string; color: string; rows: BudgetRow[]; onEditPlan: (row: BudgetRow) => void; onMovements: (row: BudgetRow) => void }) {
  const [open, setOpen] = useState(false);
  const planned = rows.reduce((n, row) => n + row.plannedCents, 0);
  const actual = rows.reduce((n, row) => n + row.actualCents, 0);
  const left = planned - actual;
  const percent = planned > 0 ? Math.min(100, Math.max(0, actual / planned * 100)) : actual > 0 ? 100 : 0;
  const tone = actual > planned ? 'over' : planned > 0 && actual / planned >= .85 ? 'warning' : 'good';
  return <article className={`group-card ${open ? 'open' : ''} ${tone}`}>
    <button className="group-card-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span className="group-dot" style={{ background: color }}/>
      <span className="group-name">{name}<small>{rows.length} {rows.length === 1 ? 'partida' : 'partidas'}</small></span>
      <span className="group-left"><strong>{left < 0 ? `−${whole(-left)}` : whole(left)}</strong><small>{left < 0 ? 'te has pasado' : 'quedan'}</small></span>
      {open ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}
    </button>
    <div className="group-bar" aria-hidden="true"><span style={{ width: `${percent}%` }}/></div>
    <p className="group-caption">{whole(actual)} de {whole(planned)}</p>
    {open && <ul className="group-lines">{rows.map(row => {
      const state = budgetRowStatus(row);
      const rest = row.plannedCents - row.actualCents;
      return <li key={row.id} className={state.tone}>
        <div className="line-top"><span className="line-name">{row.name}</span><span className={`line-left ${rest < 0 ? 'over' : ''}`}>{rest < 0 ? `−${formatEuros(-rest)}` : formatEuros(rest)}</span></div>
        <div className="line-bar"><span style={{ width: `${state.percent}%` }}/></div>
        <div className="line-bottom">
          <button className="line-link" onClick={() => onMovements(row)} title="Ver y asignar movimientos">{formatEuros(row.actualCents)} {row.kind === 'saving' ? 'aportado' : 'gastado'}</button>
          <button className="line-link" onClick={() => onEditPlan(row)} title="Cambiar el presupuesto">de {formatEuros(row.plannedCents)} <Pencil size={11}/></button>
        </div>
      </li>;
    })}</ul>}
  </article>;
}

export function BudgetMonth({ data, overview, periods, onChanged, onEditPlan, onMovements }: { data: BudgetData; overview: Overview; periods: string[]; onChanged: () => void; onEditPlan: (row: BudgetRow) => void; onMovements: (row?: BudgetRow) => void }) {
  const plannedOut = overview.allocatedCents;
  const spent = overview.actualOutCents;
  const left = plannedOut - spent;
  const percent = plannedOut > 0 ? Math.min(100, Math.max(0, spent / plannedOut * 100)) : 0;
  const pace = elapsedFraction(periods);
  const ahead = pace !== null && pace > 0 && pace < 1 && percent / 100 > pace + .05;
  const single = periods.length === 1;
  const spendRows = overview.rows.filter(row => (row.kind === 'expense' || row.kind === 'saving') && (row.plannedCents !== 0 || row.actualCents !== 0));
  const incomeRows = overview.rows.filter(row => row.kind === 'income' && (row.plannedCents !== 0 || row.actualCents !== 0));
  const groups = overview.groups.map(group => ({ ...group, rows: spendRows.filter(row => row.group === group.name) })).filter(group => group.rows.length);
  const overGroups = groups.filter(group => group.actualCents > group.plannedCents);

  return <div className="month-view">
    <section className={`month-hero ${left < 0 ? 'over' : ''}`}>
      <div className="hero-main">
        <span className="hero-label">{left < 0 ? 'Te has pasado' : single ? 'Te queda este mes' : 'Te queda en el periodo'}</span>
        <strong className="hero-amount">{formatEuros(Math.abs(left))}</strong>
        <span className="hero-sub">Llevas <b>{formatEuros(spent)}</b> de <b>{formatEuros(plannedOut)}</b> presupuestados en gastos y ahorro</span>
        <div className="hero-bar" role="progressbar" aria-label="Presupuesto gastado" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
          <span className="hero-fill" style={{ width: `${percent}%` }}/>
          {pace !== null && pace > 0 && pace < 1 && <span className="hero-pace" style={{ left: `${pace * 100}%` }}><i>Hoy</i></span>}
        </div>
        <div className="hero-scale"><span>{Math.round(percent)}% gastado</span>{pace !== null && pace > 0 && pace < 1 && <span className={ahead ? 'warn' : ''}>{ahead ? 'Vas por delante del ritmo del mes' : `Llevas ${Math.round(pace * 100)}% del mes`}</span>}</div>
      </div>
      <div className="hero-side">
        <div><span>Ingresos previstos</span><strong>{whole(overview.incomeCents + overview.fundingCents)}</strong><small>Recibidos y clasificados: {whole(overview.actualIncomeCents)}</small></div>
        <div className={overview.unallocatedCents === 0 ? 'ok' : overview.unallocatedCents < 0 ? 'bad' : 'warn'}><span>{overview.unallocatedCents < 0 ? 'Plan sin financiar' : 'Sin repartir en el plan'}</span><strong>{whole(Math.abs(overview.unallocatedCents))}</strong><small>{overview.unallocatedCents === 0 ? 'Cada euro tiene destino' : overview.unallocatedCents < 0 ? 'Este mes tira de ahorro u otros meses' : 'Puedes asignarlo a una partida'}</small></div>
      </div>
    </section>

    <MovementInbox data={data} periods={periods} rows={overview.rows} onChanged={onChanged}/>

    {overGroups.length > 0 && <p className="month-alert"><b>Atención:</b> te has pasado en {overGroups.map(group => group.name).join(', ')}.</p>}

    <section className="month-groups">
      <header><h2>Por grupos</h2><span>Pulsa un grupo para ver sus partidas · <button className="text-button" onClick={() => onMovements()}>Revisar todos los movimientos</button></span></header>
      {groups.length === 0 ? <p className="month-empty">No hay presupuesto para este periodo.</p> : <div className="group-grid">{groups.map(group => <GroupCard key={group.name} name={group.name} color={group.color} rows={group.rows} onEditPlan={onEditPlan} onMovements={onMovements}/>)}</div>}
    </section>

    {incomeRows.length > 0 && <section className="month-income">
      <h2>Ingresos</h2>
      <ul>{incomeRows.map(row => <li key={row.id}><span>{row.name}</span><button className="line-link" onClick={() => onMovements(row)}>{formatEuros(row.actualCents)} recibido</button><button className="line-link" onClick={() => onEditPlan(row)}>de {formatEuros(row.plannedCents)} <Pencil size={11}/></button><span className={`income-state ${row.actualCents >= row.plannedCents && row.plannedCents > 0 ? 'ok' : ''}`}>{row.actualCents >= row.plannedCents && row.plannedCents > 0 ? 'Recibido' : 'Pendiente'}</span></li>)}</ul>
    </section>}
  </div>;
}
