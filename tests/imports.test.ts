import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../server/database.js';
import { ImportService } from '../server/import-service.js';
import { parseMovements, readDocument } from '../server/importers.js';
import { buildApp } from '../server/app.js';

const bankAccount = { name: 'ING principal', bank: 'ING' as const, type: 'current' as const, owner: '', lastFour: '1234' };
const ingFile = (rows: string[], number = '1465 0120 0000 00001234') => Buffer.from(`Movimientos de la Cuenta;;Número de cuenta:;${number}\n;;Titular:;Prueba\nF. VALOR;CATEGORÍA;SUBCATEGORÍA;DESCRIPCIÓN;COMENTARIO;IMPORTE (€);SALDO (€)\n${rows.join('\n')}`, 'utf8');
const jan1 = '01/01/2026;Ingresos;Nómina;Nómina;;10,00;110,00';
const jan2 = '02/01/2026;Compras;Supermercado;Compra;;-2,00;108,00';
const jan3 = '03/01/2026;Compras;Otros;Otra compra;;-1,00;107,00';

test('ING: primera carga fija apertura al comienzo del día y conserva categorías', () => {
  const store = new AccountStore(':memory:');
  try {
    const service = new ImportService(store);
    const doc = service.preview(ingFile([jan3, jan2, jan1]), 'ing.csv');
    assert.equal(doc.detectedBank, 'ING');
    const plan = service.prepare({ token: doc.token, mapping: doc.mapping, accountId: null, newAccount: bankAccount, startDate: '2026-01-02' });
    assert.equal(plan.openingBalanceCents, 11000);
    assert.equal(plan.newCount, 2);
    assert.equal(plan.excludedCount, 1);
    assert.equal(plan.resultingBalanceCents, 10700);
    assert.equal(plan.reconciliation, 'matches');
    assert.throws(() => service.commit(plan.id, false), { statusCode: 400 });
    const result = service.commit(plan.id, true);
    assert.equal(result.account.movementCount, 2);
    assert.equal(result.account.openingDate, '2026-01-02');
    assert.equal(result.account.balanceCents, 10700);
    assert.equal(service.movements()[0].category, 'Compras');
    assert.equal(service.batches()[0].rowCount, 2);
    assert.equal(store.db.prepare('SELECT original_file FROM import_batches').get()?.original_file instanceof Uint8Array, true);
    assert.throws(() => service.commit(plan.id, true), { statusCode: 410 });
  } finally { store.close(); }
});

test('otro archivo con fechas solapadas importa solo movimientos nuevos; reimportar no cambia el saldo', () => {
  const store = new AccountStore(':memory:');
  try {
    const service = new ImportService(store);
    const first = service.preview(ingFile([jan2, jan1]), 'enero.csv');
    const original = service.commit(service.prepare({ token: first.token, mapping: first.mapping, accountId: null, newAccount: bankAccount, startDate: '2026-01-01' }).id, true);
    const second = service.preview(ingFile([jan3, jan2]), 'mes-siguiente-renombrado.csv');
    const input = { token: second.token, mapping: second.mapping, accountId: original.account.id, startDate: '2026-01-01' };
    const plan = service.prepare(input);
    assert.equal(plan.duplicateCount, 1);
    assert.equal(plan.newCount, 1);
    assert.equal(plan.reconciliation, 'matches');
    const result = service.commit(plan.id, false);
    assert.equal(result.account.balanceCents, 10700);
    const repeat = service.prepare(input);
    assert.equal(repeat.newCount, 0);
    assert.equal(repeat.duplicateCount, 2);
    service.commit(repeat.id, false);
    assert.equal(service.movements().length, 3);
    assert.equal(service.batches().length, 2);
    assert.equal(store.get(original.account.id).balanceCents, 10700);
    assert.throws(() => service.prepare({ ...input, accountId: null, newAccount: bankAccount }), { statusCode: 400 });
  } finally { store.close(); }
});

test('cargos del mismo día, concepto e importe con distinto saldo se conservan', () => {
  const document = readDocument(ingFile([
    '01/01/2026;Compras;;Compra;;-5,00;90,00',
    '01/01/2026;Compras;;Compra;;-5,00;95,00',
  ]), 'ing.csv');
  const parsed = parseMovements(document, document.info.mapping);
  assert.equal(parsed.rows.length, 2);
  assert.notEqual(parsed.rows[0].fingerprint, parsed.rows[1].fingerprint);
});

test('Sabadell usa fecha operativa; conserva fecha valor futura sin desplazar el presupuesto', () => {
  const content = Buffer.from('Consulta de movimientos\nCuenta:;ES1200810000000000001234\nDivisa:;EUR\nTitular:;Prueba\nF. Operativa;Concepto;F. Valor;Importe;Saldo;Referencia 1;Referencia 2\n03/11/2026;Compra;06/11/2026;-2,41;97,59;;tarjeta\n02/11/2026;Ingreso;02/11/2026;100;100;;');
  const doc = readDocument(content, 'sabadell.csv');
  assert.equal(doc.info.detectedBank, 'Sabadell');
  const parsed = parseMovements(doc, doc.info.mapping);
  assert.equal(parsed.rows.at(-1)?.date, '2026-11-03');
  assert.equal(parsed.rows.at(-1)?.valueDate, '2026-11-06');
});

