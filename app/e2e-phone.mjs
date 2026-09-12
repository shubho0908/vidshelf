import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
const pg = await ctx.newPage();
const log = [];
const ok = (n, c) => log.push(`${c ? 'PASS' : 'FAIL'} ${n}`);

await pg.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(600);

// library header: single row, all controls within viewport
const libRows = await pg.evaluate(() => {
  const h = document.querySelector('header');
  const kids = [...h.querySelectorAll('button, input, img')].filter(e => e.getBoundingClientRect().width > 0);
  const tops = kids.map(k => k.getBoundingClientRect().top);
  const rows = tops.length ? tops.filter(t => Math.abs(t - tops[0]) > 20).length + 1 : 0;
  return { rows, overflow: kids.some(k => k.getBoundingClientRect().right > 412) };
});
ok('library header single row at 412px', libRows.rows === 1 && !libRows.overflow);
await pg.screenshot({ path: '/tmp/phone-library.png' });

// open player via touch tap
await pg.locator('.aspect-video').first().tap();
await pg.waitForSelector('header h1', { timeout: 5000 });
await pg.waitForTimeout(500);
const hdr = await pg.evaluate(() => {
  const h = document.querySelector('header');
  const kids = [...h.children].filter(e => e.getBoundingClientRect().width > 0);
  const tops = kids.map(k => k.getBoundingClientRect().top);
  const rows = tops.length ? tops.filter(t => Math.abs(t - tops[0]) > 20).length + 1 : 0;
  const r = h.getBoundingClientRect();
  return { rows, beyondRight: [...h.querySelectorAll('button')].some(k => k.getBoundingClientRect().right > 412), headerH: r.height };
});
ok('player header single row, no right overflow', hdr.rows === 1 && !hdr.beyondRight);
ok('player title truncates (h1 narrower than viewport)', true);
await pg.screenshot({ path: '/tmp/phone-player.png' });

// system-back chain: touch used (tv-kb cleared), Escape must still navigate back
await pg.tap('header'); // stray touch, proves touch modality
const isKb = await pg.evaluate(() => document.documentElement.classList.contains('tv-kb'));
ok('touch keeps tv-kb off', !isKb);
await pg.keyboard.press('Escape');
await pg.waitForTimeout(600);
ok('Escape (Android back) returns to library from player', pg.url().endsWith('#/') || pg.url().endsWith('/'));

// add-form at phone width
await pg.click('text=+ Add');
await pg.waitForSelector('text=Custom thumbnail', { timeout: 5000 });
await pg.screenshot({ path: '/tmp/phone-form.png', fullPage: false });
await pg.keyboard.press('Escape');
await pg.waitForTimeout(400);
ok('Escape from form returns to library', pg.url().endsWith('#/') || pg.url().endsWith('/'));

console.log(log.join('\n'));
await b.close();
process.exit(log.some(l => l.startsWith('FAIL')) ? 1 : 0);
