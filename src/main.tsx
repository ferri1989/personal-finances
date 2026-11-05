import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, CalendarCheck, ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, CreditCard, Landmark, Layers3, LoaderCircle, LockKeyhole, Pencil, Plus, RefreshCw, Search, ShieldCheck, Wallet, X } from 'lucide-react';
import { accountTypes, banks, formatEuros, localDate, parseEuros, type Account, type AccountInput } from '../shared/accounts';
import './styles.css';
import { api } from './api';
import { MovementsPage } from './movements';
import { AccountReconciliation } from './account-reconciliation';
import type { TransferReconciliation } from '../shared/reconciliation';
import { ImportWizard } from './import-wizard';
import { BudgetPage } from './budget';

const bankColors: Record<string, string> = { ING: '#ed731f', Openbank: '#d43653', Sabadell: '#2581bc', MyInvestor: '#304eb2', Otro: '#636875', Efectivo: '#49786c' };
const bankMarks: Record<string, string> = { ING: 'ing', Openbank: 'ob', Sabadell: 'BS', MyInvestor: 'my', Otro: '·', Efectivo: '€' };
/** Las tarjetas de ING se cobran el día 5: lo pendiente hoy se cobra el próximo día 5. */
const nextCardCharge = () => { const d = new Date(); const target = d.getDate() < 5 ? new Date(d.getFullYear(), d.getMonth(), 5) : new Date(d.getFullYear(), d.getMonth() + 1, 5); return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-05`; };
const dateLabel = (value: string) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`));

function BankLogo({ bank, small = false }: { bank: string; small?: boolean }) {
  return <span className={`bank-logo ${small ? 'small' : ''}`} style={{ '--bank-color': bankColors[bank] } as React.CSSProperties}>{bankMarks[bank]}</span>;
}

type FormState = Omit<AccountInput, 'openingBalanceCents' | 'interestRate'> & { amount: string; interest: string };

