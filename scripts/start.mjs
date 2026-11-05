import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const url = 'http://127.0.0.1:4310';
const openBrowser = () => {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true });
  browser.on('error', () => console.log(`Abre ${url} en tu navegador.`));
  browser.unref();
};

async function isReady() {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(700) });
    const data = await response.json();
    return response.ok && data.app === 'personal-finances';
  } catch { return false; }
}

if (await isReady()) {
  openBrowser();
  console.log(`La aplicación ya está abierta: ${url}`);
} else {
  const child = spawn(process.execPath, ['dist/server/server/index.js'], { stdio: 'inherit', windowsHide: true });
  let exited = false;
  child.on('exit', code => { exited = true; process.exitCode = code ?? 0; });
  child.on('error', error => { exited = true; console.error(error.message); process.exitCode = 1; });
  for (let attempt = 0; attempt < 40 && !exited; attempt++) {
    if (await isReady()) { openBrowser(); break; }
    await setTimeout(250);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
}
