import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
const pg = await ctx.newPage();
await pg.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(500);
const lib = await pg.evaluate(() => {
  const h = document.querySelector('header');
  return [...h.querySelectorAll('button, input, img')].filter(e => e.getBoundingClientRect().width > 0)
    .map(k => `${k.tagName}.${(k.textContent||k.alt||'').trim().slice(0,12)} top=${Math.round(k.getBoundingClientRect().top)} w=${Math.round(k.getBoundingClientRect().width)}`);
});
console.log('LIBRARY HEADER:'); lib.forEach(x => console.log(' ', x));
await pg.locator('.aspect-video').first().tap();
await pg.waitForSelector('header h1', { timeout: 5000 });
await pg.waitForTimeout(400);
const pl = await pg.evaluate(() => {
  const h = document.querySelector('header');
  return [...h.querySelectorAll('button, h1, span')].filter(e => e.getBoundingClientRect().width > 0)
    .map(k => `${k.tagName}.${(k.textContent||'').trim().slice(0,14)} top=${Math.round(k.getBoundingClientRect().top)} right=${Math.round(k.getBoundingClientRect().right)}`);
});
console.log('PLAYER HEADER:'); pl.forEach(x => console.log(' ', x));
await b.close();