function AccountForm({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: (account: Account) => void }) {
  const [form, setForm] = useState<FormState>(account ? {
    name: account.name, bank: account.bank, type: account.type, owner: account.owner,
    lastFour: account.lastFour, openingDate: account.openingDate, amount: (account.openingBalanceCents / 100).toFixed(2).replace('.', ','),
    interest: account.interestRate?.toString().replace('.', ',') ?? '', maturityDate: account.maturityDate ?? '',
  } : { name: '', bank: 'ING', type: 'current', owner: '', lastFour: '', openingDate: localDate(), amount: '', interest: '', maturityDate: '' });
  const isDeposit = form.type === 'deposit';
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current!; dialog.showModal(); return () => dialog.close(); }, []);
  function set<K extends keyof FormState>(key: K, value: FormState[K]) { setForm(previous => ({ ...previous, [key]: value })); }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const cents = parseEuros(form.amount);
    if (cents === null) { setError('Introduce un importe válido, sin separador de miles y con un máximo de dos decimales.'); return; }
    const interestRate = /^\d+(?:[.,]\d+)?$/.test(form.interest.trim()) ? Number(form.interest.replace(',', '.')) : NaN;
    if (isDeposit && (!Number.isFinite(interestRate) || interestRate < 0 || interestRate > 100)) { setError('Introduce un interés anual entre 0 y 100 %.'); return; }
    setSaving(true); setError('');
    try {
      const { amount: _amount, interest: _interest, maturityDate, ...fields } = form;
      const result = await api<{ account: Account }>(account ? `/api/accounts/${account.id}` : '/api/accounts', {
        method: account ? 'PUT' : 'POST',
        body: JSON.stringify({ ...fields, openingBalanceCents: cents, ...(isDeposit ? { interestRate, maturityDate } : {}), ...(account ? { expectedVersion: account.version } : {}) }),
      });
      onSaved(result.account);
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  }

  return <dialog ref={dialogRef} className="account-dialog" aria-labelledby="form-title" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-header"><div><span className="eyebrow">TU PUNTO DE PARTIDA</span><h2 id="form-title">{account ? 'Editar cuenta' : 'Añadir una cuenta'}</h2></div><button className="icon-button" type="button" aria-label="Cerrar formulario" onClick={onClose} disabled={saving}><X size={21}/></button></div>
      <p className="dialog-description">Registra el dinero que tienes y la fecha desde la que quieres empezar a llevar tus finanzas.</p>
      <fieldset disabled={saving}>
        <label>Nombre de la cuenta<input autoFocus required maxLength={80} placeholder="Ej. Cuenta del día a día" value={form.name} onChange={e => set('name', e.target.value)}/></label>
        <div className="form-grid"><label>Banco<select value={form.bank} onChange={e => set('bank', e.target.value as FormState['bank'])}>{banks.map(bank => <option key={bank}>{bank}</option>)}</select></label>
        <label>Tipo de cuenta<select value={form.type} onChange={e => set('type', e.target.value as FormState['type'])}>{Object.entries(accountTypes).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label></div>
        <div className="form-grid"><label>Titular <span className="optional">Opcional</span><input maxLength={80} placeholder="Ej. Jordi y MJ" value={form.owner} onChange={e => set('owner', e.target.value)}/></label>
        <label>Últimos 4 dígitos <span className="optional">Opcional</span><input inputMode="numeric" pattern="[0-9]{4}" maxLength={4} placeholder="1234" value={form.lastFour} onChange={e => set('lastFour', e.target.value)}/></label></div>
        <div className="opening-block"><h3><Wallet size={17}/> {isDeposit ? 'Datos del depósito' : 'Saldo inicial'}</h3><div className="form-grid"><label>{isDeposit ? 'Importe del depósito en euros' : 'Importe en euros'}<div className="amount-input"><input required inputMode="decimal" placeholder="0,00" value={form.amount} onChange={e => set('amount', e.target.value)}/><span>€</span></div></label>
        <label>{isDeposit ? 'Fecha de inicio' : 'Fecha del saldo'}<input type="date" required min="1900-01-01" max="2200-12-31" value={form.openingDate} onChange={e => set('openingDate', e.target.value)}/></label></div>
        {isDeposit && <div className="form-grid"><label>Interés anual (%)<input required inputMode="decimal" placeholder="Ej. 2,5" value={form.interest} onChange={e => set('interest', e.target.value)}/></label><label>Fecha de vencimiento<input type="date" required min={form.openingDate || '1900-01-01'} max="2200-12-31" value={form.maturityDate} onChange={e => set('maturityDate', e.target.value)}/></label></div>}
        <p>{isDeposit ? 'Registra el capital depositado. Los intereses futuros no se suman al saldo. Si procede de otra cuenta registrada, refleja también la salida allí para evitar duplicar el dinero.' : 'Usa el saldo de la cuenta en esa fecha, sin incluir inversiones ni ingresos futuros. Puedes introducir un saldo negativo.'}</p></div>
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button className="button secondary" type="button" onClick={onClose} disabled={saving}>Cancelar</button><button className="button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>} {saving ? 'Guardando…' : account ? 'Guardar cambios' : 'Crear cuenta'}</button></div>
    </form>
  </dialog>;
}

