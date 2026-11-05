import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { accountInputSchema } from '../shared/accounts.js';
import { reconcileTransfers } from '../shared/reconciliation.js';
import { AccountError, AccountStore } from './database.js';
import { ImportService, planSchema } from './import-service.js';
import { BudgetService, budgetAssignmentSchema, budgetCellSchema, budgetLineSchema, budgetCloseSchema, budgetCloseCommitSchema, budgetSettingsSchema } from './budget-service.js';

export async function buildApp(store: AccountStore, clientRoot?: string) {
  const app = Fastify({ logger: false, bodyLimit: 32_768 });
  const imports = new ImportService(store);
  const budget = new BudgetService(store);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_request, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      return reply.code(403).send({ message: 'Acceso permitido únicamente desde este ordenador.' });
    }
    const origin = request.headers.origin;
    const allowedOrigins = new Set([`http://${host}`, 'http://127.0.0.1:5173', 'http://localhost:5173']);
    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ message: 'Origen no permitido.' });
    }
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? 'Revisa los datos.' });
    if (error instanceof AccountError) return reply.code(error.statusCode).send({ message: error.message });
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ message: 'La petición no es válida.' });
    console.error(error);
    return reply.code(500).send({ message: 'No se han podido guardar los cambios. Inténtalo de nuevo.' });
  });

  app.get('/api/health', async () => ({ status: 'ok', app: 'personal-finances', version: 5 }));
  app.get('/api/accounts', async () => ({ accounts: store.list(), reconciliation: reconcileTransfers(
    store.db.prepare(`SELECT e.id,e.account_id,e.date,e.amount_cents,a.name FROM entries e
      JOIN accounts a ON a.id=e.account_id JOIN budget_allocations b ON b.entry_id=e.id
      WHERE b.excluded=1 AND e.kind='movement'`).all().map(row => ({
        id: String(row.id), accountId: String(row.account_id), accountName: String(row.name),
        date: String(row.date), amountCents: Number(row.amount_cents),
      })),
  ) }));
  app.post('/api/accounts', async (request, reply) => {
    const account = store.create(accountInputSchema.parse(request.body));
    return reply.code(201).send({ account });
  });
  const paramsSchema = z.object({ id: z.uuid() });
  app.put('/api/accounts/:id', async request => {
    const { id } = paramsSchema.parse(request.params);
    const { expectedVersion, ...input } = accountInputSchema.safeExtend({ expectedVersion: z.number().int().positive() }).parse(request.body);
    return { account: store.update(id, input, expectedVersion) };
  });
  app.patch('/api/accounts/:id/archive', async request => {
    const { id } = paramsSchema.parse(request.params);
    const { archived, expectedVersion } = z.object({ archived: z.boolean(), expectedVersion: z.number().int().positive() }).strict().parse(request.body);
    return { account: store.setArchived(id, archived, expectedVersion) };
  });

  app.delete('/api/accounts/:id', async request => {
    const { id } = paramsSchema.parse(request.params);
    const { expectedVersion } = z.object({ expectedVersion: z.coerce.number().int().positive() }).strict().parse(request.query);
    return store.deleteAccount(id, expectedVersion);
  });
  app.get('/api/accounts/:id/card-payments', async request => {
    const { id } = paramsSchema.parse(request.params);
    return { candidates: store.cardPaymentCandidates(id) };
  });
  app.post('/api/accounts/:id/card-payments', async request => {
    const { id } = paramsSchema.parse(request.params);
    const { entryId, expectedVersion } = z.object({ entryId: z.uuid(), expectedVersion: z.number().int().positive() }).strict().parse(request.body);
    return { account: store.registerCardPayment(id, entryId, expectedVersion) };
  });
  app.post('/api/accounts/:id/mature', async request => {
    const { id } = paramsSchema.parse(request.params);
    const { date, expectedVersion } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), expectedVersion: z.number().int().positive() }).strict().parse(request.body);
    return { account: store.matureDeposit(id, date, expectedVersion) };
  });
  app.post('/api/imports/preview', { bodyLimit: 5 * 1024 * 1024 }, async request => {
    if (!Buffer.isBuffer(request.body)) throw new AccountError(400, 'Adjunta el archivo de movimientos.');
    let filename: string;
    try { filename = decodeURIComponent(String(request.headers['x-filename'] ?? '')); }
    catch { throw new AccountError(400, 'El nombre del archivo no es válido.'); }
    const headerValue = request.headers['x-header-row'];
    const headerRow = headerValue === undefined ? undefined : z.coerce.number().int().min(1).max(100).parse(headerValue);
    return { document: imports.preview(request.body, filename, headerRow) };
  });
  app.post('/api/imports/plan', async request => ({ plan: imports.prepare(planSchema.parse(request.body)) }));
  app.post('/api/imports/commit', async request => {
    const { planId, confirmOpening } = z.object({ planId: z.uuid(), confirmOpening: z.boolean() }).strict().parse(request.body);
    return imports.commit(planId, confirmOpening);
  });
  app.get('/api/movements', async () => ({ movements: imports.movements(), batches: imports.batches() }));
  app.get('/api/budget/lines',async()=>({lines:budget.lines()}));
  app.post('/api/budget/close/preview',async request=>budget.closePreview(budgetCloseSchema.parse(request.body).period));
  app.post('/api/budget/close',async request=>{
    const input=budgetCloseCommitSchema.parse(request.body);
    return budget.closeMonth(input.period,input.fingerprint);
  });
  app.post('/api/budget/reopen',async request=>budget.reopenMonth(budgetCloseSchema.parse(request.body).period));
  app.put('/api/budget/opening',async request=>{
    const input=z.object({lineId:z.string().min(1).max(100),period:budgetCloseSchema.shape.period,amountCents:z.number().int().min(-1e12).max(1e12),expectedVersion:z.number().int().positive()}).strict().parse(request.body);
    return budget.updateOpening(input.lineId,input.period,input.amountCents,input.expectedVersion);
  });
  app.get('/api/budget/:year',async request=>{
    const {year}=z.object({year:z.coerce.number().int().min(2000).max(2099)}).parse(request.params);
    return budget.year(year);
  });
  app.put('/api/budget/settings',async request=>budget.updateSettings(budgetSettingsSchema.parse(request.body)));
  app.put('/api/budget/cells',async request=>budget.updateCell(budgetCellSchema.parse(request.body)));
  app.put('/api/budget/cells/bulk',async request=>{
    const items=z.array(budgetCellSchema).min(1).max(24).parse(request.body);
    return {cells:store.transaction(()=>items.map(item=>budget.updateCell(item)))};
  });
  app.post('/api/budget/lines',async(request,reply)=>reply.code(201).send({line:budget.createLine(budgetLineSchema.parse(request.body))}));
  app.put('/api/budget/lines/:id',async request=>{
    const {id}=z.object({id:z.string().min(1).max(100)}).parse(request.params);
    const {expectedVersion,...input}=budgetLineSchema.extend({expectedVersion:z.number().int().positive()}).parse(request.body);
    return {line:budget.updateLine(id,input,expectedVersion)};
  });
  app.get('/api/budget/:year/movements',async request=>{
    const {year}=z.object({year:z.coerce.number().int().min(2000).max(2099)}).parse(request.params);
    return {movements:budget.movements(year)};
  });
  app.post('/api/budget/assignments',{bodyLimit:128*1024},async request=>budget.assign(budgetAssignmentSchema.parse(request.body)));
  app.get('/api/budget/:year/history',async request=>{
    const {year}=z.object({year:z.coerce.number().int().min(2000).max(2099)}).parse(request.params);
    return {history:budget.history(year)};
  });

  if (clientRoot) {
    await app.register(fastifyStatic, { root: clientRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ message: 'Ruta no encontrada.' });
      return reply.code(404).send({ message: 'Página no encontrada.' });
    });
  }
  app.addHook('onClose', async () => store.close());
  return app;
}
