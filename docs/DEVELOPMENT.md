# Development

验证目标：macOS arm64、Bun 1.4.2、Node 24.14.0、Electron 44.5.1（内置 Node 24.21.0 / SQLite 3.53.4）。宿主 Bun 的 node:sqlite 亦通过 smoke；不要换成 Bun-only DB driver。

```sh
bun install --frozen-lockfile
bun run dev
```

main/preload 编辑后重启 dev command；renderer 有 HMR。`bun run build && bun run start` 启动生产资源。生产 App 没有 localhost server。

## Gates

```sh
bun run typecheck
bun run lint
bun run format:check
bun test
bun run security:audit
bun run build
bun run test:e2e
bun run package
```

Bun discovers `*.test.ts(x)`；Electron E2E 用 `*.e2e.ts` 避免被 Bun 当作 Playwright specs。E2E 使用安装的 Electron executable，native dialogs 仅在测试进程内 mock。输出/screenshots/trace 位于 `output/playwright`、`test-results`、`playwright-report`，均被 gitignore。

验证 packaged App：

```sh
PROSPERO_PACKAGED_APP="$PWD/release/Prospero-darwin-arm64/Prospero.app/Contents/MacOS/Prospero" \
  bunx playwright test tests/e2e/macos.e2e.ts tests/e2e/notifications.e2e.ts tests/e2e/v02-action-web.e2e.ts \
  --grep 'native menus|native context|native notification|multi-root|deny and stale|partial native|Stop and abrupt'
```

v0.2 的 Web E2E 使用仅测试入口 `tests/e2e/web-bootstrap.cjs`：在加载相同生产 main bundle 前，仅把两个 fixture domains 的 DNS/HTTPS I/O 接到本地 fake server。它不进入 build 或 ASAR；测试不调用真实 Brave。提供 `PROSPERO_PACKAGED_APP` 时，这两个 Web 场景仍使用测试入口，不能算作签名包 Web E2E。上述过滤命令验收最终包的四项文件动作和三项原生行为。最终包的搜索凭据 round-trip 尚未独立验收。

`PROSPERO_USER_DATA` 可显式指定隔离 profile，用于 smoke/debug；默认 profile 由 Electron `app.getPath('userData')` 管理。禁止把测试指向用户真实 profile。

## Credential development fallback

Development app 可使用 `PROSPERO_API_KEY`，但必须同时给定 `PROSPERO_BASE_URL`；只对 normalized URL 完全匹配的 provider 生效。Packaged GUI 永不读取该 fallback。不要 echo、写入配置文件或日志。真实 provider smoke 需三个变量：

```sh
bun run smoke:real
```

需要 `PROSPERO_API_KEY`、`PROSPERO_BASE_URL`、`PROSPERO_MODEL` 已安全注入环境。没有则报告 `BLOCKED — real provider credential unavailable` 并零 network call；有则只做 connection 检测与短 streaming，最多三次 HTTP request。不运行真实工具。

## Packaging

`@electron/packager` 创建 macOS arm64 `.app`，bundle id `app.prospero.desktop`，ASAR 包含编译产物。项目自有 SVG 转成 `.icns`；脚本只使用 macOS 自带 `sips`/`iconutil` 与已安装 Electron，不安装系统软件。构建临时 staging 清理后仅保留 release App。

打包脚本使用本地 ad-hoc 签名并执行 deep/strict 验签。未配置 Developer ID、发布签名证书或 notarization；不要称其为 notarized release。稳定发布时需要一致的 signing identity，让 Keychain 访问与更新身份稳定。