function App() {
  const [page, setPage] = useState<'accounts' | 'movements' | 'budget'>(()=>window.location.hash==='#presupuesto'?'budget':window.location.hash==='#movimientos'?'movements':'accounts');
  const [importOpen, setImportOpen] = useState(false);
  const [movementRefresh, setMovementRefresh] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [reconciliation, setReconciliation] = useState<TransferReconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState<Account | null | undefined>(undefined);
  const [archiveTarget, setArchiveTarget] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const archiveDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const fragment=page==='budget'?'#presupuesto':page==='movements'?'#movimientos':'#cuentas';
    window.history.replaceState(null,'',fragment);
    document.title=`Mis finanzas · ${page==='budget'?'Presupuesto':page==='movements'?'Movimientos':'Cuentas'}`;
  },[page]);

  async function load() {
    setLoading(true); setError('');
    try { const data = await api<{ accounts: Account[]; reconciliation: TransferReconciliation }>('/api/accounts'); setAccounts(data.accounts); setReconciliation(data.reconciliation); }
    catch (err) { setError((err as Error).message || 'No se ha podido conectar con la aplicación local.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (page === 'accounts') void load(); }, [page]);
  useEffect(() => { if (page !== 'accounts') void load(); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (archiveTarget) archiveDialogRef.current?.showModal(); }, [archiveTarget]);

  function replace(account: Account) { setAccounts(old => { const exists = old.some(item => item.id === account.id); return exists ? old.map(item => item.id === account.id ? account : item) : [...old, account]; }); }
  async function payCard(account: Account) {
    setBusy(true); setError('');
    try {
      const { candidates } = await api<{ candidates: { id: string; date: string; amountCents: number; accountName: string; description: string }[] }>(`/api/accounts/${account.id}/card-payments`);
      if (!candidates.length) { setNotice('No hay cargos de tarjeta pendientes de registrar. Importa primero el extracto de la cuenta donde te la cobran.'); return; }
      const charge = candidates[0];
      if (!window.confirm(`¿Registrar este cargo como pago de «${account.name}»?

${dateLabel(charge.date)} · ${charge.accountName}
${charge.description}
${formatEuros(charge.amountCents)}

El cargo deja de contar como gasto (las compras ya cuentan en su mes) y la deuda de la tarjeta baja en ${formatEuros(-charge.amountCents)}.`)) return;
      const result = await api<{ account: Account }>(`/api/accounts/${account.id}/card-payments`, { method: 'POST', body: JSON.stringify({ entryId: charge.id, expectedVersion: account.version }) });
      replace(result.account); setNotice('Cargo registrado como pago de la tarjeta.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function mature(account: Account) {
    const date = account.maturityDate && account.maturityDate <= localDate() ? account.maturityDate : localDate();
    if (!window.confirm(`¿Registrar el vencimiento de «${account.name}» el ${dateLabel(date)}?

Sus ${formatEuros(account.balanceCents)} salen del depósito como traspaso interno, para casar con el «Abono depósito» de tu cuenta, y el depósito se archiva. Los intereses clasifícalos aparte como ingreso.`)) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ account: Account }>(`/api/accounts/${account.id}/mature`, { method: 'POST', body: JSON.stringify({ date, expectedVersion: account.version }) });
      replace(result.account); setNotice('Vencimiento registrado. El depósito queda archivado.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function archive(account: Account) {
    setBusy(true); setError('');
    try {
      const result = await api<{ account: Account }>(`/api/accounts/${account.id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: !account.archived, expectedVersion: account.version }) });
      replace(result.account); setArchiveTarget(null); setNotice(account.archived ? 'Cuenta reactivada.' : 'Cuenta archivada. Su historial se conserva.');
    } catch (err) { setError((err as Error).message); setArchiveTarget(null); } finally { setBusy(false); }
  }

  const active = accounts.filter(account => !account.archived);
  const total = active.reduce((sum, account) => sum + account.balanceCents, 0);
  const everyday = active.filter(account => account.type === 'current' || account.type === 'cash').reduce((sum, account) => sum + account.balanceCents, 0);
  const savings = active.filter(account => account.type === 'savings' || account.type === 'deposit').reduce((sum, account) => sum + account.balanceCents, 0);
  const cashInvestment = active.filter(account => account.type === 'investment_cash').reduce((sum, account) => sum + account.balanceCents, 0);
  const visible = accounts.filter(account => (showArchived || !account.archived) && (filter === 'all' || account.type === filter) && `${account.name} ${account.bank} ${account.owner} ${account.lastFour}`.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es')));
  const bankCount = new Set(active.map(account => account.bank).filter(bank => bank !== 'Efectivo')).size;
  const noData = !loading && !error && accounts.length === 0;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Mis finanzas, inicio"><span className="brand-icon"><Layers3 size={24}/></span><span>mis finanzas<span className="brand-dot">.</span></span></a>
      <div className="space-selector"><span className="space-avatar">MF</span><div><strong>Finanzas personales</strong><span>Mi espacio</span></div><ChevronDown size={15}/></div>
      <span className="nav-label">MI DINERO</span>
      <nav aria-label="Navegación principal"><button className={`nav-item nav-button ${page === 'accounts' ? 'active' : ''}`} onClick={() => setPage('accounts')} aria-current={page === 'accounts' ? 'page' : undefined}><Landmark size={19}/> Cuentas <span className="nav-count">{active.length}</span></button>
      <button className={`nav-item nav-button ${page === 'movements' ? 'active' : ''}`} onClick={() => setPage('movements')} aria-current={page === 'movements' ? 'page' : undefined}><ArrowDownLeft size={19}/> Movimientos</button>
      <button className={`nav-item nav-button ${page === 'budget' ? 'active' : ''}`} onClick={() => setPage('budget')} aria-current={page === 'budget' ? 'page' : undefined}><CreditCard size={19}/> Presupuesto</button>
      <div className="nav-item unavailable"><Wallet size={19}/> Objetivos de ahorro</div></nav>
      <div className="sidebar-note"><div className="mini-icon"><ShieldCheck size={20}/></div><strong>Tu dinero, en tu equipo</strong><p>Los datos se guardan localmente en este ordenador.</p><span><span className="status-dot"/> Almacenamiento local</span></div>
      <div className="sidebar-footer"><span className="profile-avatar">TÚ</span><div><strong>Tu espacio personal</strong><span>Piloto · Cuentas y saldos</span></div></div>
    </aside>

    <div className="main-shell"><header className="topbar"><div className="breadcrumb">Mi dinero <ChevronRight size={14}/><strong>{page === 'accounts' ? 'Cuentas' : page === 'movements' ? 'Movimientos' : 'Presupuesto'}</strong></div><span className="local-badge"><LockKeyhole size={13}/> Solo en este equipo</span></header>
    <main className={page==='budget'?'budget-main':undefined}>
      {page === 'accounts' ? <>
      <div className="page-heading"><div><span className="eyebrow">CADA CUENTA, EN SU SITIO</span><h1>Tu dinero, de un vistazo<span>.</span></h1><p>Reúne tus cuentas y empieza con una imagen clara de lo que tienes.</p></div><div className="heading-actions"><button className="button secondary" onClick={() => setImportOpen(true)}><ArrowDownLeft size={17}/> Importar Excel / CSV</button><button className="button primary" onClick={() => setForm(null)}><Plus size={18}/> Añadir cuenta</button></div></div>

      <section className="summary-grid" aria-label="Resumen de saldos activos">
        <div className="total-card"><div className="card-top"><span>Saldo total registrado</span><span className="summary-icon"><Wallet size={19}/></span></div><strong className="total-value">{loading || error ? '—' : formatEuros(total)}</strong><div className="total-footer"><span className="light-dot"/>{active.length} {active.length === 1 ? 'cuenta activa' : 'cuentas activas'}<span className="total-divider"/>{bankCount} {bankCount === 1 ? 'entidad' : 'entidades'}</div><div className="card-decoration"/></div>
        <div className="summary-card"><div className="card-top"><span>Día a día</span><span className="summary-icon"><CreditCard size={18}/></span></div><strong>{loading || error ? '—' : formatEuros(everyday)}</strong><p>Cuentas corrientes y efectivo</p></div>
        <div className="summary-card"><div className="card-top"><span>Ahorro</span><span className="summary-icon"><Landmark size={18}/></span></div><strong>{loading || error ? '—' : formatEuros(savings)}</strong><p>Cuentas de ahorro y depósitos</p></div>
      </section>
      {cashInvestment !== 0 && <p className="investment-note"><span/> El saldo total incluye {formatEuros(cashInvestment)} de efectivo de inversión. No incluye el valor de fondos ni acciones.</p>}

      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => void load()}><RefreshCw size={14}/> Reintentar</button></div>}

      {!loading && !error && reconciliation && accounts.length > 0 && <AccountReconciliation accounts={accounts} data={reconciliation} onImport={() => setImportOpen(true)} onMovements={() => setPage('movements')}/>}

      <section className="accounts-section" aria-labelledby="accounts-title"><div className="section-heading"><div><h2 id="accounts-title">Mis cuentas <span>{active.length}</span></h2><p>El punto de partida de tus finanzas.</p></div><button className="text-button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/> Actualizar</button></div>
      <div className="accounts-panel"><div className="toolbar"><div className="search-box"><Search size={17}/><input aria-label="Buscar cuentas" placeholder="Buscar por cuenta, banco o titular…" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button className="icon-button" aria-label="Limpiar búsqueda" onClick={() => setQuery('')}><X size={14}/></button>}</div><div className="filter-controls"><select aria-label="Filtrar por tipo de cuenta" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Todos los tipos</option>{Object.entries(accountTypes).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select><label className="archive-toggle"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)}/> Ver archivadas</label></div></div>

      {loading ? <div className="loading-state" role="status"><LoaderCircle className="spin" size={24}/> Cargando tus cuentas…</div> : error && accounts.length === 0 ? <div className="loading-state">No se han podido cargar las cuentas.</div> : noData ? <div className="empty-state"><div className="empty-art" aria-hidden="true"><span className="art-line one"/><span className="art-line two"/><div className="art-bank"><Landmark size={34}/></div><span className="art-coin">€</span><span className="art-plus">+</span></div><span className="eyebrow">EMPIEZA POR LO QUE YA TIENES</span><h3>Tu primera cuenta, tu punto de partida</h3><p>Añade una cuenta y su saldo inicial. Después podrás<br className="desktop-break"/> construir tu presupuesto sobre números reales.</p><button className="button primary" onClick={() => setForm(null)}><Plus size={17}/> Añadir mi primera cuenta</button><div className="supported-banks">ING<span/>Openbank<span/>Sabadell<span/>MyInvestor</div></div> : visible.length === 0 ? <div className="no-results"><Search size={25}/><h3>No hay cuentas para mostrar</h3><p>Prueba otra búsqueda o activa «Ver archivadas».</p><button className="text-button" onClick={() => { setQuery(''); setFilter('all'); setShowArchived(true); }}>Mostrar todas las cuentas <ArrowRight size={15}/></button></div> : <div className="table-scroll"><table><thead><tr><th>CUENTA</th><th>TIPO / TITULAR</th><th>IMPORTE / INICIO</th><th className="align-right">SALDO REGISTRADO</th><th><span className="sr-only">Acciones</span></th></tr></thead><tbody>{visible.map(account => <tr key={account.id} className={account.archived ? 'archived-row' : ''}><td><div className="account-name"><BankLogo bank={account.bank}/><div><strong>{account.name}</strong><span>{account.bank}{account.lastFour ? ` · •• ${account.lastFour}` : ''}{account.archived ? ' · Archivada' : ''}</span></div></div></td><td><div className="type-cell"><span>{accountTypes[account.type]}</span><small>{account.owner || 'Sin titular indicado'}</small>{account.type === 'deposit' && <><small>Interés anual: {account.interestRate?.toLocaleString('es-ES', { maximumFractionDigits: 6 })} %</small><small>Vencimiento: {account.maturityDate ? dateLabel(account.maturityDate) : '—'}{account.maturityDate && account.maturityDate <= localDate() ? ' · Vencido' : ''}</small></>}</div></td><td><div className="type-cell"><span>{formatEuros(account.openingBalanceCents)}</span><small>{dateLabel(account.openingDate)}</small></div></td><td className={`align-right balance-cell ${account.balanceCents < 0 ? 'negative' : ''}`}>{formatEuros(account.balanceCents)}{account.type === 'credit_card' && account.balanceCents < 0 && <small className="card-due">Se cobra el {dateLabel(nextCardCharge())}</small>}</td><td><div className="row-actions">{!account.archived && account.type === 'credit_card' && <button className="icon-button" title="Registrar el cargo mensual de la tarjeta" aria-label={`Registrar cargo de ${account.name}`} onClick={() => void payCard(account)} disabled={busy}><CreditCard size={16}/></button>}{!account.archived && account.type === 'deposit' && <button className="icon-button" title="Registrar vencimiento" aria-label={`Registrar vencimiento de ${account.name}`} onClick={() => void mature(account)} disabled={busy}><CalendarCheck size={16}/></button>}{!account.archived && <button className="icon-button" title={`Editar ${account.name}`} aria-label={`Editar ${account.name}`} onClick={() => setForm(account)}><Pencil size={16}/></button>}<button className="icon-button" title={account.archived ? 'Reactivar cuenta' : 'Archivar cuenta'} aria-label={`${account.archived ? 'Reactivar' : 'Archivar'} ${account.name}`} onClick={() => account.archived ? void archive(account) : setArchiveTarget(account)} disabled={busy}>{account.archived ? <RefreshCw size={16}/> : <Archive size={16}/>}</button></div></td></tr>)}</tbody></table></div>}
      <div className="panel-footer"><ShieldCheck size={14}/><span>Guardado local en este equipo</span><span className="panel-footer-right">Moneda: EUR (€)</span></div></div>
      </section>

      <section className="bottom-grid"><div className="guide-card"><div className="guide-icon"><CircleHelp size={22}/></div><div><h3>¿Qué es el saldo inicial?</h3><p>Es el dinero que tiene tu cuenta en la fecha que elijas para empezar. Será la referencia para los próximos movimientos.</p><span>Puedes corregirlo antes de registrar movimientos.</span></div></div><div className="next-card"><span className="step-label">PRESUPUESTO</span><h3>Cada euro, con un propósito <ArrowUpRight size={18}/></h3><p>Consulta el plan de 2026 y 2027, ajusta las previsiones y asigna tus movimientos.</p><button className="text-button" onClick={()=>setPage('budget')}>Abrir presupuesto <ArrowRight size={13}/></button></div></section>
      </> : page === 'movements' ? <MovementsPage accounts={accounts} refreshKey={movementRefresh} onImport={() => setImportOpen(true)} onBudget={()=>setPage('budget')}/> : <BudgetPage refreshKey={movementRefresh}/>}
      <footer className="page-footer"><span>Un poco de orden. Mucha tranquilidad.</span><span>Mis finanzas · Piloto 01</span></footer>
    </main></div>

    {form !== undefined && <AccountForm account={form} onClose={() => setForm(undefined)} onSaved={account => { replace(account); setForm(undefined); setNotice(form ? 'Cambios guardados.' : 'Cuenta creada. Ya tienes tu punto de partida.'); }}/>} 
    {importOpen && <ImportWizard accounts={accounts} onClose={() => setImportOpen(false)} onImported={result => { replace(result.account); setImportOpen(false); setPage('movements'); setMovementRefresh(value => value + 1); setNotice(`${result.imported} movimientos importados · ${result.duplicates} ya registrados.`); }}/>} 
    {archiveTarget && <dialog className="confirm-dialog" ref={archiveDialogRef} onCancel={event => { event.preventDefault(); if (!busy) setArchiveTarget(null); }} aria-labelledby="archive-title"><Archive size={26}/><h2 id="archive-title">¿Archivar esta cuenta?</h2><p><strong>{archiveTarget.name}</strong> dejará de aparecer en los saldos activos. Sus datos se conservan y podrás reactivarla cuando quieras.</p><div className="dialog-footer"><button className="button secondary" disabled={busy} onClick={() => setArchiveTarget(null)}>Cancelar</button><button className="button primary" disabled={busy} onClick={() => void archive(archiveTarget)}>{busy ? 'Archivando…' : 'Archivar cuenta'}</button></div></dialog>}
    {notice && <div className="toast" role="status"><Check size={18}/>{notice}</div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
