import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const files: string[] = [];
async function walk(path: string) {
  for (const item of await readdir(path, { withFileTypes: true })) {
    const name = join(path, item.name);
    if (item.isDirectory()) await walk(name);
    else if (/\.(tsx?|cjs|json|md|ya?ml)$/.test(name)) files.push(name);
  }
}
await walk('apps');
await walk('packages');
await walk('scripts');
await walk('docs');
await walk('.github');
for (const name of ['README.md', 'AGENTS.md', 'package.json']) files.push(name);
const findings: { file: string; line: number; kind: string }[] = [];
for (const file of files) {
  const content = await readFile(file, 'utf8');
  content.split('\n').forEach((line, index) => {
    // Report location only; a suspicious credential is never echoed into diagnostics.
    if (/sk-[a-zA-Z0-9_-]{20,}/.test(line) && !/test|fake|placeholder|credential-marker/.test(line))
      findings.push({ file, line: index + 1, kind: 'possible credential' });
    if (
      file.includes('/renderer/') &&
      !file.includes('.test.') &&
      /(?:from\s+['"](?:node:|electron)|\brequire\(|\bprocess\.env|ipcRenderer|child_process|localStorage)/.test(
        line,
      )
    )
      findings.push({ file, line: index + 1, kind: 'renderer privilege' });
    if (
      file.startsWith('packages/core/') &&
      /(?:from\s+['"](?:node:|electron|react|@prospero\/)|\brequire\(|\bprocess\.env)/.test(line)
    )
      findings.push({ file, line: index + 1, kind: 'core dependency' });
  });
}
console.log(JSON.stringify({ scannedFiles: files.length, findings }, null, 2));
if (findings.length) process.exit(1);
