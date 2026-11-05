import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTransfers, type InternalTransfer } from '../shared/reconciliation.js';

const row = (id: string, accountId: string, amountCents: number, date = '2026-11-01'): InternalTransfer => ({ id, accountId, accountName: accountId, amountCents, date });

test('empareja una sola vez y permite diferencias de fecha entre bancos', () => {
  const result = reconcileTransfers([row('a','ING',-50000),row('b','MyInvestor',50000,'2026-11-03'),row('c','ING',-50000)]);
  assert.equal(result.matchedPairs,1);
  assert.equal(result.netCents,-50000);
  assert.deepEqual(result.unmatched.map(row=>row.id),['c']);
});
test('un neto cero no oculta importes distintos, movimientos de la misma cuenta o fechas lejanas', () => {
  const rows = [row('a','ING',-10000),row('b','MyInvestor',6000),row('c','MyInvestor',4000)];
  assert.equal(reconcileTransfers(rows).netCents,0);
  assert.equal(reconcileTransfers(rows).unmatched.length,3);
  assert.equal(reconcileTransfers([row('a','ING',-100),row('b','ING',100)]).matchedPairs,0);
  assert.equal(reconcileTransfers([row('a','ING',-100),row('b','Other',100,'2026-11-09')]).matchedPairs,0);
});
test('sin traspasos no declara coincidencias y no modifica las filas originales', () => {
  assert.deepEqual(reconcileTransfers([]),{count:0,matchedPairs:0,netCents:0,unmatched:[]});
  const rows=[row('b','Other',100),row('a','ING',-100)];
  assert.equal(reconcileTransfers(rows).unmatched.length,0);
  assert.equal(rows[0].id,'b');
});
