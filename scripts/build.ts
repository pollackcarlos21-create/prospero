import { build as bundle } from 'esbuild';
import { build as renderer } from 'vite';
await bundle({
  entryPoints: ['apps/desktop/src/main/index.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron', 'node:sqlite'],
  sourcemap: false,
});
await bundle({
  entryPoints: ['apps/desktop/src/preload.ts'],
  outfile: 'dist/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: false,
});
await renderer();
