import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountStore } from '../server/database.js';
import { buildApp } from '../server/app.js';
import { accountInputSchema, parseEuros, validDate } from '../shared/accounts.js';

const input = { name: 'Cuenta principal', bank: 'ING' as const, type: 'current' as const, owner: 'Familia', lastFour: '1234', openingDate: '2026-11-03', openingBalanceCents: 123456 };
const deposit = { ...input, name: 'Depósito a plazo', type: 'deposit' as const, openingBalanceCents: 1000000, interestRate: 2.75, maturityDate: '2027-11-03' };

test('depósitos: alta y edición por API, validación y capital sin intereses futuros', async () => {
  const store = new AccountStore(':memory:');
  const app = await buildApp(store);
  const headers = { host: '127.0.0.1:4310' };
  try {
    for (const payload of [
      { ...deposit, interestRate: undefined }, { ...deposit, maturityDate: undefined },
      { ...deposit, interestRate: -1 }, { ...deposit, interestRate: 101 },
      { ...deposit, maturityDate: '2027-02-30' }, { ...deposit, maturityDate: deposit.openingDate },
      { ...deposit, maturityDate: '2025-01-01' }, { ...deposit, openingBalanceCents: 0 },
      { ...deposit, openingBalanceCents: -100 }, { ...deposit, type: 'current' },
    ]) assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', headers, payload })).statusCode, 400);
    const created = await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: deposit });
    assert.equal(created.statusCode, 201);
    const { account } = created.json();
    assert.equal(account.balanceCents, deposit.openingBalanceCents);
    assert.equal(account.interestRate, 2.75);
    assert.equal(account.maturityDate, deposit.maturityDate);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}`, headers, payload: { ...deposit, maturityDate: '2026-01-01', expectedVersion: account.version } })).statusCode, 400);
    const updated = await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}`, headers, payload: { ...deposit, interestRate: 0, maturityDate: '2028-01-01', expectedVersion: account.version } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().account.interestRate, 0);
    assert.equal(updated.json().account.maturityDate, '2028-01-01');
  } finally { await app.close(); }
});

