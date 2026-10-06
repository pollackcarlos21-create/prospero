import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Build an inert main-only library. This does not launch Electron or authorize a real run.
const directory = 'output/v1-live-helper';
const outfile = `${directory}/runtime.cjs`;
await mkdir(directory, { recursive: true });
await build({
  entryPoints: ['tests/acceptance/live-electron-runtime.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron', 'node:sqlite'],
  sourcemap: false,
});
const sha256 = createHash('sha256')
  .update(await readFile(outfile))
  .digest('hex');
await writeFile(
  `${directory}/identity.json`,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      artifact: 'acceptance-main-library',
      sha256,
      completeRealRunner: false,
      executionAuthorization: false,
      actualNativeVerification: 'pending',
      actualHttpRequests: 0,
    },
    null,
    2,
  )}\n`,
);
console.log(`Built the inert acceptance main library (${sha256}). No real task was launched.`);
