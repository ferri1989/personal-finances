import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../server/database.js';
import { buildApp } from '../server/app.js';
import { accountInputSchema, parseEuros, validDate } from '../shared/accounts.js';

const input = { name: 'Cuenta principal', bank: 'ING' as const, type: 'current' as const, owner: 'Familia', lastFour: '1234', openingDate: '2026-11-03', openingBalanceCents: 123456 };

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
