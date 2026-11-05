import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accountFieldsSchema, validDate, type Account, type AccountInput } from '../shared/accounts.js';
import type { ColumnMapping, ImportBatch, ImportPlanInfo, ImportResult, Movement, ParsedMovement } from '../shared/imports.js';
import { AccountError, AccountStore } from './database.js';
import { parseMovements, readDocument, type ImportDocument } from './importers.js';

const index = z.number().int().min(-1).max(99);
export const mappingSchema = z.object({ date: index, valueDate: index.default(-1), description: index, amount: index, balance: index, category: index, subcategory: index, comment: index }).strict();
export const planSchema = z.object({
  token: z.uuid(), mapping: mappingSchema, accountId: z.uuid().nullable(),
  newAccount: accountFieldsSchema.omit({ openingDate: true, openingBalanceCents: true, interestRate: true, maturityDate: true }).extend({ type: z.enum(['current', 'savings', 'investment_cash', 'cash', 'credit_card']) }).optional(),
  startDate: z.string().refine(validDate, 'Selecciona una fecha inicial válida.'),
  manualOpeningCents: z.number().int().min(-1e12).max(1e12).optional(),
}).strict();
type PlanRequest = z.infer<typeof planSchema>;
type SavedPlan = { info: ImportPlanInfo; document: ImportDocument; request: PlanRequest; accountVersion: number | null; createdAt: number };

export class ImportService {
  private documents = new Map<string, { document: ImportDocument; createdAt: number }>();
  private plans = new Map<string, SavedPlan>();
  constructor(private store: AccountStore) {}

  private prune() {
    for (const cache of [this.documents, this.plans]) for (const [id, value] of cache) if (Date.now() - value.createdAt > 30 * 60 * 1000) cache.delete(id);
  }

  preview(buffer: Buffer, filename: string, headerRow?: number) {
    this.prune();
    const document = readDocument(buffer, filename, headerRow);
    if (this.documents.size >= 10) this.documents.delete(this.documents.keys().next().value!);
    this.documents.set(document.info.token, { document, createdAt: Date.now() });
    return document.info;
  }

