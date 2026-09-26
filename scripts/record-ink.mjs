// Records the drawing demo (MODEL=offline for the deterministic planner): drives the real UI (with the configured in-app AI) and captures
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
await p.evaluate((m) => { localStorage.clear(); localStorage.setItem('thoughtspace.settings.v2', JSON.stringify(m === 'offline' ? { provider: 'offline' } : { provider: 'openai', models: { openai: m } })); }, MODEL);
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

const draw = async (pts, pause = 1100) => { await moveTo(pts[0][0], pts[0][1], 12); await p.mouse.down(); for (const [x, y] of pts.slice(1)) { await p.mouse.move(x, y); await p.waitForTimeout(12); } await p.mouse.up(); await p.waitForTimeout(pause); };
const lineAcross = (bb, a, c, n = 22) => Array.from({ length: n }, (_, i) => [bb.x + bb.width * (a[0] + (c[0] - a[0]) * i / (n - 1)), bb.y + bb.height * (a[1] + (c[1] - a[1]) * i / (n - 1))]);
const tapKey = async (k) => { await p.keyboard.press(k); await p.waitForTimeout(250); };

await caption('Claude is drawing on ThoughtSpace');
await p.waitForTimeout(1200);
await caption('1 · Start with an idea');
await say("Let's understand why XOR requires a hidden layer.");

await caption('2 · Pick up the pen (P)');
await clickEl(p.locator('.tb-btn:has-text("Draw")'));
await p.waitForTimeout(600);
const plot = p.locator('.obj.kind-graph .plot').first();
let gb = await plot.boundingBox();
await caption('3 · Draw the boundary you want — the neuron adopts it');
await draw(lineAcross(gb, [0.1, 0.55], [0.75, 0.05]));
await draw(lineAcross(gb, [0.3, 0.95], [0.95, 0.3]));
await caption('…every straight line leaves a corner on the wrong side');
await draw(lineAcross(gb, [0.5, 0.02], [0.5, 0.98]), 1600);

await caption('4 · Coloured ink on data is data: orange = class 1, blue = class 0');
await clickEl(p.locator('.swatch').nth(1));
const dplot = p.locator('.obj.kind-dataset .plot');
const db = await dplot.boundingBox();
await draw([[db.x + db.width * 0.5, db.y + db.height * 0.5], [db.x + db.width * 0.5 + 1, db.y + db.height * 0.5]], 900);
await clickEl(p.locator('.swatch').nth(2));
await draw([[db.x + db.width * 0.18, db.y + db.height * 0.5], [db.x + db.width * 0.18 + 1, db.y + db.height * 0.5]], 1200);

await caption('5 · Everything else stays ink, attached to what it was drawn on');
await clickEl(p.locator('.swatch').nth(0));
gb = await plot.boundingBox();
const qx = gb.x + gb.width + 34, qy = gb.y + 40;
const q = Array.from({ length: 26 }, (_, i) => { const t = -Math.PI * 0.9 + (i / 25) * Math.PI * 1.45; return [qx + 16 * Math.cos(t), qy + 16 * Math.sin(t)]; });
await draw([...q, [qx + 2, qy + 28], [qx + 1, qy + 40]], 250);
await draw([[qx + 1, qy + 54], [qx + 2, qy + 55]], 1400);

await caption('6 · A loop selects: circle the network and its plot…');
const nb = await p.locator('.obj.kind-neural_network').first().boundingBox();
gb = await p.locator('.obj.kind-graph').first().boundingBox();
const cx = (nb.x + gb.x + gb.width) / 2, cy = (nb.y + gb.y + gb.height) / 2, rx = (gb.x + gb.width - nb.x) / 2 + 26, ry = Math.max(nb.height, gb.height) / 2 + 30;
await draw(Array.from({ length: 60 }, (_, i) => [cx + rx * Math.cos(-Math.PI / 2 + i / 55 * 2 * Math.PI), cy + ry * Math.sin(-Math.PI / 2 + i / 55 * 2 * Math.PI)]), 800);
await tapKey('Escape');
await clickEl(p.locator('.obj.kind-neural_network .obj-head').first());
await caption('…and ask about "this" — the AI answers with objects and its own ink');
await say("Why doesn't this one work?");
await caption('ThoughtSpace — ink that means something');
await p.waitForTimeout(3000);
await p.screenshot({ path: `${SP}/r-ink.png` });

recording = false; await capture;
fs.writeFileSync(`${SP}/frames.json`, JSON.stringify(meta));
console.log('frames', meta.length, 'seconds', ((meta.at(-1).t - meta[0].t) / 1000).toFixed(0));
console.log(errs.join('\n') || 'no errors');
await b.close();
