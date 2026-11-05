import { useState } from 'react';
import { formatEuros } from '../shared/accounts';
import type { BudgetCell, BudgetData, BudgetKind, BudgetLine } from '../shared/budget';
import './budget-sheet.css';

type Mode = 'plan' | 'actual' | 'left' | 'original';
const modeLabels: Record<Mode, string> = { plan: 'Plan', actual: 'Real', left: 'Queda', original: 'Original' };
const monthShort = (period: string) => new Intl.DateTimeFormat('es-ES', { month: 'short' }).format(new Date(`${period}-15T12:00:00`)).replace('.', '');
/** Euros enteros sin símbolo, como en la hoja de cálculo. */
const n = (cents: number | null) => cents === null ? '' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(cents / 100));
const todayPeriod = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

/**
 * Vista anual compacta tipo hoja: una fila por partida, una columna por mes,
 * entradas/salidas/resumen arriba y las celdas que se han pasado en rojo.
 */
export function BudgetSheet({ data, onEditCell, onOpenMonth, onEditLine, detailToggle }: {
  data: BudgetData;
  onEditCell: (line: BudgetLine, cell: BudgetCell) => void;
  onOpenMonth: (period: string) => void;
  onEditLine: (line: BudgetLine) => void;
  detailToggle: React.ReactNode;
}) {
  const [mode, setMode] = useState<Mode>(() => { try { const v = localStorage.getItem('finance-sheet-mode'); return v === 'actual' || v === 'left' || v === 'original' ? v : 'plan'; } catch { return 'plan'; } });
  const [showEmpty, setShowEmpty] = useState(false);
  function changeMode(value: Mode) { setMode(value); try { localStorage.setItem('finance-sheet-mode', value); } catch { /* opcional */ } }
  const periods = data.periods;
  const today = todayPeriod();
  const cells = new Map(data.cells.map(cell => [`${cell.lineId}:${cell.period}`, cell]));
  const cellFor = (line: BudgetLine, p: string): BudgetCell => cells.get(`${line.id}:${p}`) ?? { lineId: line.id, period: p, originalCents: null, plannedCents: null, actualCents: 0, version: 1 };
  const value = (line: BudgetLine, cell: BudgetCell): number | null => {
    if (mode === 'original') return cell.originalCents;
    if (mode === 'actual') return cell.actualCents === 0 ? null : cell.actualCents;
    if (mode === 'left') return cell.plannedCents === null && !cell.carryoverCents && cell.actualCents === 0 ? null : (cell.plannedCents ?? 0) + (cell.carryoverCents ?? 0) - cell.actualCents;
    return cell.plannedCents;
  };
  const hasData = (line: BudgetLine) => periods.some(p => { const c = cellFor(line, p); return c.plannedCents !== null || c.originalCents !== null || c.actualCents !== 0 || Boolean(c.carryoverCents); });
  const spendKinds: BudgetKind[] = ['expense', 'saving'];
  const spendLines = data.lines.filter(line => spendKinds.includes(line.kind) && (showEmpty || hasData(line)));
  const incomeLines = data.lines.filter(line => (line.kind === 'income' || line.kind === 'funding') && (showEmpty || hasData(line)));
  const months = new Map(data.months.map(m => [m.period, m]));
  const real = mode === 'actual';
  const inOf = (p: string) => { const m = months.get(p); return m ? (real ? m.actualIncomeCents : m.incomeCents + m.fundingCents) : 0; };
  const outOf = (p: string) => { const m = months.get(p); return m ? (real ? m.actualOutCents : m.expenseCents + m.savingCents) : 0; };
  const totalIn = periods.reduce((s, p) => s + inOf(p), 0), totalOut = periods.reduce((s, p) => s + outOf(p), 0);
  const balance = totalIn - totalOut;
  const columnClass = (p: string) => `${p === today ? 'is-today' : ''} ${p < today ? 'is-past' : ''}`;

  const row = (line: BudgetLine) => {
    let total = 0, any = false;
    const tds = periods.map(p => {
      const cell = cellFor(line, p);
      const v = value(line, cell);
      if (v !== null) { total += v; any = true; }
      const spend = line.kind === 'expense' || line.kind === 'saving';
      const over = spend && cell.actualCents > (cell.plannedCents ?? 0) + (cell.carryoverCents ?? 0) && cell.actualCents - ((cell.plannedCents ?? 0) + (cell.carryoverCents ?? 0)) >= 100;
      const done = spend && !over && cell.actualCents > 0 && (cell.plannedCents ?? 0) > 0;
      const tip = `${line.name} · ${monthShort(p)}\nPlan: ${formatEuros(cell.plannedCents ?? 0)}${cell.carryoverCents ? `\nSaldo anterior: ${formatEuros(cell.carryoverCents)}` : ''}\nReal: ${formatEuros(cell.actualCents)}${cell.originalCents !== null ? `\nOriginal: ${formatEuros(cell.originalCents)}` : ''}\nPulsa para editar el plan`;
      return <td key={p} className={`${columnClass(p)} ${over ? 'over' : ''} ${done && mode === 'plan' ? 'spent' : ''} ${mode === 'left' && v !== null && v < 0 ? 'neg' : ''}`}>
        <button title={tip} onClick={() => onEditCell(line, cell)}>{n(v)}{cell.carryoverCents ? <i className="carry-dot" aria-label="con saldo anterior"/> : null}</button>
      </td>;
    });
    return <tr key={line.id}>
      <th className="sheet-name"><button onClick={() => onEditLine(line)} title={line.note || 'Editar partida'}>{line.name}</button></th>
      {tds}
      <td className={`sheet-total ${mode === 'left' && total < 0 ? 'neg' : ''}`}>{any ? n(total) : ''}</td>
      <td className="sheet-group">{line.group}</td>
    </tr>;
  };
  const subtotal = (label: string, lines: BudgetLine[]) => {
    const per = periods.map(p => lines.reduce((s, line) => s + (value(line, cellFor(line, p)) ?? 0), 0));
    return <tr className="sheet-subtotal"><th className="sheet-name">{label}</th>{per.map((v, i) => <td key={periods[i]} className={`${columnClass(periods[i])} ${v < 0 && mode === 'left' ? 'neg' : ''}`}>{n(v)}</td>)}<td className="sheet-total">{n(per.reduce((a, b) => a + b, 0))}</td><td/></tr>;
  };

  return <section className="sheet-panel" aria-label={`Presupuesto ${data.year} en vista de hoja`}>
    <div className="sheet-toolbar">
      <div className="sheet-modes" role="group" aria-label="Qué mostrar en las celdas">{(Object.keys(modeLabels) as Mode[]).map(key => <button key={key} className={mode === key ? 'active' : ''} aria-pressed={mode === key} onClick={() => changeMode(key)}>{modeLabels[key]}</button>)}</div>
      <div className={`sheet-resumen ${Math.abs(balance) < 100 ? 'ok' : balance < 0 ? 'bad' : 'warn'}`}>{real ? 'Real entradas − salidas' : 'Resumen'}: <strong>{n(balance)} €</strong></div>
      <label className="sheet-check"><input type="checkbox" checked={showEmpty} onChange={e => setShowEmpty(e.target.checked)}/> Partidas vacías</label>
      {detailToggle}
    </div>
    <div className="sheet-scroll">
      <table className={`sheet ${periods.length < 6 ? 'narrow' : ''}`}>
        <thead><tr><th className="sheet-name">{data.year}</th>{periods.map(p => <th key={p} className={columnClass(p)}><button onClick={() => onOpenMonth(p)} title="Abrir este mes">{monthShort(p)}</button></th>)}<th className="sheet-total">Total</th><th className="sheet-group">Grupo</th></tr></thead>
        <tbody className="sheet-summary">
          <tr><th className="sheet-name">Entradas</th>{periods.map(p => <td key={p} className={columnClass(p)}>{n(inOf(p))}</td>)}<td className="sheet-total">{n(totalIn)}</td><td className="sheet-group">{real ? 'Ingresos clasificados' : 'Ingresos + saldos anteriores'}</td></tr>
          <tr><th className="sheet-name">Salidas</th>{periods.map(p => <td key={p} className={columnClass(p)}>{n(outOf(p))}</td>)}<td className="sheet-total">{n(totalOut)}</td><td className="sheet-group">{real ? 'Gastos y ahorro clasificados' : 'Gastos y ahorro previstos'}</td></tr>
          <tr className="sheet-diff"><th className="sheet-name">Diferencia</th>{periods.map(p => { const d = inOf(p) - outOf(p); return <td key={p} className={`${columnClass(p)} ${Math.abs(d) < 100 ? 'zero' : d < 0 ? 'neg' : 'pos'}`}>{n(d)}</td>; })}<td className={`sheet-total ${Math.abs(balance) < 100 ? 'zero' : balance < 0 ? 'neg' : 'pos'}`}>{n(balance)}</td><td className="sheet-group">Negativo = tira de otro mes</td></tr>
        </tbody>
        {incomeLines.length > 0 && <tbody><tr className="sheet-section"><th className="sheet-name">Entradas por partida</th><td colSpan={periods.length + 2}/></tr>{incomeLines.map(row)}</tbody>}
        <tbody><tr className="sheet-section"><th className="sheet-name">Gastos, ahorro y reservas</th><td colSpan={periods.length + 2}/></tr>{spendLines.map(row)}{subtotal('Total salidas', spendLines)}</tbody>
      </table>
    </div>
    <p className="sheet-legend"><span className="lg over"/> Te has pasado ese mes <span className="lg spent"/> Ya tiene gasto <span className="lg today"/> Mes actual <i className="carry-dot"/> Incluye saldo anterior · Pulsa una celda para cambiar el plan o un mes para abrirlo.</p>
  </section>;
}