  private countMovements(id: string) { return Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE account_id = ? AND kind = 'movement'").get(id)?.n ?? 0); }

  private validateAccount(account: Account, document: ImportDocument) {
    if (account.type === 'deposit') throw new AccountError(400, 'Los depósitos se registran desde Cuentas, sin importar movimientos.');
    if (account.archived) throw new AccountError(400, 'Reactiva la cuenta antes de importar movimientos.');
    if (Boolean(document.info.creditCard) !== (account.type === 'credit_card')) throw new AccountError(400, document.info.creditCard ? 'Este extracto es de una tarjeta de crédito. Impórtalo en una cuenta de tipo «Tarjeta de crédito».' : 'Esta cuenta es una tarjeta de crédito. Selecciona la cuenta del extracto.');
    if (document.info.detectedBank && account.bank !== document.info.detectedBank) throw new AccountError(400, `El extracto debe importarse en una cuenta de ${document.info.detectedBank}.`);
    if (document.info.lastFour && account.lastFour && document.info.lastFour !== account.lastFour) throw new AccountError(400, 'Los cuatro últimos dígitos del extracto no coinciden con la cuenta seleccionada.');
    const source = this.store.db.prepare('SELECT identity FROM account_sources WHERE account_id = ?').get(account.id);
    if (source && document.identity && source.identity !== document.identity) throw new AccountError(400, 'Este extracto pertenece a otra cuenta bancaria. Selecciona o crea su cuenta correspondiente.');
    const otherAccount = document.identity ? this.store.db.prepare('SELECT account_id FROM account_sources WHERE identity = ? AND account_id <> ?').get(document.identity, account.id) : null;
    if (otherAccount) throw new AccountError(400, 'Este extracto ya está asociado a otra cuenta registrada. Selecciona esa cuenta para evitar duplicados.');
  }

  prepare(input: PlanRequest): ImportPlanInfo {
    this.prune();
    const cached = this.documents.get(input.token);
    if (!cached) throw new AccountError(410, 'La vista previa ha caducado. Vuelve a seleccionar el archivo.');
    const document = cached.document;
    const { rows, hasBalances } = parseMovements(document, input.mapping);
    const account = input.accountId ? this.store.get(input.accountId) : null;
    if (account) this.validateAccount(account, document);
    else {
      if (!input.newAccount) throw new AccountError(400, 'Introduce los datos de la nueva cuenta.');
      if (Boolean(document.info.creditCard) !== (input.newAccount.type === 'credit_card')) throw new AccountError(400, document.info.creditCard ? 'Este extracto es de una tarjeta de crédito: elige el tipo «Tarjeta de crédito».' : 'Solo los extractos de tarjeta pueden crear una tarjeta de crédito.');
      if (document.info.detectedBank && input.newAccount.bank !== document.info.detectedBank) throw new AccountError(400, `Selecciona ${document.info.detectedBank} como banco para este extracto.`);
      if (document.info.lastFour && input.newAccount.lastFour && document.info.lastFour !== input.newAccount.lastFour) throw new AccountError(400, 'Los últimos dígitos no coinciden con el extracto.');
      if (document.identity && this.store.db.prepare('SELECT 1 FROM account_sources WHERE identity = ?').get(document.identity)) throw new AccountError(400, 'Ya existe una cuenta asociada a este extracto. Selecciónala en lugar de crear otra.');
    }
    const firstImport = !account || this.countMovements(account.id) === 0;
    // Adelantar el inicio de una cuenta existente: solo si el extracto lleva saldos y cuadra con el saldo inicial actual.
    const extendStart = !firstImport && input.startDate < account!.openingDate;
    if (!firstImport && !extendStart && input.startDate !== account!.openingDate) throw new AccountError(400, 'La fecha de inicio ya está fijada para esta cuenta. Solo puedes adelantarla a una fecha anterior.');
    if (extendStart && !hasBalances) throw new AccountError(400, 'Para adelantar la fecha de inicio el extracto debe incluir saldos.');
    if (extendStart && input.startDate < rows[0].date) throw new AccountError(400, `Este extracto empieza el ${rows[0].date}. Para empezar antes necesitas un extracto anterior.`);
    if (firstImport && (input.startDate < rows[0].date || input.startDate > rows.at(-1)!.date)) throw new AccountError(400, `Elige una fecha entre ${rows[0].date} y ${rows.at(-1)!.date}. Para empezar antes necesitas un extracto anterior.`);
    const selected = rows.filter(row => row.date >= input.startDate);
    if (!selected.length) throw new AccountError(400, 'No hay movimientos a partir de la fecha de inicio.');
    const opening = firstImport || extendStart ? hasBalances ? selected[0].balanceAfterCents! - selected[0].amountCents : input.manualOpeningCents : account!.openingBalanceCents;
    const earlierNet = extendStart ? selected.filter(row => row.date < account!.openingDate).reduce((sum, row) => sum + row.amountCents, 0) : 0;
    if (extendStart && opening! + earlierNet !== account!.openingBalanceCents) throw new AccountError(409, `El extracto no cuadra con el saldo inicial actual (${(account!.openingBalanceCents / 100).toFixed(2)} € el ${account!.openingDate}). No se puede adelantar la fecha con este archivo.`);
    if (opening === undefined) throw new AccountError(400, 'Este archivo no tiene saldos. Introduce el saldo al comenzar el día de inicio.');
    const fingerprints = account ? new Set(this.store.db.prepare('SELECT fingerprint FROM imported_movements WHERE account_id = ?').all(account.id).map(row => String(row.fingerprint))) : new Set<string>();
    const planned = selected.map(row => ({ ...row, duplicate: fingerprints.has(row.fingerprint) }));
    const fresh = planned.filter(row => !row.duplicate);
    const net = fresh.reduce((sum, row) => sum + row.amountCents, 0);
    const resulting = (firstImport ? opening : extendStart ? account!.balanceCents - account!.openingBalanceCents + opening! : account!.balanceCents) + net;
    const statementClosing = hasBalances ? selected.at(-1)!.balanceAfterCents : null;
    const lastDate = selected.at(-1)!.date;
    const latestExisting = account ? String(this.store.db.prepare("SELECT MAX(date) AS date FROM entries WHERE account_id = ? AND kind = 'movement'").get(account.id)?.date ?? '') : '';
    const existingAtEnd = account && !firstImport ? Number(this.store.db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM entries WHERE account_id = ? AND date <= ?').get(account.id, lastDate)?.balance ?? 0) - (extendStart ? account.openingBalanceCents - opening! : 0) : opening;
    const difference = statementClosing === null ? null : existingAtEnd + net - statementClosing;
    const reconciliation: ImportPlanInfo['reconciliation'] = statementClosing === null ? 'unavailable' : difference !== 0 ? 'differs' : latestExisting > lastDate ? 'historical' : 'matches';
    const warnings: string[] = [];
    if (firstImport && account) warnings.push('La primera importación sustituirá la fecha y el saldo iniciales de esta cuenta.');
    if (extendStart) warnings.push(`La cuenta empezará el ${input.startDate} en lugar del ${account!.openingDate}. El saldo actual no cambia: los movimientos añadidos ya estaban dentro del saldo inicial.`);
    if (!hasBalances) warnings.push('Sin una columna de saldo no podemos conciliar el resultado. Los posibles duplicados se reconocen por fecha, descripción e importe; revisa los cargos iguales del mismo día.');
    if (reconciliation === 'differs') warnings.push('El saldo calculado no coincide con el extracto. Importa un periodo completo o revisa el saldo inicial antes de continuar.');
    if (latestExisting > lastDate) warnings.push('Este extracto es anterior a movimientos ya registrados. Se contrasta el saldo hasta la última fecha del archivo.');
    const info: ImportPlanInfo = {
      id: randomUUID(), accountId: account?.id ?? null, accountName: account?.name ?? input.newAccount!.name,
      firstImport, extendStart, startDate: input.startDate, openingBalanceCents: opening!,
      firstDate: selected[0].date, lastDate, excludedCount: rows.length - selected.length,
      duplicateCount: planned.length - fresh.length, newCount: fresh.length, newNetCents: net,
      resultingBalanceCents: resulting, statementClosingCents: statementClosing, reconciliation, differenceCents: difference,
      warnings, rows: planned,
    };
    if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(info.id, { info, document, request: input, accountVersion: account?.version ?? null, createdAt: Date.now() });
    return info;
  }

  commit(id: string, confirmOpening: boolean): ImportResult {
    this.prune();
    const saved = this.plans.get(id);
    if (!saved) throw new AccountError(410, 'La confirmación ha caducado o ya se ha utilizado. Vuelve a preparar la importación.');
    const { info, document, request } = saved;
    if ((info.firstImport || info.extendStart) && !confirmOpening) throw new AccountError(400, 'Confirma la fecha y el saldo de apertura antes de importar.');
    if (info.reconciliation === 'differs' && info.newCount > 0) throw new AccountError(409, 'El saldo no cuadra. No se ha guardado ningún movimiento. Revisa la vista previa.');
    const result = this.store.transaction(() => {
      let account = info.accountId ? this.store.get(info.accountId) : null;
      if (!account && document.identity && this.store.db.prepare('SELECT 1 FROM account_sources WHERE identity = ?').get(document.identity)) throw new AccountError(409, 'Esta cuenta bancaria se ha dado de alta desde otra importación. Selecciónala y vuelve a preparar la vista previa.');
      if (account && account.version !== saved.accountVersion) throw new AccountError(409, 'La cuenta ha cambiado desde la vista previa. Vuelve a calcularla antes de importar.');
      if (account) this.validateAccount(account, document);
      if (account && info.newCount === 0) return { account, imported: 0, duplicates: info.duplicateCount };
      const openingInput = { openingDate: info.startDate, openingBalanceCents: info.openingBalanceCents };
      if (!account) account = this.store.create({ ...request.newAccount!, ...openingInput, lastFour: document.info.lastFour || request.newAccount!.lastFour });
      else if (info.extendStart) {
        this.store.db.prepare("UPDATE entries SET date = ?, amount_cents = ? WHERE account_id = ? AND kind = 'opening_balance'").run(info.startDate, info.openingBalanceCents, account.id);
      }
      else if (info.firstImport) {
        const { id: _id, currency: _currency, balanceCents: _balance, archived: _archived, version: _version, createdAt: _created, updatedAt: _updated, movementCount: _count, ...fields } = account;
        account = this.store.update(account.id, { ...fields, ...openingInput, lastFour: fields.lastFour || document.info.lastFour }, account.version);
      }
      const batchId = randomUUID();
      const now = new Date().toISOString();
      this.store.db.prepare('INSERT INTO import_batches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(batchId, account.id, document.info.filename, account.bank, document.digest, now, info.newCount, document.original, JSON.stringify(request.mapping));
      if (document.identity) this.store.db.prepare('INSERT OR IGNORE INTO account_sources VALUES (?, ?)').run(account.id, document.identity);
      for (const row of info.rows.filter(row => !row.duplicate)) {
        this.store.assertBudgetOpen(row.date.slice(0,7));
        const entryId = randomUUID();
        this.store.db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?)').run(entryId, account.id, 'movement', row.date, row.amountCents);
        this.store.db.prepare(`INSERT INTO imported_movements (entry_id, account_id, batch_id, fingerprint, description,
          bank_category, bank_subcategory, comment, source_balance_cents, source_row, value_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(entryId, account.id, batchId, row.fingerprint, row.description, row.category, row.subcategory, row.comment, row.balanceAfterCents, row.sourceRow, row.valueDate);
      }
      this.store.db.prepare('UPDATE accounts SET version = version + 1, updated_at = ? WHERE id = ?').run(now, account.id);
      const imported = this.store.get(account.id);
      this.store.history(imported, 'movements_imported');
      return { account: imported, imported: info.newCount, duplicates: info.duplicateCount };
    });
    this.plans.delete(id);
    return result;
  }

  movements(): Movement[] {
    return this.store.db.prepare(`SELECT e.id, e.account_id, e.date, e.amount_cents, a.name, a.bank,
      m.description, m.bank_category, m.bank_subcategory, m.comment, m.source_balance_cents, m.value_date, b.filename, allocation.line_id, allocation.excluded, allocation.version AS assignment_version
      FROM imported_movements m JOIN entries e ON e.id = m.entry_id JOIN accounts a ON a.id = e.account_id
      JOIN import_batches b ON b.id = m.batch_id
      LEFT JOIN budget_allocations allocation ON allocation.entry_id = e.id ORDER BY e.date DESC, b.imported_at DESC, m.source_row ASC LIMIT 10000`).all().map(row => ({
        id: String(row.id), accountId: String(row.account_id), accountName: String(row.name), bank: String(row.bank),
        date: String(row.date), description: String(row.description), amountCents: Number(row.amount_cents),
        valueDate: row.value_date === null ? null : String(row.value_date),
        balanceAfterCents: row.source_balance_cents === null ? null : Number(row.source_balance_cents),
        category: String(row.bank_category), subcategory: String(row.bank_subcategory), comment: String(row.comment), filename: String(row.filename),
        lineId: row.line_id === null ? null : String(row.line_id), excluded: Boolean(row.excluded),
        assignmentVersion: row.assignment_version === null ? 0 : Number(row.assignment_version),
      }));
  }

  batches(): ImportBatch[] {
    return this.store.db.prepare(`SELECT b.*, a.name FROM import_batches b JOIN accounts a ON a.id = b.account_id ORDER BY b.imported_at DESC LIMIT 50`).all().map(row => ({
      id: String(row.id), accountId: String(row.account_id), accountName: String(row.name), filename: String(row.filename),
      bank: String(row.bank), importedAt: String(row.imported_at), rowCount: Number(row.row_count),
    }));
  }
}