test('Openbank: HTML con extensión XLS y acentos Windows-1252', () => {
  const html = '\n <!DOCTYPE html><html><head><meta charset="iso-8859-1"></head><body><table><tr><td>Cuentas - Movimientos</td></tr><tr><td>Número de Cuenta:</td><td>0073 0100 0000 00001234</td></tr><tr><td>Fecha Operación</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr><tr><td>02/11/2026</td><td>02/11/2026</td><td>Recibo teléfono</td><td>-2.015,14</td><td>100,00</td></tr></table></body></html>';
  const doc = readDocument(Buffer.from(html, 'latin1'), 'Openbank.xls');
  assert.equal(doc.info.detectedBank, 'Openbank');
  const parsed = parseMovements(doc, doc.info.mapping);
  assert.equal(parsed.rows[0].description, 'Recibo teléfono');
  assert.equal(parsed.rows[0].amountCents, -201514);
});

test('MyInvestor: UTF-8, apertura manual y duplicados sin saldo', () => {
  const buffer = Buffer.from('Fecha de operación;Fecha de valor;Concepto;Importe;Divisa\n29/10/2026;30/10/2026;Aportación;-50,25;EUR\n28/10/2026;28/10/2026;Ingreso;100;EUR');
  const store = new AccountStore(':memory:');
  try {
    const service = new ImportService(store);
    const doc = service.preview(buffer, 'MyInvestor.csv');
    assert.equal(doc.headers[0], 'Fecha de operación');
    const input = { token: doc.token, mapping: doc.mapping, accountId: null, newAccount: { ...bankAccount, bank: 'MyInvestor' as const, lastFour: '' }, startDate: '2026-10-28' };
    assert.throws(() => service.prepare(input), { statusCode: 400 });
    const plan = service.prepare({ ...input, manualOpeningCents: 2000 });
    assert.equal(plan.reconciliation, 'unavailable');
    const result = service.commit(plan.id, true);
    assert.equal(result.account.balanceCents, 6975);
    const repeated = service.prepare({ token: doc.token, mapping: doc.mapping, accountId: result.account.id, startDate: '2026-10-28' });
    assert.equal(repeated.newCount, 0);
    assert.equal(repeated.duplicateCount, 2);
    assert.equal(service.movements()[0].valueDate, '2026-10-30');
  } finally { store.close(); }
});

test('saldos incoherentes, divisa ajena y filas erróneas bloquean la carga', () => {
  const doc = readDocument(ingFile([jan3.replace('107,00', '106,00'), jan2]), 'ing.csv');
  assert.throws(() => parseMovements(doc, doc.info.mapping), { statusCode: 400 });
  assert.throws(() => readDocument(Buffer.from('Fecha;Concepto;Importe;Divisa\n01/01/2026;Prueba;10;USD'), 'otro.csv'), { statusCode: 400 });
  const invalid = readDocument(ingFile([jan1.replace('01/01/2026', '31/02/2026')]), 'ing.csv');
  assert.throws(() => parseMovements(invalid, invalid.info.mapping), /Fila 4/);
});

test('importación atómica: periodo incompleto y cambio concurrente no guardan movimientos', () => {
  const store = new AccountStore(':memory:');
  try {
    const service = new ImportService(store);
    const first = service.preview(ingFile([jan1]), 'ing.csv');
    const result = service.commit(service.prepare({ token: first.token, mapping: first.mapping, accountId: null, newAccount: bankAccount, startDate: '2026-01-01' }).id, true);
    const gap = service.preview(ingFile([jan3]), 'incompleto.csv');
    const request = { token: gap.token, mapping: gap.mapping, accountId: result.account.id, startDate: result.account.openingDate };
    const plan = service.prepare(request);
    assert.equal(plan.reconciliation, 'differs');
    assert.throws(() => service.commit(plan.id, false), { statusCode: 409 });
    assert.equal(service.movements().length, 1);
    const next = service.preview(ingFile([jan2]), 'siguiente.csv');
    const correct = service.prepare({ ...request, token: next.token });
    store.setArchived(result.account.id, true, store.get(result.account.id).version);
    assert.throws(() => service.commit(correct.id, false), { statusCode: 409 });
    assert.equal(service.movements().length, 1);
  } finally { store.close(); }
});

test('API recibe archivo binario, genera vista previa y confirma sin duplicar', async () => {
  const store = new AccountStore(':memory:');
  const app = await buildApp(store);
  const headers = { host: '127.0.0.1:4310' };
  try {
    const uploaded = await app.inject({ method: 'POST', url: '/api/imports/preview', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-filename': 'ing.csv' }, payload: ingFile([jan2, jan1]) });
    assert.equal(uploaded.statusCode, 200);
    const { document } = uploaded.json();
    const prepared = await app.inject({ method: 'POST', url: '/api/imports/plan', headers, payload: { token: document.token, mapping: document.mapping, accountId: null, newAccount: bankAccount, startDate: '2026-01-01' } });
    assert.equal(prepared.statusCode, 200);
    const imported = await app.inject({ method: 'POST', url: '/api/imports/commit', headers, payload: { planId: prepared.json().plan.id, confirmOpening: true } });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().imported, 2);
    assert.equal((await app.inject({ method: 'GET', url: '/api/movements', headers })).json().movements.length, 2);
  } finally { await app.close(); }
});
