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
    const list = async () => (await app.inject({ method: 'GET', url: '/api/movements', headers })).json().movements;
    const movement = (await list())[0];
    assert.equal(movement.lineId, null);
    assert.equal(movement.excluded, false);
    assert.equal(movement.assignmentVersion, 0);
    const assign = (lineId: string | null, excluded: boolean, expectedVersion: number) => app.inject({
      method: 'POST', url: '/api/budget/assignments', headers,
      payload: { items: [{ entryId: movement.id, expectedVersion }], lineId, excluded },
    });
    assert.equal((await assign('comida', false, 0)).statusCode, 200);
    let saved = (await list()).find((row: { id: string }) => row.id === movement.id);
    assert.equal(saved.lineId, 'comida');
    assert.equal(saved.assignmentVersion, 1);
    assert.equal(saved.category, 'Compras', 'conserva la categoría bancaria original');
    const budgetRows = (await app.inject({ method: 'GET', url: '/api/budget/2026/movements', headers })).json().movements;
    assert.equal(budgetRows.find((row: { id: string }) => row.id === movement.id).lineId, 'comida');
    assert.equal((await assign('gasolina', false, 0)).statusCode, 409, 'rechaza cambios con una versión antigua');
    assert.equal((await assign('gasolina', false, 1)).statusCode, 200);
    assert.equal((await list())[0].lineId, 'gasolina');
    assert.equal((await assign(null, true, 2)).statusCode, 200);
    saved = (await list())[0];
    assert.equal(saved.lineId, null);
    assert.equal(saved.excluded, true);
    assert.equal(saved.assignmentVersion, 3);
    assert.equal((await assign(null, false, 3)).statusCode, 200);
    saved = (await list())[0];
    assert.equal(saved.lineId, null);
    assert.equal(saved.excluded, false);
    assert.equal(saved.assignmentVersion, 4);
  } finally { await app.close(); }
});

test('adelantar el inicio de una cuenta existente si el extracto cuadra con su saldo inicial', () => {
  const store = new AccountStore(':memory:');
  try {
    const service = new ImportService(store);
    const first = service.preview(ingFile([jan3, jan2]), 'desde-dia-2.csv');
    const original = service.commit(service.prepare({ token: first.token, mapping: first.mapping, accountId: null, newAccount: bankAccount, startDate: '2026-01-02' }).id, true);
    assert.equal(original.account.openingDate, '2026-01-02');
    assert.equal(original.account.openingBalanceCents, 11000);
    const full = service.preview(ingFile([jan3, jan2, jan1]), 'completo.csv');
    const plan = service.prepare({ token: full.token, mapping: full.mapping, accountId: original.account.id, startDate: '2026-01-01' });
    assert.equal(plan.extendStart, true);
    assert.equal(plan.openingBalanceCents, 10000);
    assert.equal(plan.newCount, 1);
    assert.equal(plan.reconciliation, 'matches');
    assert.equal(plan.resultingBalanceCents, 10700);
    assert.throws(() => service.commit(plan.id, false), { statusCode: 400 });
    const result = service.commit(plan.id, true);
    assert.equal(result.account.openingDate, '2026-01-01');
    assert.equal(result.account.openingBalanceCents, 10000);
    assert.equal(result.account.balanceCents, 10700, 'el saldo actual no cambia');
    assert.equal(service.movements().length, 3);
    // Un extracto que no cuadra con el saldo inicial no puede adelantar la fecha.
    const other = service.preview(ingFile([jan1.replace('110,00', '105,00'), '31/12/2025;Compras;Otros;X;;-5,00;95,00']), 'raro.csv');
    assert.throws(() => service.prepare({ token: other.token, mapping: other.mapping, accountId: original.account.id, startDate: '2025-12-31' }), { statusCode: 409 });
  } finally { store.close(); }
});

test('tarjeta de crédito ING: se detecta, se importa como deuda y el cargo del día 5 la paga sin contar dos veces', () => {
  const store = new AccountStore(':memory:');
  try {
    const service = new ImportService(store);
    const card = Buffer.from('Tarjeta Crédito;    Número de tarjeta:      ;5160 9734 3100 2057\n;    Titular:      ;PRUEBA\n;    Fecha de exportación:;05/11/2026 23:45h\n\nFECHA VALOR;CATEGORÍA;SUBCATEGORÍA;DESCRIPCION;COMENTARIO;;ESTADO;IMPORTE (€)\n04/11/2026;Compras;Otros;AIRSERV;;;Pendiente de liquidar;-1\n03/11/2026;Ocio;Apuestas;TULOTERO;;;Pendiente de liquidar;-20\n', 'utf8');
    const doc = service.preview(card, 'tarjeta.csv');
    assert.equal(doc.creditCard, true);
    assert.equal(doc.detectedBank, 'ING');
    assert.equal(doc.lastFour, '2057');
    const cardAccount = { name: 'Tarjeta ING', bank: 'ING' as const, type: 'credit_card' as const, owner: '', lastFour: '2057' };
    assert.throws(() => service.prepare({ token: doc.token, mapping: doc.mapping, accountId: null, newAccount: { ...cardAccount, type: 'current' }, startDate: '2026-11-03', manualOpeningCents: 0 }), { statusCode: 400 });
    const imported = service.commit(service.prepare({ token: doc.token, mapping: doc.mapping, accountId: null, newAccount: cardAccount, startDate: '2026-11-03', manualOpeningCents: 0 }).id, true);
    assert.equal(imported.account.balanceCents, -2100, 'la deuda de la tarjeta');
    // Cargo del día 5 en la cuenta corriente.
    const bank = service.preview(ingFile(['05/12/2026;Otros;Otros;Cargo mensual Tarjeta crédito;;-21,00;79,00', '01/12/2026;Ingresos;Otros;Ingreso;;100,00;100,00']), 'ing.csv');
    const current = service.commit(service.prepare({ token: bank.token, mapping: bank.mapping, accountId: null, newAccount: bankAccount, startDate: '2026-12-01' }).id, true);
    const candidates = store.cardPaymentCandidates(imported.account.id);
    assert.equal(candidates.length, 1);
    const paid = store.registerCardPayment(imported.account.id, candidates[0].id, imported.account.version);
    assert.equal(paid.balanceCents, 0, 'el cargo salda la tarjeta');
    assert.equal(store.get(current.account.id).balanceCents, 7900);
    assert.equal(store.cardPaymentCandidates(imported.account.id).length, 0, 'no se puede usar dos veces');
    const excluded = store.db.prepare('SELECT COUNT(*) AS n FROM budget_allocations WHERE excluded=1').get()!.n;
    assert.equal(excluded, 2, 'cargo y pago quedan como traspaso interno');
  } finally { store.close(); }
});