test('migra cuentas existentes y conserva depósitos tras reabrir y archivar', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-finances-deposit-'));
  const path = join(directory, 'test.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE accounts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, bank TEXT NOT NULL, type TEXT NOT NULL,
    owner TEXT NOT NULL, last_four TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR',
    archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;`);
  legacy.prepare('INSERT INTO accounts (id,name,bank,type,owner,last_four,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('legacy', input.name, input.bank, input.type, '', '', '2026-01-01', '2026-01-01');
  legacy.close();
  let store = new AccountStore(path);
  try {
    store.db.prepare('INSERT INTO entries VALUES (?,?,?,?,?)').run('legacy-opening', 'legacy', 'opening_balance', input.openingDate, 12345);
    assert.equal(store.get('legacy').balanceCents, 12345);
    assert.equal(store.get('legacy').interestRate, undefined);
    const account = store.create(deposit);
    store.setArchived(account.id, true, account.version);
    store.close();
    store = new AccountStore(path);
    const saved = store.get(account.id);
    assert.equal(saved.interestRate, deposit.interestRate);
    assert.equal(saved.maturityDate, deposit.maturityDate);
    assert.equal(saved.openingDate, deposit.openingDate);
    assert.equal(saved.balanceCents, deposit.openingBalanceCents);
    assert.equal(saved.archived, true);
    const restored = store.setArchived(saved.id, false, saved.version);
    const converted = store.update(saved.id, input, restored.version);
    assert.equal(converted.interestRate, undefined);
    assert.equal(converted.maturityDate, undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('importes decimales exactos, negativos y formatos ambiguos', () => {
  assert.equal(parseEuros('1250,50'), 125050);
  assert.equal(parseEuros('0.29'), 29);
  assert.equal(parseEuros('-35,20'), -3520);
  assert.equal(parseEuros('0'), 0);
  for (const invalid of ['', '1.000,00', '1,234', '1e3', 'Infinity', '10000000001']) assert.equal(parseEuros(invalid), null);
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(accountInputSchema.safeParse({ ...input, lastFour: '123' }).success, false);
});

test('guardar, editar, archivar y reabrir conserva saldo e historial en disco', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-finances-test-'));
  const path = join(directory, 'test.sqlite');
  let store = new AccountStore(path);
  try {
    const account = store.create(input);
    assert.equal(account.balanceCents, 123456);
    const updated = store.update(account.id, { ...input, name: 'Nómina', openingBalanceCents: -2910 }, account.version);
    assert.equal(updated.balanceCents, -2910);
    assert.throws(() => store.update(account.id, input, account.version), { statusCode: 409 });
    const archived = store.setArchived(account.id, true, updated.version);
    assert.equal(archived.archived, true);
    assert.throws(() => store.update(account.id, input, archived.version), { statusCode: 409 });
    store.close();
    store = new AccountStore(path);
    const persisted = store.get(account.id);
    assert.equal(persisted.name, 'Nómina');
    assert.equal(persisted.balanceCents, -2910);
    assert.equal(persisted.archived, true);
    const restored = store.setArchived(account.id, false, persisted.version);
    assert.equal(restored.archived, false);
    const history = store.db.prepare('SELECT COUNT(*) AS count FROM account_history').get();
    assert.equal(history?.count, 4);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE kind = 'opening_balance'").get()?.count, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('los movimientos se suman al saldo y protegen la apertura de cambios', () => {
  const store = new AccountStore(':memory:');
  try {
    const account = store.create(input);
    store.db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?)').run('test-movement', account.id, 'movement', '2026-11-04', -2500);
    assert.equal(store.get(account.id).balanceCents, 120956);
    assert.throws(() => store.update(account.id, { ...input, openingBalanceCents: 0 }, account.version), { statusCode: 409 });
    assert.equal(store.get(account.id).balanceCents, 120956);
    const renamed = store.update(account.id, { ...input, name: 'Nuevo nombre' }, account.version);
    assert.equal(renamed.balanceCents, 120956);
  } finally { store.close(); }
});

test('API valida datos, evita ediciones obsoletas y rechaza accesos externos', async () => {
  const store = new AccountStore(':memory:');
  const app = await buildApp(store);
  const headers = { host: '127.0.0.1:4310' };
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/accounts', headers })).json().accounts.length, 0);
    for (const payload of [{ ...input, openingBalanceCents: 0.2 }, { ...input, openingDate: '2026-02-30' }, { ...input, name: ' ' }, { ...input, bank: 'inventado' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', headers, payload })).statusCode, 400);
    }
    const created = await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: input });
    assert.equal(created.statusCode, 201);
    const { account } = created.json();
    const updated = await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}`, headers, payload: { ...input, name: 'Actualizada', expectedVersion: account.version } });
    assert.equal(updated.statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}`, headers, payload: { ...input, expectedVersion: account.version } })).statusCode, 409);
    const archived = await app.inject({ method: 'PATCH', url: `/api/accounts/${account.id}/archive`, headers, payload: { archived: true, expectedVersion: updated.json().account.version } });
    assert.equal(archived.json().account.archived, true);
    const restored = await app.inject({ method: 'PATCH', url: `/api/accounts/${account.id}/archive`, headers, payload: { archived: false, expectedVersion: archived.json().account.version } });
    assert.equal(restored.json().account.archived, false);
    assert.equal((await app.inject({ method: 'GET', url: '/api/accounts', headers: { host: 'evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', headers: { ...headers, origin: 'https://evil.example' }, payload: input })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/accounts', headers })).json().accounts.length, 1);
  } finally { await app.close(); }
});

test('registrar el vencimiento de un depósito saca su capital como traspaso y lo archiva', () => {
  const store = new AccountStore(':memory:');
  try {
    const current = store.create({ ...input, openingDate: '2026-11-01', openingBalanceCents: 0 });
    const dep = store.create({ ...deposit, openingDate: '2026-07-01', openingBalanceCents: 50000, maturityDate: '2026-11-01' });
    // Abono del depósito en la cuenta corriente, marcado como traspaso.
    store.db.prepare("INSERT INTO entries VALUES ('abono', ?, 'movement', '2026-11-01', 50000)").run(current.id);
    store.db.prepare("INSERT INTO budget_allocations VALUES ('abono', NULL, 1, 1, '2026-11-01')").run();
    assert.throws(() => store.matureDeposit(current.id, '2026-11-01', current.version), { statusCode: 400 });
    assert.throws(() => store.matureDeposit(dep.id, '2026-06-30', dep.version), { statusCode: 400 });
    const matured = store.matureDeposit(dep.id, '2026-11-01', dep.version);
    assert.equal(matured.archived, true);
    assert.equal(matured.balanceCents, 0);
    const net = store.db.prepare("SELECT SUM(e.amount_cents) AS n FROM entries e JOIN budget_allocations b ON b.entry_id=e.id WHERE b.excluded=1").get()!.n;
    assert.equal(net, 0, 'el abono y el vencimiento se compensan');
    assert.throws(() => store.matureDeposit(dep.id, '2026-11-02', matured.version), { statusCode: 409 });
  } finally { store.close(); }
});

test('eliminar una cuenta borra sus movimientos solo si no hay ninguno clasificado', () => {
  const store = new AccountStore(':memory:');
  try {
    const keep = store.create({ ...input, openingDate: '2026-11-01' });
    const gone = store.create({ ...input, name: 'Para borrar', openingDate: '2026-11-01' });
    store.db.prepare("INSERT INTO entries VALUES ('m1', ?, 'movement', '2026-11-02', -1000)").run(gone.id);
    store.db.prepare("INSERT INTO entries VALUES ('m2', ?, 'movement', '2026-11-02', -1000)").run(keep.id);
    store.db.prepare("INSERT INTO budget_allocations VALUES ('m2', NULL, 1, 1, '2026-11-02')").run();
    assert.throws(() => store.deleteAccount(keep.id, keep.version), { statusCode: 409 });
    store.deleteAccount(gone.id, gone.version);
    assert.equal(store.list().length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM entries WHERE account_id=?').get(gone.id)!.n, 0);
  } finally { store.close(); }
});
