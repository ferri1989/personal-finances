import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { accountInputSchema } from '../shared/accounts.js';
import { AccountError, AccountStore } from './database.js';
import { ImportService, planSchema } from './import-service.js';
import { BudgetService, budgetAssignmentSchema, budgetCellSchema, budgetLineSchema } from './budget-service.js';

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

  app.get('/api/health', async () => ({ status: 'ok', app: 'personal-finances', version: 3 }));
  app.get('/api/accounts', async () => ({ accounts: store.list() }));
  app.post('/api/accounts', async (request, reply) => {
    const account = store.create(accountInputSchema.parse(request.body));
    return reply.code(201).send({ account });
  });
  const paramsSchema = z.object({ id: z.uuid() });
  app.put('/api/accounts/:id', async request => {
    const { id } = paramsSchema.parse(request.params);
    const { expectedVersion, ...input } = accountInputSchema.extend({ expectedVersion: z.number().int().positive() }).parse(request.body);
    return { account: store.update(id, input, expectedVersion) };
  });
  app.patch('/api/accounts/:id/archive', async request => {
    const { id } = paramsSchema.parse(request.params);
    const { archived, expectedVersion } = z.object({ archived: z.boolean(), expectedVersion: z.number().int().positive() }).strict().parse(request.body);
    return { account: store.setArchived(id, archived, expectedVersion) };
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
  app.get('/api/budget/:year',async request=>{
    const {year}=z.object({year:z.coerce.number().int().min(2000).max(2099)}).parse(request.params);
    return budget.year(year);
  });
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
