import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { formatEuros, localDate } from '../shared/accounts';
import type { BudgetClosePreview } from '../shared/budget';
import { api } from './api';

export function BudgetCloseDialog({ period, onClose, onSaved }: { period: string; onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<BudgetClosePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  useEffect(() => {
    let alive = true;
    api<BudgetClosePreview>('/api/budget/close/preview', { method: 'POST', body: JSON.stringify({ period }) })
      .then(data => { if (alive) setPreview(data); }).catch(err => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [period]);
  async function save() {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      await api(preview.closed ? '/api/budget/reopen' : '/api/budget/close', { method: 'POST', body: JSON.stringify(preview.closed ? { period } : { period, fingerprint: preview.fingerprint }) });
      onSaved();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const tooSoon = period >= localDate().slice(0, 7);
  return <dialog ref={ref} className="account-dialog budget-dialog wide" aria-labelledby="closing-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-header"><div><span className="eyebrow">CIERRE MENSUAL</span><h2 id="closing-title">{preview?.closed ? 'Deshacer cierre' : 'Revisar cierre'} · {period}</h2></div><button className="icon-button" aria-label="Cerrar ventana" disabled={busy} onClick={onClose}><X size={20}/></button></div>
    <p className="dialog-description">El sobrante o déficit de cada partida de gastos y ahorro pasa al mes siguiente. El objetivo mensual se conserva por separado. No se crean ingresos ni movimientos bancarios.</p>
    {!preview && !error && <p className="loading-state"><LoaderCircle className="spin" size={18}/> Calculando arrastres…</p>}
    {preview && <>
      <p className="budget-help">{preview.closed ? `Al deshacerlo se retirarán sus arrastres de ${preview.nextPeriod}. Si ese mes está cerrado, deshaz primero su cierre.` : `Destino: ${preview.nextPeriod}. Disponible siguiente = objetivo siguiente + arrastre + saldo inicial, si existe.`}</p>
      {!preview.closed && tooSoon && <p className="import-warning">Puedes revisar los importes ahora; el cierre se habilita cuando termine el mes.</p>}
      {preview.unassignedCount > 0 && <p className="import-warning">Quedan {preview.unassignedCount} movimientos sin asignar. Asígnalos o exclúyelos antes de cerrar.</p>}
      {preview.fundingAdjustmentCents !== 0 && <p className="import-warning">El remanente previsto de 1.500 € de enero se sustituirá por los arrastres calculados, para no duplicar el dinero.</p>}
      <div className="table-scroll close-preview"><table><thead><tr><th>PARTIDA</th><th>OBJETIVO</th><th>SALDO ANTERIOR</th><th>REAL</th><th>ARRASTRE</th><th>OBJETIVO SIGUIENTE</th><th>DISPONIBLE SIGUIENTE</th></tr></thead><tbody>{preview.rows.filter(row => row.goalCents || row.carryoverCents || row.actualCents || row.nextGoalCents || row.nextOpeningCents).map(row => <tr key={row.lineId}><th>{row.name}</th><td>{formatEuros(row.goalCents)}</td><td>{formatEuros(row.carryoverCents)}</td><td>{formatEuros(row.actualCents)}</td><td className={row.remainingCents < -100 ? 'negative' : 'positive'}>{formatEuros(row.remainingCents)}</td><td>{formatEuros(row.nextGoalCents)}</td><td>{formatEuros(row.nextAvailableCents)}{row.nextOpeningCents !== 0 && <small>Incluye saldo inicial: {formatEuros(row.nextOpeningCents)}</small>}</td></tr>)}</tbody></table></div>
      <p className="budget-help">{preview.closed ? 'Podrás corregir los movimientos y volver a cerrar el mes.' : 'Confirma que has importado todos los extractos. El mes cerrado quedará protegido hasta que deshagas el cierre.'}</p>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-footer"><button className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy || !preview || (!preview.closed && (tooSoon || preview.unassignedCount > 0))} onClick={() => void save()}>{busy && <LoaderCircle size={16} className="spin"/>}{preview?.closed ? 'Deshacer cierre y reabrir' : 'Confirmar cierre y arrastrar'}</button></div>
  </dialog>;
}
