const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
app
  .whenReady()
  .then(async () => {
    const svg = readFileSync(process.argv[2], 'utf8').replace(
      'width="512" height="512"',
      'width="1024" height="1024"',
    );
    const window = new BrowserWindow({
      width: 1024,
      height: 1024,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
      },
    });
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const image = await window.webContents.capturePage();
    writeFileSync(process.argv[3], image.toPNG());
    app.quit();
  })
  .catch(() => app.exit(1));
