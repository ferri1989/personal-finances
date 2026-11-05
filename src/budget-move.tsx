import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, LoaderCircle, X } from 'lucide-react';
import { formatEuros, parseEuros } from '../shared/accounts';
import type { BudgetCell, BudgetData } from '../shared/budget';
import type { BudgetRow } from '../shared/budget-view';
import { api } from './api';

const monthName = (period: string) => new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(new Date(`${period}-15T12:00:00`));
export const nextPeriodOf = (period: string) => { const [y, m] = period.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const toInput = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

type Source =
  | { key: string; kind: 'unallocated'; label: string; detail: string; maxCents: number }
  | { key: string; kind: 'line'; label: string; detail: string; maxCents: number; cell: BudgetCell }
  | { key: string; kind: 'next'; label: string; detail: string; maxCents: number; cell: BudgetCell };

/**
 * Moves budgeted money into one box (partida) the way it is done on paper:
 * take it from what is still unassigned, from another box this month, or from this box next month.
 * Only planned amounts change; bank movements are never touched.
 */
export function MoveMoneyDialog({ data, rows, period, target, unallocatedCents, onClose, onSaved }: {
  data: BudgetData; rows: BudgetRow[]; period: string; target: BudgetRow; unallocatedCents: number; onClose: () => void; onSaved: (message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const overspent = Math.max(0, target.actualCents - target.plannedCents);
  const [amount, setAmount] = useState(overspent > 0 ? toInput(overspent) : '');
  const [sourceKey, setSourceKey] = useState('');
  const [nextCell, setNextCell] = useState<BudgetCell | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const next = nextPeriodOf(period);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  useEffect(() => {
    const local = data.cells.find(cell => cell.lineId === target.id && cell.period === next);
    if (local || data.periods.includes(next)) { setNextCell(local ?? null); return; }
    let alive = true;
    api<BudgetData>(`/api/budget/${next.slice(0, 4)}`).then(other => { if (alive) setNextCell(other.cells.find(cell => cell.lineId === target.id && cell.period === next) ?? null); }).catch(() => { if (alive) setNextCell(null); });
    return () => { alive = false; };
  }, [data, target.id, next]);

  const targetCell = data.cells.find(cell => cell.lineId === target.id && cell.period === period);
  const sources = useMemo(() => {
    const list: Source[] = [];
    if (unallocatedCents > 0) list.push({ key: 'unallocated', kind: 'unallocated', label: 'Dinero sin repartir este mes', detail: `${formatEuros(unallocatedCents)} disponibles`, maxCents: unallocatedCents });
    if (nextCell && (nextCell.plannedCents ?? 0) > 0) list.push({ key: 'next', kind: 'next', label: `${target.name} de ${monthName(next)}`, detail: `Adelantas de su presupuesto de ${formatEuros(nextCell.plannedCents ?? 0)}`, maxCents: nextCell.plannedCents ?? 0, cell: nextCell });
    for (const row of rows) {
      if (row.id === target.id || (row.kind !== 'expense' && row.kind !== 'saving')) continue;
      const cell = data.cells.find(item => item.lineId === row.id && item.period === period);
      const left = row.plannedCents - row.actualCents;
      // Only the monthly goal can be lowered; money carried from earlier months stays where it is.
      const max = Math.min(left, cell?.plannedCents ?? 0);
      if (cell && max > 0) list.push({ key: row.id, kind: 'line', label: row.name, detail: `Le quedan ${formatEuros(left)} · ${row.group}`, maxCents: max, cell });
    }
    return list.sort((a, b) => (a.kind === 'line' ? 1 : 0) - (b.kind === 'line' ? 1 : 0) || b.maxCents - a.maxCents);
  }, [rows, data.cells, period, target, unallocatedCents, nextCell, next]);
  useEffect(() => { if (!sourceKey && nextCell !== undefined && sources.length) setSourceKey(sources[0].key); }, [sources, sourceKey, nextCell]);
  const source = sources.find(item => item.key === sourceKey);
  const cents = parseEuros(amount);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!source || !targetCell) return;
    if (cents === null || cents <= 0) { setError('Escribe un importe mayor que cero, por ejemplo 25,50.'); return; }
    if (cents > source.maxCents) { setError(`Desde ahí puedes mover como máximo ${formatEuros(source.maxCents)}.`); return; }
    const items = [{ lineId: target.id, period, plannedCents: (targetCell.plannedCents ?? 0) + cents, expectedVersion: targetCell.version }];
    if (source.kind !== 'unallocated') items.push({ lineId: source.cell.lineId, period: source.cell.period, plannedCents: (source.cell.plannedCents ?? 0) - cents, expectedVersion: source.cell.version });
    setBusy(true); setError('');
    try {
      await api('/api/budget/cells/bulk', { method: 'PUT', body: JSON.stringify(items) });
      onSaved(`Movidos ${formatEuros(cents)} a ${target.name}.`);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const after = target.plannedCents - target.actualCents + (cents ?? 0);
  return <dialog ref={ref} className="account-dialog budget-dialog move-dialog" aria-labelledby="move-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={save}>
      <div className="dialog-header"><div><span className="eyebrow">MOVER DINERO · {monthName(period).toUpperCase()}</span><h2 id="move-title">{overspent > 0 ? `Cubrir ${target.name}` : `Añadir dinero a ${target.name}`}</h2></div><button type="button" className="icon-button" aria-label="Cerrar ventana" disabled={busy} onClick={onClose}><X size={20}/></button></div>
      <div className="move-target">
        <div><span>Presupuesto</span><strong>{formatEuros(target.plannedCents)}</strong></div>
        <div><span>Gastado</span><strong>{formatEuros(target.actualCents)}</strong></div>
        <div className={target.plannedCents - target.actualCents < 0 ? 'neg' : ''}><span>En la caja</span><strong>{formatEuros(target.plannedCents - target.actualCents)}</strong></div>
      </div>
      <label className="budget-form-label">¿Cuánto quieres mover?<div className="amount-input"><input autoFocus inputMode="decimal" value={amount} disabled={busy} placeholder="0,00" onChange={e => setAmount(e.target.value)}/><span>€</span></div></label>
      <p className="move-question">¿De dónde sale?</p>
      {nextCell === undefined && <p className="budget-help"><LoaderCircle size={14} className="spin"/> Buscando el mes siguiente…</p>}
      {sources.length === 0 && nextCell !== undefined ? <p className="import-warning">No hay ninguna caja con dinero disponible este mes ni presupuesto en {monthName(next)}. Puedes subir el presupuesto de la partida directamente.</p> :
        <div className="move-sources" role="radiogroup" aria-label="Origen del dinero">{sources.map(item => <label key={item.key} className={`move-source ${sourceKey === item.key ? 'selected' : ''} ${item.kind}`}>
          <input type="radio" name="move-source" checked={sourceKey === item.key} disabled={busy} onChange={() => setSourceKey(item.key)}/>
          <span>{item.label}<small>{item.detail}</small></span>
          {cents !== null && cents > item.maxCents && <em>máx. {formatEuros(item.maxCents)}</em>}
        </label>)}</div>}
      {source && cents !== null && cents > 0 && <p className="move-summary">{source.kind === 'unallocated' ? 'Sin repartir' : source.label} <ArrowRight size={14}/> {target.name}: <b>{formatEuros(cents)}</b>. La caja de {target.name} quedará en <b className={after < 0 ? 'neg' : ''}>{formatEuros(after)}</b>.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy || !source}>{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>} Mover dinero</button></div>
    </form>
  </dialog>;
}
