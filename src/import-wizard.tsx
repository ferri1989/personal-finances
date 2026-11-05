import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FileSpreadsheet, LoaderCircle, ShieldCheck, Upload, X } from 'lucide-react';
import { accountTypes, banks, formatEuros, parseEuros, type Account } from '../shared/accounts';
import type { ColumnMapping, ImportDocumentInfo, ImportPlanInfo, ImportResult } from '../shared/imports';
import { api } from './api';

const mappingLabels: Record<keyof ColumnMapping, string> = { date: 'Fecha de operación', valueDate: 'Fecha valor', description: 'Descripción', amount: 'Importe', balance: 'Saldo después del movimiento', category: 'Categoría del banco', subcategory: 'Subcategoría del banco', comment: 'Comentario' };
type Props = { accounts: Account[]; onClose: () => void; onImported: (result: ImportResult) => void };

export function ImportWizard({ accounts, onClose, onImported }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [document, setDocument] = useState<ImportDocumentInfo | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [headerRow, setHeaderRow] = useState('');
  const [accountId, setAccountId] = useState('new');
  const [newBank, setNewBank] = useState<Account['bank']>('ING');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<Account['type']>('current');
  const [newOwner, setNewOwner] = useState('');
  const [startDate, setStartDate] = useState('');
  const [manualOpening, setManualOpening] = useState('');
  const [plan, setPlan] = useState<ImportPlanInfo | null>(null);
  const [confirmOpening, setConfirmOpening] = useState(false);
  const [reviewDuplicates, setReviewDuplicates] = useState(false);
  const selectedAccount = accounts.find(account => account.id === accountId);
  const firstImport = !selectedAccount || selectedAccount.movementCount === 0;

  function initialDate(account: Account | undefined, doc: ImportDocumentInfo): string {
    if (!account) return '';
    if (account.movementCount > 0) return account.openingDate;
    return (!doc.firstDate || account.openingDate >= doc.firstDate) && (!doc.lastDate || account.openingDate <= doc.lastDate) ? account.openingDate : '';
  }

  function chooseStartDate(value: string) {
    if (value !== startDate && mapping && mapping.balance < 0) setManualOpening('');
    setStartDate(value);
  }

  useEffect(() => { const dialog = dialogRef.current!; dialog.showModal(); return () => dialog.close(); }, []);

  async function upload(event: React.FormEvent) {
    event.preventDefault(); if (!file) return;
    setBusy(true); setError('');
    try {
      const data = await api<{ document: ImportDocumentInfo }>('/api/imports/preview', {
        method: 'POST', body: await file.arrayBuffer(),
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), ...(headerRow ? { 'X-Header-Row': headerRow } : {}) },
      });
      const doc = data.document;
      setDocument(doc); setMapping(doc.mapping); setNewBank(doc.detectedBank || newBank);
      setNewName(`${doc.creditCard ? 'Tarjeta ' : ''}${doc.detectedBank || newBank}${doc.lastFour ? ` · ${doc.lastFour}` : ''}`);
      setNewOwner(doc.owner);
      setNewType(doc.creditCard ? 'credit_card' : doc.detectedBank === 'MyInvestor' ? 'investment_cash' : 'current');
      const matching = accounts.filter(account => !account.archived && account.type !== 'deposit' && (account.type === 'credit_card') === Boolean(doc.creditCard) && account.bank === doc.detectedBank && (!doc.lastFour || !account.lastFour || account.lastFour === doc.lastFour));
      setAccountId(matching.length === 1 ? matching[0].id : 'new');
      const account = matching.length === 1 ? matching[0] : undefined;
      const date = initialDate(account, doc);
      setStartDate(date);
      setManualOpening(account && date === account.openingDate ? (account.openingBalanceCents / 100).toFixed(2).replace('.', ',') : '');
      setStep(2);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  function chooseAccount(id: string) {
    setAccountId(id); setPlan(null); setConfirmOpening(false);
    const account = accounts.find(item => item.id === id);
    const date = document ? initialDate(account, document) : '';
    setStartDate(date);
    setManualOpening(account && date === account.openingDate ? (account.openingBalanceCents / 100).toFixed(2).replace('.', ',') : '');
  }

  async function prepare(event: React.FormEvent) {
    event.preventDefault(); if (!document || !mapping) return;
    const opening = manualOpening.trim() ? parseEuros(manualOpening) : undefined;
    if (firstImport && mapping.balance < 0 && opening == null) { setError('Introduce el saldo al comenzar el día de inicio. El archivo no incluye saldos.'); return; }
    setBusy(true); setError('');
    try {
      const result = await api<{ plan: ImportPlanInfo }>('/api/imports/plan', { method: 'POST', body: JSON.stringify({
        token: document.token, mapping, accountId: accountId === 'new' ? null : accountId,
        ...(accountId === 'new' ? { newAccount: { name: newName, bank: newBank, type: newType, owner: newOwner, lastFour: document.lastFour } } : {}),
        startDate, ...(opening != null ? { manualOpeningCents: opening } : {}),
      }) });
      setPlan(result.plan); setConfirmOpening(false); setStep(3);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function commit() {
    if (!plan) return; setBusy(true); setError('');
    try { onImported(await api<ImportResult>('/api/imports/commit', { method: 'POST', body: JSON.stringify({ planId: plan.id, confirmOpening }) })); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return <dialog ref={dialogRef} className="account-dialog import-dialog" aria-labelledby="import-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-header"><div><span className="eyebrow">DEL EXTRACTO A TUS FINANZAS</span><h2 id="import-title">Importar movimientos</h2></div><button className="icon-button" aria-label="Cerrar importación" disabled={busy} onClick={onClose}><X size={21}/></button></div>
    <ol className="import-steps">{['Selecciona el archivo', 'Cuenta y fecha inicial', 'Revisa y confirma'].map((title, i) => <li key={title} className={step === i + 1 ? 'current' : step > i + 1 ? 'complete' : ''}><span>{step > i + 1 ? <Check size={12}/> : i + 1}</span>{title}</li>)}</ol>

    {step === 1 && <form onSubmit={upload}><p className="dialog-description">Sube el extracto descargado de tu banco. Reconocemos los formatos de ING, Openbank, Sabadell y MyInvestor; también puedes ajustar las columnas.</p><fieldset disabled={busy}><label className="file-drop"><FileSpreadsheet size={34}/><strong>{file?.name || 'Elige tu extracto bancario'}</strong><span>XLS, XLSX o CSV · Hasta 5 MB · Una cuenta por archivo</span><input type="file" accept=".xls,.xlsx,.csv" required aria-label="Archivo de movimientos" onChange={event => { setFile(event.target.files?.[0] || null); setError(''); }}/></label><details className="mapping-details"><summary>Opciones del archivo</summary><label>Fila de cabecera <span className="optional">Automática si se deja vacía</span><input type="number" min={1} max={100} value={headerRow} onChange={e => setHeaderRow(e.target.value)} placeholder="Ej. 4"/></label></details></fieldset><p className="privacy-note"><ShieldCheck size={14}/> El archivo se procesa en tu ordenador. No se envía al banco ni a terceros.</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-footer"><button className="button secondary" type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy || !file}>{busy ? <LoaderCircle size={16} className="spin"/> : <ArrowRight size={16}/>} Leer archivo</button></div></form>}

    {step === 2 && document && mapping && <form onSubmit={prepare}>
      <div className="file-summary"><FileSpreadsheet size={22}/><div><strong>{document.filename}</strong><span>{document.detectedBank || 'Formato configurable'} · {document.rowCount} movimientos{document.lastFour ? ` · Cuenta •• ${document.lastFour}` : ''}{document.firstDate ? ` · ${document.firstDate} a ${document.lastDate}` : ''}</span></div><Check size={17}/></div>
      <fieldset disabled={busy}><label>Importar en la cuenta<select value={accountId} onChange={e => chooseAccount(e.target.value)}><option value="new">Crear una cuenta con este extracto</option>{accounts.filter(account => !account.archived && account.type !== 'deposit' && (!document.detectedBank || account.bank === document.detectedBank)).map(account => <option key={account.id} value={account.id}>{account.name}{account.lastFour ? ` · •• ${account.lastFour}` : ''}</option>)}</select></label>
      {accountId === 'new' && <div className="new-account-fields"><div className="form-grid"><label>Nombre de la nueva cuenta<input required maxLength={80} value={newName} onChange={e => setNewName(e.target.value)}/></label><label>Banco<select value={newBank} disabled={Boolean(document.detectedBank)} onChange={e => setNewBank(e.target.value as Account['bank'])}>{banks.filter(bank => bank !== 'Efectivo').map(bank => <option key={bank}>{bank}</option>)}</select></label></div><div className="form-grid"><label>Tipo de cuenta<select value={newType} onChange={e => setNewType(e.target.value as Account['type'])}>{Object.entries(accountTypes).filter(([key]) => key !== 'deposit').map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label><label>Titular<input maxLength={80} value={newOwner} onChange={e => setNewOwner(e.target.value)}/></label></div></div>}
      <div className="opening-block"><h3>¿Desde qué día empieza tu presupuesto?</h3><div className="form-grid"><label>Fecha de inicio<input type="date" required value={startDate} disabled={!firstImport} min={firstImport ? document.firstDate || '1900-01-01' : '1900-01-01'} max={document.lastDate || '2200-12-31'} onInput={e => chooseStartDate(e.currentTarget.value)} onChange={e => chooseStartDate(e.target.value)}/></label>{firstImport && mapping.balance < 0 ? <label>Saldo al comenzar ese día (€)<input required inputMode="decimal" placeholder="0,00" value={manualOpening} onChange={e => setManualOpening(e.target.value)}/></label> : <div className="opening-explanation">{firstImport ? <><Check size={16}/><span>Calcularemos el saldo al empezar el día que elijas, usando los saldos del extracto.</span></> : <><ShieldCheck size={16}/><span>Se conserva la fecha y el saldo inicial de esta cuenta.</span></>}</div>}</div>
      {firstImport && <><p>Puedes elegir un día más reciente que el primer movimiento del archivo. {selectedAccount && startDate === selectedAccount.openingDate ? 'Se ha respetado la fecha que ya habías indicado en la cuenta.' : 'La fecha más antigua del archivo no determina el inicio de tu presupuesto.'}</p><div className="start-date-options">{selectedAccount && (!document.firstDate || selectedAccount.openingDate >= document.firstDate) && (!document.lastDate || selectedAccount.openingDate <= document.lastDate) && <button className="text-button" type="button" onClick={() => chooseStartDate(selectedAccount.openingDate)}>Usar fecha de la cuenta · {selectedAccount.openingDate}</button>}{document.lastDate && `${document.lastDate.slice(0, 7)}-01` >= document.firstDate && <button className="text-button" type="button" onClick={() => chooseStartDate(`${document.lastDate.slice(0, 7)}-01`)}>Inicio del mes más reciente · {document.lastDate.slice(0, 7)}-01</button>}</div></>}
      <p>Solo se importan los movimientos de ese día y posteriores para asignarlos después al presupuesto. Los anteriores quedan fuera; su efecto ya está recogido en el saldo de apertura. {firstImport ? 'Revisarás la fecha, el saldo y los movimientos excluidos antes de guardar.' : 'Los movimientos ya importados se omiten aunque el archivo solape fechas.'}</p></div>
      <details className="mapping-details" open={!document.detectedBank}><summary>Revisar columnas del archivo</summary><p>El importe debe llevar signo: negativo para salidas y positivo para entradas. Los valores de texto usan formato español.</p><div className="form-grid">{Object.entries(mappingLabels).map(([key, title]) => <label key={key}>{title}<select value={mapping[key as keyof ColumnMapping]} onChange={e => setMapping(old => ({ ...old!, [key]: Number(e.target.value) }))}><option value={-1}>Sin columna</option>{document.headers.map((header, i) => <option value={i} key={i}>{i + 1}. {header}</option>)}</select></label>)}</div></details></fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-footer"><button className="button secondary" type="button" disabled={busy} onClick={() => { setStep(1); setError(''); }}><ArrowLeft size={15}/> Atrás</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin"/> : <ArrowRight size={16}/>} Calcular vista previa</button></div>
    </form>}

    {step === 3 && plan && <div>
      <div className="review-heading"><h3>{plan.accountName}</h3><p>Desde el {plan.startDate} · Último movimiento: {plan.lastDate}</p></div>
      <div className="import-metrics"><div><span>Por importar</span><strong>{plan.newCount}</strong></div><div><span>Ya registrados</span><strong>{plan.duplicateCount}</strong></div><div><span>Anteriores al inicio</span><strong>{plan.excludedCount}</strong></div></div>
      <div className="balance-reconciliation"><div><span>{plan.firstImport ? `Saldo al comenzar el ${plan.startDate}` : 'Saldo registrado antes de esta carga'}</span><strong>{formatEuros(plan.firstImport ? plan.openingBalanceCents : plan.resultingBalanceCents - plan.newNetCents)}</strong></div><div><span>Variación de los movimientos nuevos</span><strong>{formatEuros(plan.newNetCents)}</strong></div><div className="result"><span>Saldo registrado tras importar</span><strong>{formatEuros(plan.resultingBalanceCents)}</strong></div>{plan.statementClosingCents !== null && <div><span>Saldo del extracto al {plan.lastDate}</span><strong>{formatEuros(plan.statementClosingCents)}</strong></div>}</div>
      <p className={`reconcile-status ${plan.reconciliation === 'differs' ? 'mismatch' : ''}`}><ShieldCheck size={16}/>{plan.reconciliation === 'matches' ? 'El saldo calculado coincide con el extracto.' : plan.reconciliation === 'historical' ? 'El saldo cuadra hasta la última fecha del archivo. La cuenta tiene movimientos posteriores.' : plan.reconciliation === 'differs' ? `Diferencia con el extracto: ${formatEuros(plan.differenceCents!)}. Revisa el periodo antes de importar.` : 'El archivo no incluye saldos: la apertura se toma del importe que has indicado.'}</p>
      {plan.warnings.map(warning => <p className="import-warning" key={warning}>{warning}</p>)}
      <label className="review-duplicates"><input type="checkbox" checked={reviewDuplicates} onChange={e => setReviewDuplicates(e.target.checked)}/> Mostrar también los movimientos ya registrados</label>
      <div className="preview-table table-scroll"><table><thead><tr><th>FECHA</th><th>DESCRIPCIÓN</th><th className="align-right">IMPORTE</th><th>ESTADO</th></tr></thead><tbody>{plan.rows.filter(row => reviewDuplicates || !row.duplicate).map(row => <tr key={row.fingerprint} className={row.duplicate ? 'duplicate-row' : ''}><td>{row.date}</td><td className="description-cell">{row.description}{row.category && <small>{row.category}{row.subcategory ? ` / ${row.subcategory}` : ''}</small>}</td><td className={`align-right ${row.amountCents < 0 ? 'negative' : 'positive'}`}>{formatEuros(row.amountCents)}</td><td><span className={`import-status ${row.duplicate ? 'existing' : ''}`}>{row.duplicate ? 'Ya registrado' : 'Nuevo'}</span></td></tr>)}</tbody></table>{plan.newCount === 0 && !reviewDuplicates && <p className="no-new-movements">Todos los movimientos de este periodo ya están registrados. No se duplicará ninguno.</p>}</div>
      {plan.firstImport && <label className="confirm-opening"><input type="checkbox" checked={confirmOpening} onChange={e => setConfirmOpening(e.target.checked)}/><span>Confirmo el inicio el <strong>{plan.startDate}</strong> y un saldo de <strong>{formatEuros(plan.openingBalanceCents)}</strong> al comenzar ese día.{plan.accountId ? ' Sustituirá el saldo inicial anterior.' : ''}</span></label>}
      {error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-footer"><button className="button secondary" disabled={busy} onClick={() => { setStep(2); setError(''); }}><ArrowLeft size={15}/> Ajustar</button><button className="button primary" disabled={busy || (plan.firstImport && !confirmOpening) || (plan.reconciliation === 'differs' && plan.newCount > 0)} onClick={() => void commit()}>{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>} {plan.newCount === 0 ? 'Finalizar sin duplicar' : `Importar ${plan.newCount} movimientos`}</button></div>
    </div>}
  </dialog>;
}
