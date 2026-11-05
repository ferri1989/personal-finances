import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Account, AccountInput } from '../shared/accounts.js';

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
      PRAGMA user_version = 3;
    `);
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

  history(account: Account, action: string) {
    this.db.prepare('INSERT INTO account_history VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), account.id, action, JSON.stringify(account), new Date().toISOString());
  }

  create(input: AccountInput): Account {
    return this.transaction(() => {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO accounts (id, name, bank, type, owner, last_four, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.bank, input.type, input.owner, input.lastFour, now, now);
      this.db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), id, 'opening_balance', input.openingDate, input.openingBalanceCents);
      const account = this.get(id);
      this.history(account, 'created');
      return account;
    });
  }

  update(id: string, input: AccountInput, expectedVersion: number): Account {
    return this.transaction(() => {
      const existing = this.get(id);
      if (existing.version !== expectedVersion) throw new AccountError(409, 'Esta cuenta ha cambiado en otra pestaña. Cierra el formulario y recarga antes de editar.');
      if (existing.archived) throw new AccountError(409, 'Reactiva la cuenta antes de editarla.');
      const hasMovements = this.db.prepare("SELECT 1 FROM entries WHERE account_id = ? AND kind = 'movement' LIMIT 1").get(id);
      if (hasMovements && (existing.openingBalanceCents !== input.openingBalanceCents || existing.openingDate !== input.openingDate)) {
        throw new AccountError(409, 'La cuenta ya tiene movimientos. El saldo inicial requiere una conciliación.');
      }
      this.db.prepare(`UPDATE accounts SET name = ?, bank = ?, type = ?, owner = ?, last_four = ?,
        version = version + 1, updated_at = ? WHERE id = ?`)
        .run(input.name, input.bank, input.type, input.owner, input.lastFour, new Date().toISOString(), id);
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

  close() { this.db.close(); }
}
