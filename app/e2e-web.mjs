import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
const pg = await ctx.newPage();
const log = [];
const ok = (n, c) => log.push(`${c ? 'PASS' : 'FAIL'} ${n}`);
const KEY = '32215ea5055b9b66fdce15d8692748b843cdff00537dd98e';

await pg.goto('http://localhost:4180/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(800);

// first-run: sync key prompt auto-opens
const prompt = await pg.evaluate(() => document.body.innerText);
ok('web first-run asks for sync key', prompt.includes('sync key') && prompt.includes('One-time setup'));
ok('library empty before key (no sync)', prompt.includes('shelf is empty'));
await pg.screenshot({ path: '/tmp/web-first-run.png' });

// manifest + icons served
const man = await pg.evaluate(async () => (await fetch('./manifest.webmanifest')).json());
ok('manifest served, PWA name + icons', man.name === 'VidShelf' && man.icons.length === 3);
ok('icon-512 served', await pg.evaluate(async () => (await fetch('./icon-512.png')).status === 200));

// enter key -> sync pulls his real library
await pg.fill('input[placeholder="Paste your sync key"]', KEY);
await pg.getByRole('button', { name: 'Sync now' }).click();
await pg.waitForSelector('text=Synced -', { timeout: 10000 });
await pg.click('text=Close');
await pg.waitForTimeout(800);
const titles = await pg.evaluate(() => document.body.innerText);
ok('library synced from cloud (Hanuman Ansh present)', titles.includes('Hanuman Ansh'));
await pg.screenshot({ path: '/tmp/web-synced.png' });

// key persisted for next visit
await pg.reload({ waitUntil: 'networkidle' });
await pg.waitForTimeout(800);
const again = await pg.evaluate(() => document.body.innerText);
ok('no prompt on second visit, library loads', !again.includes('One-time setup') && again.includes('Hanuman Ansh'));

// add-entry flow works on web (writes to his real library, then clean up)
await pg.click('text=+ Add');
await pg.waitForSelector('text=Custom thumbnail', { timeout: 5000 });
await pg.fill('input[placeholder="Movie night: Interstellar"]', 'E2E web test');
await pg.fill('input[placeholder*="youtube.com"]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
await pg.getByRole('button', { name: 'Add to shelf', exact: true }).click();
await pg.waitForSelector('text=E2E web test', { timeout: 5000 });
ok('add entry works on web', true);
await pg.waitForTimeout(3500); // debounced push
// cleanup: delete it again (tombstone syncs)
await pg.goto('http://localhost:4180/#/');
await pg.waitForTimeout(400);
await pg.evaluate(() => {
  const KEY2 = 'vidshelf.library.v1', TOMB = 'vidshelf.tombstones.v1', DIRTY = 'vidshelf.dirty.v1';
  const all = JSON.parse(localStorage.getItem(KEY2) ?? '[]');
  const test = all.filter((e) => /^E2E/.test(e.title));
  const keep = all.filter((e) => !/^E2E/.test(e.title));
  const tombs = JSON.parse(localStorage.getItem(TOMB) ?? '{}');
  const dirty = new Set(JSON.parse(localStorage.getItem(DIRTY) ?? '[]'));
  for (const e of test) { tombs[e.id] = Date.now(); dirty.add(e.id); }
  localStorage.setItem(KEY2, JSON.stringify(keep));
  localStorage.setItem(TOMB, JSON.stringify(tombs));
  localStorage.setItem(DIRTY, JSON.stringify([...dirty]));
});
await pg.reload({ waitUntil: 'networkidle' });
await pg.waitForTimeout(6000);
const final = await pg.evaluate(() => JSON.parse(localStorage.getItem('vidshelf.library.v1') ?? '[]').map(e => e.title));
ok('E2E entry tombstoned, library clean', !final.some(t => /^E2E/.test(t)));

console.log(log.join('\n'));
await b.close();
process.exit(log.some(l => l.startsWith('FAIL')) ? 1 : 0);
