import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatEuros, type Account } from '../shared/accounts';
import type { TransferReconciliation } from '../shared/reconciliation';

export function AccountReconciliation({ accounts, data, onImport, onMovements }: {
  accounts: Account[]; data: TransferReconciliation; onImport: () => void; onMovements: () => void;
}) {
  const negative = accounts.filter(account => !account.archived && account.type !== 'credit_card' && account.balanceCents < 0);
  const warning = negative.length > 0 || data.unmatched.length > 0;
  return <section className={`account-reconciliation ${warning ? 'warning' : 'balanced'}`} aria-label="Comprobación de cuentas" role="status">
    <div className="reconciliation-title">{warning ? <AlertTriangle size={20}/> : <CheckCircle2 size={20}/>}<h2>{warning ? 'Revisa tus cuentas: pueden faltar movimientos' : data.count ? 'Los traspasos internos tienen contrapartida' : 'Comprobación de cuentas'}</h2></div>
    {negative.map(account => <p key={account.id}><strong>{account.name}: {formatEuros(account.balanceCents)}</strong>. El saldo registrado es negativo. Revisa si faltan entradas, extractos o saldo inicial.</p>)}
    {data.count > 0 ? <p>{data.matchedPairs} traspasos con entrada y salida · {data.unmatched.length} movimientos sin contrapartida localizada. Neto de traspasos internos: <strong>{formatEuros(data.netCents)}</strong> (debería ser 0 € con ambos lados registrados).</p> : <p>Todavía no hay movimientos marcados como traspasos internos para comprobar.</p>}
    {data.unmatched.length > 0 && <details><summary>Ver posibles contrapartidas pendientes</summary><ul>{data.unmatched.map(row => <li key={row.id}>{row.date} · {row.accountName} · <strong>{formatEuros(row.amountCents)}</strong></li>)}</ul></details>}
    <p className="reconciliation-help">Se comparan traspasos marcados, del mismo importe y signo contrario, en cuentas distintas y con hasta 7 días de diferencia. Una contrapartida puede estar pendiente de importar o de clasificar; también puede quedar fuera de las fechas cargadas. Esta comprobación no confirma el saldo del banco.</p>
    {warning && <div className="reconciliation-actions"><button className="button secondary" onClick={onImport}>Importar movimientos pendientes</button><button className="text-button" onClick={onMovements}>Revisar movimientos →</button></div>}
  </section>;
}
