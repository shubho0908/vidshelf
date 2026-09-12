import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const log = [];
const ok = (name, cond) => log.push(`${cond ? 'PASS' : 'FAIL'} ${name}`);

async function makePng(w, h, color) {
  const d = await pg.evaluate(([w, h, color]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  }, [w, h, color]);
  return Buffer.from(d.split(',')[1], 'base64');
}

await pg.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await pg.click('text=+ Add');
await pg.click('text=Playlist');
await pg.fill('input[placeholder="Movie night: Interstellar"]', 'E2E playlist');
const urlInputs = pg.locator('input[placeholder*="youtube.com"]');
await urlInputs.nth(0).fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
await pg.click('text=+ Add another video');
await urlInputs.nth(1).fill('https://www.youtube.com/watch?v=oHg5SJYRHA0');

// per-video thumb on video 2 (second compact ThumbField input)
const fileInputs = pg.locator('input[type="file"][accept="image/*"]');
const n = await fileInputs.count();
ok('entry + 2 per-video pickers present (3)', n === 3);
await fileInputs.nth(2).setInputFiles({ name: 'v2.png', mimeType: 'image/png', buffer: await makePng(1280, 720, '#247') });
await pg.waitForSelector('text=Custom thumbnail set', { timeout: 8000 });

await pg.getByRole('button', { name: 'Add to shelf', exact: true }).click();
await pg.waitForSelector('text=E2E playlist', { timeout: 5000 });

// open player, check the second row uses a blob thumb
await pg.getByRole('button', { name: 'Play', exact: true }).first().click();
await pg.waitForSelector('text=Up next', { timeout: 8000 });
await pg.waitForTimeout(700);
const rowBlobs = await pg.evaluate(() => document.querySelectorAll('img[src^="blob:"]').length);
ok('player list has custom thumb (blob)', rowBlobs >= 1);
await pg.screenshot({ path: '/tmp/e2e-playlist-thumb.png' });

// delete cascade: delete entry -> all its thumbs purged locally + queued for remote
await pg.click('text=Delete');
await pg.click('text=Confirm delete');
await pg.waitForTimeout(800);
const state = await pg.evaluate(() => {
  const q = JSON.parse(localStorage.getItem('vidshelf.thumbs.delete.v1') ?? '[]');
  return { queued: q };
});
ok('remote delete queued for entry+video thumbs', state.queued.length === 1);
const idbCount = await pg.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('vidshelf-thumbs', 1); r.onsuccess = () => res(r.result); r.onerror = rej; });
  return new Promise((res, rej) => { const t = db.transaction('thumbs').objectStore('thumbs').count(); t.onsuccess = () => res(t.result); t.onerror = rej; });
});
ok('IDB empty after entry delete (cascade)', idbCount === 0);

console.log(log.join('\n'));
await b.close();
process.exit(log.some(l => l.startsWith('FAIL')) ? 1 : 0);
