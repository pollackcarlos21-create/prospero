import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { build } from 'esbuild';
await build({
  entryPoints: ['apps/desktop/src/main/index.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'node:sqlite'],
});
await build({
  entryPoints: ['apps/desktop/src/preload.ts'],
  outfile: 'dist/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
const server = await createServer();
await server.listen();
const env: NodeJS.ProcessEnv = { ...process.env, PROSPERO_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn('node_modules/.bin/electron', ['.'], { stdio: 'inherit', env });
async function close() {
  child.kill('SIGTERM');
  await server.close();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
