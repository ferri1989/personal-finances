import { useEffect, useState } from 'react';
import { ArrowDownLeft, FileSpreadsheet, LoaderCircle, RefreshCw, Search, Upload } from 'lucide-react';
import { formatEuros, type Account } from '../shared/accounts';
import type { ImportBatch, Movement } from '../shared/imports';
import { api } from './api';
import type { BudgetLine } from '../shared/budget';
import { AssignmentOptions } from './assignment-options';

export function MovementsPage({ accounts, refreshKey, onImport, onBudget }: { accounts: Account[]; refreshKey: number; onImport: () => void; onBudget:()=>void }) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [accountId, setAccountId] = useState('all');
  const [month, setMonth] = useState('');
  const [direction, setDirection] = useState('all');
  const [categoryStatus, setCategoryStatus] = useState('all');
  async function load() {
    setLoading(true); setError('');
    try {
      const [data, categories] = await Promise.all([
        api<{ movements: Movement[]; batches: ImportBatch[] }>('/api/movements'),
        api<{ lines: BudgetLine[] }>('/api/budget/lines'),
      ]);
      setMovements(data.movements); setBatches(data.batches); setLines(categories.lines);
    }
    catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [refreshKey]);
  async function assign(row: Movement, value: string) {
    setSaving(row.id); setError(''); setNotice('');
    const lineId = value.startsWith('__') ? null : value;
    const excluded = value === '__excluded';
    try {
      await api('/api/budget/assignments', { method: 'POST', body: JSON.stringify({
        items: [{ entryId: row.id, expectedVersion: row.assignmentVersion }], lineId, excluded,
      }) });
      setMovements(previous => previous.map(item => item.id === row.id
        ? { ...item, lineId, excluded, assignmentVersion: row.assignmentVersion + 1 } : item));
      setNotice(`Categoría guardada para «${row.description}».`);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(null); }
  }
  const categoryLabel = (row: Movement) => row.excluded ? 'Traspaso interno / Excluir' : lines.find(line => line.id === row.lineId)?.name ?? 'Sin asignar';
  const filtered = movements.filter(row => (accountId === 'all' || row.accountId === accountId) && (!month || row.date.startsWith(month)) && (direction === 'all' || (direction === 'income' ? row.amountCents >= 0 : row.amountCents < 0)) && (categoryStatus === 'all' || (!row.lineId && !row.excluded)) && `${row.description} ${row.category} ${row.subcategory} ${row.accountName} ${row.comment} ${categoryLabel(row)}`.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es')));
  const incoming = filtered.reduce((sum, row) => sum + Math.max(0, row.amountCents), 0);
  const outgoing = filtered.reduce((sum, row) => sum + Math.min(0, row.amountCents), 0);

  return <>
    <div className="page-heading"><div><span className="eyebrow">TU HISTÓRICO, SIN BORRAR NADA</span><h1>Los movimientos de tu dinero<span>.</span></h1><p>Importa tus extractos y conserva cada entrada y salida.</p></div><button className="button primary" onClick={onImport}><Upload size={17}/> Importar Excel / CSV</button></div>
    <section className="summary-grid" aria-label="Resumen de movimientos filtrados"><div className="summary-card"><div className="card-top">Entradas registradas</div><strong className="positive">{loading || error ? '—' : formatEuros(incoming)}</strong><p>En el periodo y las cuentas seleccionadas</p></div><div className="summary-card"><div className="card-top">Salidas registradas</div><strong>{loading || error ? '—' : formatEuros(-outgoing)}</strong><p>Incluye traspasos e inversiones sin clasificar</p></div><div className="summary-card"><div className="card-top">Variación neta</div><strong>{loading || error ? '—' : formatEuros(incoming + outgoing)}</strong><p>{filtered.length} movimientos · Sin saldo de apertura</p></div></section>
    <p className="movement-disclaimer">Estas cifras son flujos bancarios, incluidos traspasos. Puedes cambiar la categoría de cada movimiento aquí o excluirlo como traspaso interno. Los cambios se reflejan en el presupuesto. <button className="text-button" onClick={onBudget}>Ir al presupuesto →</button></p>
    {error && <div className="error-banner" role="alert">{error}<button disabled={saving !== null} onClick={() => void load()}>Actualizar y reintentar</button></div>}
    {notice && <p className="movement-save-status" role="status">{notice}</p>}
    <div className="section-heading"><div><h2>Movimientos <span>{filtered.length}</span></h2><p>Los extractos solapados se comprueban antes de añadir movimientos.</p></div><button className="text-button" disabled={loading || saving !== null} onClick={() => void load()}><RefreshCw size={14} className={loading ? 'spin' : ''}/> Actualizar</button></div>
    <section className="accounts-panel"><div className="toolbar movements-toolbar"><div className="search-box"><Search size={17}/><input aria-label="Buscar movimientos" placeholder="Buscar concepto o categoría…" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="movement-filters"><select aria-label="Filtrar movimientos por cuenta" value={accountId} onChange={e => setAccountId(e.target.value)}><option value="all">Todas las cuentas</option>{accounts.map(account => <option value={account.id} key={account.id}>{account.name}{account.archived ? ' (archivada)' : ''}</option>)}</select><input type="month" aria-label="Mes de movimientos" value={month} onChange={e => setMonth(e.target.value)}/><select aria-label="Tipo de movimiento" value={direction} onChange={e => setDirection(e.target.value)}><option value="all">Entradas y salidas</option><option value="income">Entradas</option><option value="expense">Salidas</option></select><select aria-label="Filtrar por categorización" value={categoryStatus} onChange={e => setCategoryStatus(e.target.value)}><option value="all">Todas las categorías</option><option value="pending">Sin categorizar</option></select>{month && <button className="text-button" onClick={() => setMonth('')}>Todos los meses</button>}</div></div>
    {loading ? <div className="loading-state"><LoaderCircle className="spin" size={22}/> Cargando movimientos…</div> : movements.length === 0 ? <div className="empty-state"><div className="import-empty-icon"><FileSpreadsheet size={37}/></div><h3>El primer extracto marca el inicio</h3><p>Elige la cuenta y desde qué día quieres empezar.<br/>Revisarás el saldo inicial y los movimientos antes de guardar.</p><button className="button primary" onClick={onImport}><Upload size={16}/> Importar mi primer extracto</button><div className="supported-banks">ING<span/>Openbank<span/>Sabadell<span/>MyInvestor</div></div> : filtered.length === 0 ? <div className="no-results"><Search size={24}/><h3>No hay movimientos con estos filtros</h3><button className="text-button" onClick={() => { setQuery(''); setAccountId('all'); setMonth(''); setDirection('all'); setCategoryStatus('all'); }}>Limpiar filtros</button></div> : <div className="table-scroll movements-table"><table><thead><tr><th>FECHA</th><th>CONCEPTO</th><th>CATEGORÍA</th><th>CUENTA</th><th className="align-right">IMPORTE</th><th className="align-right">SALDO EN EXTRACTO</th></tr></thead><tbody>{filtered.map(row => <tr key={row.id}><td className="movement-date">{row.date}{row.valueDate && row.valueDate !== row.date && <small>Valor: {row.valueDate}</small>}</td><td className="description-cell"><strong>{row.description}</strong><small>{row.category ? `${row.category}${row.subcategory ? ` / ${row.subcategory}` : ''}` : 'Sin categoría bancaria'}</small>{row.comment && <small>{row.comment}</small>}</td><td className="movement-category"><select aria-label={`Categoría de ${row.description} del ${row.date}`} disabled={saving !== null} value={row.excluded ? '__excluded' : row.lineId ?? '__pending'} onChange={e => void assign(row, e.target.value)}><AssignmentOptions lines={lines}/></select>{saving === row.id && <small role="status">Guardando…</small>}</td><td><div className="type-cell"><span>{row.accountName}</span><small>{row.bank}</small></div></td><td className={`align-right balance-cell ${row.amountCents < 0 ? 'negative' : 'positive'}`}>{row.amountCents > 0 ? '+' : ''}{formatEuros(row.amountCents)}</td><td className="align-right type-cell-balance">{row.balanceAfterCents === null ? '—' : formatEuros(row.balanceAfterCents)}</td></tr>)}</tbody></table></div>}
    <div className="panel-footer"><ArrowDownLeft size={13}/><span>{movements.length} movimientos cargados{movements.length >= 10000 ? ' · Se muestran los últimos 10.000' : ''}</span><span className="panel-footer-right">EUR (€)</span></div></section>
    {batches.length > 0 && <section className="import-history"><h2>Últimas importaciones</h2><div className="accounts-panel"><table><thead><tr><th>ARCHIVO</th><th>CUENTA</th><th>IMPORTADO</th><th className="align-right">NUEVOS</th></tr></thead><tbody>{batches.map(batch => <tr key={batch.id}><td><div className="history-file"><FileSpreadsheet size={16}/>{batch.filename}</div></td><td>{batch.accountName}</td><td>{new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(batch.importedAt))}</td><td className="align-right">{batch.rowCount}</td></tr>)}</tbody></table></div></section>}
  </>;
}
