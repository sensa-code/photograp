/**
 * Draw the application icon and write it to build/icon.png.
 *
 * Run with `npm run icon`. Electron is already a dev dependency and it has a
 * real canvas, so it doubles as the rasteriser — no image library needed.
 * electron-builder turns this one PNG into the .ico and .icns it needs.
 */
const { app, BrowserWindow } = require('electron');
const { writeFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');

const SIZE = 512;

const DRAW = `(() => {
  const S = ${SIZE};
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');

  // Rounded square, the same navy as the favicon.
  const r = S * 0.22;
  x.beginPath();
  x.moveTo(r, 0);
  x.arcTo(S, 0, S, S, r);
  x.arcTo(S, S, 0, S, r);
  x.arcTo(0, S, 0, 0, r);
  x.arcTo(0, 0, S, 0, r);
  x.closePath();
  x.fillStyle = '#0b1a2b';
  x.fill();

  // Three stacked sheets behind the wordmark: the layer stack.
  x.globalAlpha = 0.2;
  x.fillStyle = '#3fa9f5';
  for (let i = 0; i < 3; i++) {
    const w = S * 0.46, h = S * 0.1;
    const cx = S * 0.5, cy = S * 0.3 + i * S * 0.075;
    x.beginPath();
    x.moveTo(cx, cy - h / 2);
    x.lineTo(cx + w / 2, cy);
    x.lineTo(cx, cy + h / 2);
    x.lineTo(cx - w / 2, cy);
    x.closePath();
    x.fill();
  }

  x.globalAlpha = 1;
  x.fillStyle = '#3fa9f5';
  x.font = '700 ' + Math.round(S * 0.4) + 'px "Segoe UI", Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'alphabetic';
  x.fillText('Pg', S / 2, S * 0.79);

  const url = c.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE });
  await win.loadURL('data:text/html,<meta charset="utf-8"><body></body>');
  const base64 = await win.webContents.executeJavaScript(DRAW);
  const out = join(__dirname, '..', 'build', 'icon.png');
  await mkdir(join(__dirname, '..', 'build'), { recursive: true });
  await writeFile(out, Buffer.from(base64, 'base64'));
  console.log(`wrote ${out} (${SIZE}x${SIZE})`);
  app.quit();
});
