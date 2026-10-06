import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

/** Inventory additions/removals as well as bytes; identity alone is not functional proof. */
export async function acceptanceSourceIdentity(root: string) {
  const files: { path: string; sha256: string }[] = [];
  async function visit(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.DS_Store' ||
        /^\.env(?:\.|$)/.test(entry.name) ||
        /\.(?:sqlite|db)(?:[.-].*)?$/.test(entry.name)
      )
        continue;
      const child = join(folder, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile())
        files.push({ path: relative(root, child), sha256: hash(await readFile(child)) });
    }
  }
  for (const folder of ['apps', 'packages', 'tests', 'scripts']) await visit(join(root, folder));
  for (const filename of [
    'package.json',
    'bun.lock',
    'tsconfig.json',
    'biome.json',
    'playwright.config.ts',
    'docs/V1-ACCEPTANCE.md',
    'docs/V1-REAL-VALIDATION.md',
  ])
    files.push({ path: filename, sha256: hash(await readFile(join(root, filename))) });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: hash(JSON.stringify(files)), files };
}
