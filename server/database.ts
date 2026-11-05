import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { accountInputSchema, type Account, type AccountInput } from '../shared/accounts.js';

export class AccountError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

type Row = Record<string, unknown>;

export class AccountStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, bank TEXT NOT NULL, type TEXT NOT NULL,
        owner TEXT NOT NULL, last_four TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR',
        archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        kind TEXT NOT NULL CHECK (kind IN ('opening_balance', 'movement')),
        date TEXT NOT NULL, amount_cents INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_opening_per_account ON entries(account_id) WHERE kind = 'opening_balance';
      CREATE TABLE IF NOT EXISTS account_history (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        action TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS import_batches (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        filename TEXT NOT NULL, bank TEXT NOT NULL, file_digest TEXT NOT NULL,
        imported_at TEXT NOT NULL, row_count INTEGER NOT NULL, original_file BLOB NOT NULL,
        mapping_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS imported_movements (
        entry_id TEXT PRIMARY KEY REFERENCES entries(id), account_id TEXT NOT NULL REFERENCES accounts(id),
        batch_id TEXT NOT NULL REFERENCES import_batches(id), fingerprint TEXT NOT NULL,
        description TEXT NOT NULL, bank_category TEXT NOT NULL, bank_subcategory TEXT NOT NULL,
        comment TEXT NOT NULL, source_balance_cents INTEGER, source_row INTEGER NOT NULL, value_date TEXT,
        UNIQUE(account_id, fingerprint)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS account_sources (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id), identity TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS entries_account_date ON entries(account_id, date);
      CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS budget_lines (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','expense','saving','funding')),
        group_name TEXT NOT NULL, note TEXT NOT NULL, position INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE IF NOT EXISTS budget_periods (period TEXT PRIMARY KEY, source_out_cents INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS budget_cells (
        line_id TEXT NOT NULL REFERENCES budget_lines(id), period TEXT NOT NULL REFERENCES budget_periods(period),
        original_cents INTEGER, planned_cents INTEGER, version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(line_id, period)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS budget_allocations (
        entry_id TEXT PRIMARY KEY REFERENCES entries(id), line_id TEXT REFERENCES budget_lines(id),
        excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)), version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL, CHECK(excluded = 0 OR line_id IS NULL)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS budget_history (
        id TEXT PRIMARY KEY, line_id TEXT REFERENCES budget_lines(id), period TEXT,
        before_cents INTEGER, after_cents INTEGER, action TEXT NOT NULL,
        detail_json TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS budget_closings (
        period TEXT PRIMARY KEY, next_period TEXT NOT NULL, closed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS budget_carryovers (
        line_id TEXT NOT NULL REFERENCES budget_lines(id), target_period TEXT NOT NULL,
        source_period TEXT, amount_cents INTEGER NOT NULL, PRIMARY KEY(line_id,target_period)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS card_payments (
        card_entry_id TEXT PRIMARY KEY REFERENCES entries(id), source_entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id)
      ) STRICT;
    `);
    const columns = this.db.prepare('PRAGMA table_info(accounts)').all();
    if (!columns.some(column => column.name === 'interest_rate')) this.db.exec('ALTER TABLE accounts ADD COLUMN interest_rate REAL');
    if (!columns.some(column => column.name === 'maturity_date')) this.db.exec('ALTER TABLE accounts ADD COLUMN maturity_date TEXT');
    this.db.exec('PRAGMA user_version = 5');
  }

  private select = `SELECT a.*, o.date AS opening_date, o.amount_cents AS opening_balance_cents,
    (SELECT COUNT(*) FROM entries m WHERE m.account_id = a.id AND m.kind = 'movement') AS movement_count,
    (SELECT COALESCE(SUM(e.amount_cents), 0) FROM entries e WHERE e.account_id = a.id) AS balance_cents
    FROM accounts a JOIN entries o ON o.account_id = a.id AND o.kind = 'opening_balance'`;

  private map(row: Row): Account {
    return {
      id: String(row.id), name: String(row.name), bank: row.bank as Account['bank'],
      type: row.type as Account['type'], owner: String(row.owner), lastFour: String(row.last_four),
      currency: 'EUR', archived: Boolean(row.archived), version: Number(row.version),
      openingDate: String(row.opening_date), openingBalanceCents: Number(row.opening_balance_cents),
      balanceCents: Number(row.balance_cents), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      movementCount: Number(row.movement_count),
      ...(row.interest_rate == null ? {} : { interestRate: Number(row.interest_rate) }),
      ...(row.maturity_date == null ? {} : { maturityDate: String(row.maturity_date) }),
    };
  }

  list(): Account[] {
    return this.db.prepare(`${this.select} ORDER BY a.archived, a.created_at, a.id`).all().map(row => this.map(row));
  }

  get(id: string): Account {
    const row = this.db.prepare(`${this.select} WHERE a.id = ?`).get(id);
    if (!row) throw new AccountError(404, 'No se ha encontrado la cuenta.');
    return this.map(row);
  }

  transaction<T>(work: () => T): T {
    const savepoint = `tx_${randomUUID().replace(/-/g, '')}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try { const result = work(); this.db.exec(`RELEASE ${savepoint}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }

  assertBudgetOpen(period: string) {
    if (this.db.prepare('SELECT 1 FROM budget_closings WHERE period=?').get(period)) {
      throw new AccountError(409, `El mes ${period} está cerrado. Deshaz su cierre antes de modificarlo.`);
    }
  }

  history(account: Account, action: string) {
    this.db.prepare('INSERT INTO account_history VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), account.id, action, JSON.stringify(account), new Date().toISOString());
  }

  create(input: AccountInput): Account {
    input = accountInputSchema.parse(input);
    return this.transaction(() => {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO accounts (id, name, bank, type, owner, last_four, created_at, updated_at, interest_rate, maturity_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.bank, input.type, input.owner, input.lastFour, now, now, input.interestRate ?? null, input.maturityDate ?? null);
      this.db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), id, 'opening_balance', input.openingDate, input.openingBalanceCents);
      const account = this.get(id);
      this.history(account, 'created');
      return account;
    });
  }

  update(id: string, input: AccountInput, expectedVersion: number): Account {
    input = accountInputSchema.parse(input);
    return this.transaction(() => {
      const existing = this.get(id);
      if (existing.version !== expectedVersion) throw new AccountError(409, 'Esta cuenta ha cambiado en otra pestaña. Cierra el formulario y recarga antes de editar.');
      if (existing.archived) throw new AccountError(409, 'Reactiva la cuenta antes de editarla.');
      const hasMovements = this.db.prepare("SELECT 1 FROM entries WHERE account_id = ? AND kind = 'movement' LIMIT 1").get(id);
      if (hasMovements && (existing.openingBalanceCents !== input.openingBalanceCents || existing.openingDate !== input.openingDate)) {
        throw new AccountError(409, 'La cuenta ya tiene movimientos. El saldo inicial requiere una conciliación.');
      }
      this.db.prepare(`UPDATE accounts SET name = ?, bank = ?, type = ?, owner = ?, last_four = ?,
        interest_rate = ?, maturity_date = ?, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(input.name, input.bank, input.type, input.owner, input.lastFour, input.interestRate ?? null, input.maturityDate ?? null, new Date().toISOString(), id);
      this.db.prepare("UPDATE entries SET date = ?, amount_cents = ? WHERE account_id = ? AND kind = 'opening_balance'")
        .run(input.openingDate, input.openingBalanceCents, id);
      const account = this.get(id);
      this.history(account, 'updated');
      return account;
    });
  }

  setArchived(id: string, archived: boolean, expectedVersion: number): Account {
    return this.transaction(() => {
      const existing = this.get(id);
      if (existing.version !== expectedVersion) throw new AccountError(409, 'La cuenta ha cambiado. Recarga para ver su estado actual.');
      this.db.prepare('UPDATE accounts SET archived = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(archived ? 1 : 0, new Date().toISOString(), id);
      const account = this.get(id);
      this.history(account, archived ? 'archived' : 'restored');
      return account;
    });
  }

  /** Vencimiento de un depósito: su capital sale como traspaso interno (para casar con el abono en la cuenta) y se archiva. */
  matureDeposit(id: string, date: string, expectedVersion: number): Account {
    return this.transaction(() => {
      const existing = this.get(id);
      if (existing.version !== expectedVersion) throw new AccountError(409, 'La cuenta ha cambiado. Recarga para ver su estado actual.');
      if (existing.type !== 'deposit') throw new AccountError(400, 'Solo los depósitos tienen vencimiento.');
      if (existing.archived) throw new AccountError(409, 'Este depósito ya está archivado.');
      if (date <= existing.openingDate) throw new AccountError(400, 'El vencimiento debe ser posterior a la apertura del depósito.');
      if (existing.balanceCents <= 0) throw new AccountError(400, 'El depósito no tiene capital que devolver.');
      this.assertBudgetOpen(date.slice(0, 7));
      const entryId = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO entries VALUES (?, ?, 'movement', ?, ?)").run(entryId, id, date, -existing.balanceCents);
      this.db.prepare('INSERT INTO budget_allocations VALUES (?, NULL, 1, 1, ?)').run(entryId, now);
      this.db.prepare('UPDATE accounts SET archived = 1, version = version + 1, updated_at = ? WHERE id = ?').run(now, id);
      const account = this.get(id);
      this.history(account, 'matured');
      return account;
    });
  }

  /** Elimina una cuenta y todo lo importado en ella. Solo si ninguno de sus movimientos está clasificado en el presupuesto. */
  deleteAccount(id: string, expectedVersion: number) {
    return this.transaction(() => {
      const existing = this.get(id);
      if (existing.version !== expectedVersion) throw new AccountError(409, 'La cuenta ha cambiado. Recarga para ver su estado actual.');
      if (this.db.prepare('SELECT 1 FROM budget_allocations b JOIN entries e ON e.id=b.entry_id WHERE e.account_id=? LIMIT 1').get(id)) {
        throw new AccountError(409, 'Esta cuenta tiene movimientos clasificados en el presupuesto. Archívala en lugar de eliminarla.');
      }
      this.db.prepare('DELETE FROM card_payments WHERE card_entry_id IN (SELECT id FROM entries WHERE account_id=?) OR source_entry_id IN (SELECT id FROM entries WHERE account_id=?)').run(id, id);
      this.db.prepare('DELETE FROM imported_movements WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM import_batches WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM account_sources WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM entries WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM account_history WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id=?').run(id);
      return { deleted: id };
    });
  }

  /** Cargos de tarjeta que se pueden registrar como pago: salidas de otras cuentas, posteriores al inicio de la tarjeta y sin partida. */
  cardPaymentCandidates(cardId: string) {
    const card = this.get(cardId);
    if (card.type !== 'credit_card') throw new AccountError(400, 'Solo las tarjetas de crédito tienen cargos.');
    return this.db.prepare(`SELECT e.id,e.date,e.amount_cents,a.name AS account_name,m.description FROM entries e
      JOIN accounts a ON a.id=e.account_id JOIN imported_movements m ON m.entry_id=e.id
      LEFT JOIN budget_allocations b ON b.entry_id=e.id
      WHERE e.kind='movement' AND e.account_id<>? AND e.amount_cents<0 AND e.date>? AND a.type<>'credit_card'
      AND (b.entry_id IS NULL OR b.line_id IS NULL) AND NOT EXISTS (SELECT 1 FROM card_payments p WHERE p.source_entry_id=e.id)
      AND lower(m.description) LIKE '%tarjeta%' ORDER BY e.date DESC LIMIT 20`).all(cardId, card.openingDate).map(row => ({
        id: String(row.id), date: String(row.date), amountCents: Number(row.amount_cents), accountName: String(row.account_name), description: String(row.description),
      }));
  }

  /** El cargo mensual en la cuenta paga la tarjeta: entra en la tarjeta y ambos lados quedan como traspaso interno. */
  registerCardPayment(cardId: string, sourceEntryId: string, expectedVersion: number): Account {
    return this.transaction(() => {
      const card = this.get(cardId);
      if (card.version !== expectedVersion) throw new AccountError(409, 'La tarjeta ha cambiado. Recarga para ver su estado actual.');
      if (!this.cardPaymentCandidates(cardId).some(row => row.id === sourceEntryId)) throw new AccountError(400, 'Ese cargo no se puede usar para pagar esta tarjeta (ya está usado, tiene partida o es anterior a la tarjeta).');
      const source = this.db.prepare('SELECT date, amount_cents FROM entries WHERE id=?').get(sourceEntryId)!;
      this.assertBudgetOpen(String(source.date).slice(0, 7));
      const entryId = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO entries VALUES (?, ?, 'movement', ?, ?)").run(entryId, cardId, String(source.date), -Number(source.amount_cents));
      this.db.prepare('INSERT INTO card_payments VALUES (?, ?)').run(entryId, sourceEntryId);
      this.db.prepare('INSERT INTO budget_allocations VALUES (?, NULL, 1, 1, ?)').run(entryId, now);
      this.db.prepare(`INSERT INTO budget_allocations VALUES (?, NULL, 1, 1, ?) ON CONFLICT(entry_id) DO UPDATE SET line_id=NULL, excluded=1, version=budget_allocations.version+1, updated_at=excluded.updated_at`).run(sourceEntryId, now);
      this.db.prepare('UPDATE accounts SET version = version + 1, updated_at = ? WHERE id = ?').run(now, cardId);
      const account = this.get(cardId);
      this.history(account, 'card_payment');
      return account;
    });
  }

  close() { this.db.close(); }
}
