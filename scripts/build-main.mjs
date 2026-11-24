// Bundles the Electron main and preload scripts with esbuild.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // sql.js loads its .wasm next to itself, so it ships as a normal dependency.
  external: ['electron', 'sql.js'],
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: root,
};
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist/main/main.js' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist/main/preload.js' });
