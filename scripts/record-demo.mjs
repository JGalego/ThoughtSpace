// Records the demo: drives the real UI (with the configured in-app AI) and captures
// timestamped frames. Needs the dev server running and Playwright available:
//   OPENAI_API_KEY=… npm run dev &
//   SP=/tmp/demo MODEL=gpt-5.5 node scripts/record-demo.mjs && python3 scripts/make-gif.py /tmp/demo docs/media/thoughtspace-demo.gif
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
import fs from 'node:fs';
const SP = process.env.SP, MODEL = process.env.MODEL || 'gpt-5.5', OUT = `${SP}/frames`;
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', e => errs.push('pageerror ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console ' + m.text()); });
await p.addInitScript(() => {
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;z-index:99999;pointer-events:none;transform:translate(-3px,-2px);transition:transform .05s';
    c.innerHTML = '<svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1 L1 17 L5.5 13 L8.5 20 L11 19 L8 12 L14 12 Z" fill="#1f1f1d" stroke="white" stroke-width="1.5"/></svg>';
    document.body.appendChild(c);
    window.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', () => (c.style.transform = 'translate(-3px,-2px) scale(.85)'), true);
    window.addEventListener('mouseup', () => (c.style.transform = 'translate(-3px,-2px)'), true);
    const cap = document.createElement('div');
    cap.id = '__caption';
    cap.style.cssText = 'position:fixed;left:50%;top:58px;transform:translateX(-50%);z-index:99998;pointer-events:none;background:#1f1f1d;color:#f6f5f1;font:500 14px -apple-system,Segoe UI,sans-serif;padding:7px 14px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.18);opacity:0;transition:opacity .3s;white-space:nowrap';
    document.body.appendChild(cap);
  });
});
await p.goto('http://localhost:5173/');
await p.evaluate((m) => { localStorage.clear(); localStorage.setItem('thoughtspace.settings.v2', JSON.stringify({ provider: 'openai', models: { openai: m } })); }, MODEL);
await p.reload(); await p.waitForTimeout(600);

// ---- frame capture loop
let recording = true, n = 0; const meta = [];
const capture = (async () => { while (recording) { const t = Date.now(); const f = `${OUT}/${String(n).padStart(5, '0')}.png`; await p.screenshot({ path: f }); meta.push({ f, t, busy: await p.$('.status') !== null }); n++; } })();

