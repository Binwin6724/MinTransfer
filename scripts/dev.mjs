// Development: bundles the main process, starts the Vite dev server and launches Electron against it.
//   npm run dev
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

execFileSync(process.execPath, [path.join(root, 'scripts/build-main.mjs')], { stdio: 'inherit' });
const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`→ Renderer at ${url}`);

const electron = require('electron');
const child = spawn(electron, ['.', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
