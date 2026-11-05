import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountStore } from './database.js';
import { buildApp } from './app.js';

const dataDir = process.env.FINANCE_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'PersonalFinances');
const clientRoot = fileURLToPath(new URL('../../client/', import.meta.url));
const store = new AccountStore(join(resolve(dataDir), 'finances.sqlite'));
const app = await buildApp(store, existsSync(join(clientRoot, 'index.html')) ? clientRoot : undefined);

try {
  await app.listen({ port: 4310, host: '127.0.0.1' });
  console.log('Mis finanzas: http://127.0.0.1:4310');
  console.log(`Datos locales: ${resolve(dataDir)}`);
} catch (error) {
  await app.close();
  console.error(error);
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { await app.close(); process.exit(0); });
}