const caption = (t) => p.evaluate((t) => { const c = document.getElementById('__caption'); c.textContent = t; c.style.opacity = t ? '1' : '0'; }, t);
let mx = 640, my = 400;
const moveTo = async (x, y, steps = 18) => { await p.mouse.move(x, y, { steps }); mx = x; my = y; };
const inView = (bb) => bb && bb.x >= 0 && bb.y >= 40 && bb.x + bb.width <= 1280 && bb.y + bb.height <= 800;
const clickEl = async (loc) => { let bb = await loc.boundingBox(); if (!inView(bb)) { const f = p.locator('.zoombar button:has-text("fit")'); const fb = await f.boundingBox(); await moveTo(fb.x + fb.width / 2, fb.y + fb.height / 2); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(700); bb = await loc.boundingBox(); } await moveTo(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.waitForTimeout(150); await p.mouse.down(); await p.waitForTimeout(80); await p.mouse.up(); await p.waitForTimeout(250); };
const say = async (text) => {
  await clickEl(p.locator('.bar input'));
  await p.keyboard.type(text, { delay: 28 });
  await p.waitForTimeout(250);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.status', { state: 'attached', timeout: 5000 }).catch(() => {});
  await p.waitForSelector('.status', { state: 'detached', timeout: 600000 });
  await p.waitForTimeout(1800);
};
const net = (arch) => p.locator('.obj.kind-neural_network', { hasText: arch }).first();

await caption('Claude is driving · the in-app AI is OpenAI ' + MODEL);
await p.waitForTimeout(1500);
await caption('1 · Start with an idea');
await say("Let's understand why XOR requires a hidden layer.");
await p.screenshot({ path: `${SP}/r1.png` });

await caption('2 · Hands on: drag a weight, watch the boundary move');
const single = net('2→1');
const edge = single.locator('.edge-hit').first();
const eb = await edge.boundingBox();
await moveTo(eb.x + eb.width * 0.5, eb.y + eb.height * 0.5);
await p.mouse.down();
for (let i = 1; i <= 24; i++) { await p.mouse.move(eb.x + eb.width * 0.5, eb.y + eb.height * 0.5 - i * 5); await p.waitForTimeout(40); }
for (let i = 1; i <= 36; i++) { await p.mouse.move(eb.x + eb.width * 0.5, eb.y + eb.height * 0.5 - 120 + i * 6); await p.waitForTimeout(40); }
await p.mouse.up();
await p.waitForTimeout(600);

await caption('3 · Change the problem: click a point to relabel it (XOR → AND)');
const pts = p.locator('.obj.kind-dataset .pt');
if (await pts.count() >= 4) { await clickEl(pts.nth(3)); await p.waitForTimeout(1200); await clickEl(pts.nth(3)); await p.waitForTimeout(600); }

await caption('4 · Train it (deterministic, seeded)');
await clickEl(single.locator('.btn.primary'));
await p.waitForTimeout(1500);

await caption('5 · "Why doesn\'t this one work?" — with the network selected');
await clickEl(single.locator('.obj-head'));
await say("Why doesn't this one work?");
await p.screenshot({ path: `${SP}/r2.png` });

await caption('6 · "Show me the smallest change that makes it work."');
await clickEl(single.locator('.obj-head'));
await say('Show me the smallest change that makes it work.');
await p.screenshot({ path: `${SP}/r3.png` });

await caption('7 · Compare the branches');
const cmpBtn = p.locator('.suggest-item button:has-text("Compare branches")').first();
if (await cmpBtn.count()) { await clickEl(cmpBtn); await p.waitForTimeout(1500); }
else if (!(await p.$('.obj.kind-comparison'))) { await clickEl(single.locator('.obj-head')); await say('Compare this with the working branch.'); }
await p.screenshot({ path: `${SP}/r4.png` });

await caption('8 · "Turn this into a reusable XOR network glyph."');
const working = p.locator('.obj.kind-neural_network:has(.pill.ok)').last();
await clickEl(working.locator('.obj-head'));
await say('Turn this into a reusable XOR network glyph.');
await p.screenshot({ path: `${SP}/r5.png` });

await caption('9 · Semantic zoom: out to the essence, in to every weight');
for (let i = 0; i < 3; i++) { await clickEl(p.locator('.zoombar button').first()); await p.waitForTimeout(300); }
await p.waitForTimeout(1200);
await clickEl(p.locator('.zoombar button').nth(1));
for (let i = 0; i < 3; i++) { await clickEl(p.locator('.zoombar button').nth(2)); await p.waitForTimeout(200); }
await p.waitForTimeout(1500);
await clickEl(p.locator('.zoombar button').nth(1));
await p.waitForTimeout(600);

await caption('10 · The glyph keeps its construction — expand it');
const g = p.locator('.obj.kind-glyph').first();
if (await g.count()) { await clickEl(g.locator('button:has-text("Expand")')); await p.waitForTimeout(2200); }
await caption('ThoughtSpace — think with the network as a living object');
await p.waitForTimeout(2500);
await p.screenshot({ path: `${SP}/r6.png` });

recording = false; await capture;
fs.writeFileSync(`${SP}/frames.json`, JSON.stringify(meta));
console.log('frames', meta.length, 'seconds', ((meta.at(-1).t - meta[0].t) / 1000).toFixed(0));
console.log(errs.join('\n') || 'no errors');
await b.close();
