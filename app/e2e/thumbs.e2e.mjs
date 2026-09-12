import { chromium } from 'playwright';

const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const log = [];
const ok = (name, cond) => { log.push(`${cond ? 'PASS' : 'FAIL'} ${name}`); };

async function makePng(w, h, color) {
  const dataUrl = await pg.evaluate(([w, h, color]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, w, h);
    x.fillStyle = '#fff'; x.font = 'bold 60px sans-serif'; x.fillText(`${w}x${h}`, 60, h / 2);
    return c.toDataURL('image/png');
  }, [w, h, color]);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

await pg.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await pg.click('text=+ Add');
await pg.waitForSelector('text=Custom thumbnail', { timeout: 5000 });
ok('thumb section visible in form', true);

await pg.fill('input[placeholder="Movie night: Interstellar"]', 'E2E thumb test');
await pg.fill('input[placeholder*="youtube.com"]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

// 4:3 rejection
const png43 = await makePng(1024, 768, '#933');
await pg.setInputFiles('input[type="file"][accept="image/*"]', { name: 'wide43.png', mimeType: 'image/png', buffer: png43 });
await pg.waitForSelector('text=16:9', { timeout: 5000 });
const errText = await pg.textContent('.text-red-300');
ok('4:3 rejected with ratio msg', errText.includes('1024x768'));

// oversize source rejection (pad a buffer >1MB)
const big = Buffer.concat([png43, Buffer.alloc(1024 * 1024, 1)]);
await pg.setInputFiles('input[type="file"][accept="image/*"]', { name: 'big.png', mimeType: 'image/png', buffer: big });
await pg.waitForFunction(() => document.body.innerText.includes('limit is 1MB'), { timeout: 5000 });
ok('>1MB source rejected', true);

// 16:9 accept
const png169 = await makePng(1920, 1080, '#274');
await pg.setInputFiles('input[type="file"][accept="image/*"]', { name: 'wide.png', mimeType: 'image/png', buffer: png169 });
await pg.waitForSelector('text=Custom thumbnail set', { timeout: 8000 });
ok('16:9 accepted', true);

// IDB record exists and is small webp/jpeg
const rec = await pg.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('vidshelf-thumbs', 1); r.onsuccess = () => res(r.result); r.onerror = rej; });
  const all = await new Promise((res, rej) => { const t = db.transaction('thumbs').objectStore('thumbs').getAll(); t.onsuccess = () => res(t.result); t.onerror = rej; });
  return all.map((r) => ({ id: r.id, mime: r.mime, bytes: r.blob.size, v: r.v }));
});
ok('IDB thumb stored', rec.length === 1);
ok('output capped (<150KB): ' + (rec[0] && rec[0].bytes) + 'B ' + (rec[0] && rec[0].mime), rec[0] && rec[0].bytes <= 150 * 1024);

// save -> library card shows blob thumb
await pg.getByRole('button', { name: 'Add to shelf', exact: true }).click();
await pg.waitForSelector('text=E2E thumb test', { timeout: 5000 });
await pg.waitForTimeout(800);
const cardSrc = await pg.evaluate(() => {
  const img = document.querySelector('img[src^="blob:"]');
  return img ? img.src.slice(0, 12) : null;
});
ok('library card uses custom blob thumb', !!cardSrc);
await pg.screenshot({ path: '/tmp/e2e-thumb-card.png' });

// edit -> remove -> card falls back to auto thumb
await pg.click('text=Edit');
await pg.waitForSelector('text=Custom thumbnail', { timeout: 5000 });
await pg.click('text=Remove');
await pg.click('text=Save changes');
await pg.waitForTimeout(800);
const stillBlob = await pg.evaluate(() => !!document.querySelector('img[src^="blob:"]'));
ok('remove restores auto thumb', !stillBlob);
const recAfter = await pg.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('vidshelf-thumbs', 1); r.onsuccess = () => res(r.result); r.onerror = rej; });
  const all = await new Promise((res, rej) => { const t = db.transaction('thumbs').objectStore('thumbs').getAll(); t.onsuccess = () => res(t.result); t.onerror = rej; });
  return all.length;
});
ok('IDB purged after remove (cascade local)', recAfter === 0);

console.log(log.join('\n'));
await b.close();
process.exit(log.some(l => l.startsWith('FAIL')) ? 1 : 0);
