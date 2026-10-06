import { packager } from '@electron/packager';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const staging = await mkdtemp(join(tmpdir(), 'prospero-package-'));
try {
  await cp('dist', join(staging, 'dist'), { recursive: true });
  await cp('LICENSE', join(staging, 'LICENSE'));
  await cp('THIRD-PARTY-NOTICES.md', join(staging, 'THIRD-PARTY-NOTICES.md'));
  const source = JSON.parse(await readFile('package.json', 'utf8'));
  await writeFile(
    join(staging, 'package.json'),
    JSON.stringify({
      name: 'prospero',
      productName: 'Prospero',
      version: source.version,
      main: 'dist/main.cjs',
      description: source.description,
      license: 'MIT',
    }),
  );
  await mkdir('release', { recursive: true });
  const iconset = join(staging, 'Prospero.iconset');
  await mkdir(iconset);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  function command(
    executable: string,
    args: string[],
    stage:
      | 'Icon conversion'
      | 'Local ad-hoc signing'
      | 'Signature verification' = 'Icon conversion',
  ) {
    const result = spawnSync(executable, args, { env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${stage} failed.`);
  }
  const image = join(staging, 'icon.png');
  command(resolve('node_modules/.bin/electron'), [
    resolve('scripts/render-icon.cjs'),
    resolve('assets/icon.svg'),
    image,
  ]);
  for (const size of [16, 32, 128, 256, 512]) {
    command('sips', [
      '-z',
      `${size}`,
      `${size}`,
      image,
      '--out',
      join(iconset, `icon_${size}x${size}.png`),
    ]);
    command('sips', [
      '-z',
      `${size * 2}`,
      `${size * 2}`,
      image,
      '--out',
      join(iconset, `icon_${size}x${size}@2x.png`),
    ]);
  }
  const icon = join(staging, 'Prospero.icns');
  command('iconutil', ['-c', 'icns', iconset, '-o', icon]);
  const paths = await packager({
    dir: staging,
    out: resolve('release'),
    name: 'Prospero',
    icon,
    appBundleId: 'app.prospero.desktop',
    appVersion: source.version,
    electronVersion: source.devDependencies.electron,
    // Supplying an existing ZIP directory disables the downloader entirely.
    electronZipDir: process.env.PROSPERO_ELECTRON_ZIP_DIR,
    platform: 'darwin',
    arch: 'arm64',
    asar: true,
    overwrite: true,
    prune: false,
    appCopyright: 'Copyright © 2026 Prospero contributors',
    darwinDarkModeSupport: true,
  });
  for (const path of paths) {
    const application = join(path, 'Prospero.app');
    command(
      '/usr/bin/codesign',
      ['--force', '--deep', '--sign', '-', application],
      'Local ad-hoc signing',
    );
    command(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', application],
      'Signature verification',
    );
  }
  console.log(
    `Local ad-hoc signed development application: ${paths.join(', ')} (not Developer ID signed or notarized)`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
