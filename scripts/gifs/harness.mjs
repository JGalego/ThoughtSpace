// Shared harness for the demo GIFs: drives the real UI in Chromium with a visible cursor
// and a caption pill, and captures timestamped frames while the scenario runs.

import fs from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

export async function session({ out, model = 'offline', url = 'http://localhost:5173/', width = 1280, height = 800 }) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`console ${m.text()}`));
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
  await p.goto(url);
  await p.evaluate((m) => {
    localStorage.clear();
    localStorage.setItem('thoughtspace.settings.v2', JSON.stringify(m === 'offline' ? { provider: 'offline' } : { provider: 'openai', models: { openai: m } }));
  }, model);
  await p.reload();
  await p.waitForTimeout(600);

  // frame capture runs alongside the scenario
  let recording = true;
  let n = 0;
  const meta = [];
  const capture = (async () => {
    while (recording) {
      const t = Date.now();
      const f = `${out}/${String(n).padStart(5, '0')}.png`;
      await p.screenshot({ path: f });
      meta.push({ f, t, busy: (await p.$('.status')) !== null });
      n++;
    }
  })();

  const h = {
    p,
    width,
    height,
    caption: (t) => p.evaluate((t) => { const c = document.getElementById('__caption'); c.textContent = t; c.style.opacity = t ? '1' : '0'; }, t),
    wait: (ms) => p.waitForTimeout(ms),
    moveTo: (x, y, steps = 18) => p.mouse.move(x, y, { steps }),
    inView: (bb) => bb && bb.x >= 0 && bb.y >= 40 && bb.x + bb.width <= width && bb.y + bb.height <= height,
    async fit() {
      const fb = await p.locator('.zoombar button:has-text("fit")').boundingBox();
      await h.moveTo(fb.x + fb.width / 2, fb.y + fb.height / 2);
      await p.mouse.down();
      await p.mouse.up();
      await p.waitForTimeout(700);
    },
    async click(loc, { at = [0.5, 0.5] } = {}) {
      let bb = await loc.boundingBox();
      if (!h.inView(bb)) {
        await h.fit();
        bb = await loc.boundingBox();
      }
      await h.moveTo(bb.x + bb.width * at[0], bb.y + bb.height * at[1]);
      await p.waitForTimeout(150);
      await p.mouse.down();
      await p.waitForTimeout(80);
      await p.mouse.up();
      await p.waitForTimeout(250);
    },
    async hover(loc, ms = 900) {
      const bb = await loc.boundingBox();
      await h.moveTo(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await p.waitForTimeout(ms);
    },
    /** vertical drag, e.g. on a network edge (weight) */
    async dragY(loc, dys, pause = 35) {
      const bb = await loc.boundingBox();
      const x = bb.x + bb.width / 2;
      const y0 = bb.y + bb.height / 2;
      await h.moveTo(x, y0);
      await p.mouse.down();
      let y = y0;
      for (const dy of dys) {
        const steps = Math.max(1, Math.round(Math.abs(dy) / 5));
        for (let i = 1; i <= steps; i++) {
          await p.mouse.move(x, y + (dy * i) / steps);
          await p.waitForTimeout(pause);
        }
        y += dy;
      }
      await p.mouse.up();
    },
    async draw(pts, pause = 1000) {
      await h.moveTo(pts[0][0], pts[0][1], 12);
      await p.mouse.down();
      for (const [x, y] of pts.slice(1)) {
        await p.mouse.move(x, y);
        await p.waitForTimeout(12);
      }
      await p.mouse.up();
      await p.waitForTimeout(pause);
    },
    async say(text) {
      await h.click(p.locator('.bar input'));
      await p.keyboard.type(text, { delay: 26 });
      await p.waitForTimeout(250);
      await p.keyboard.press('Enter');
      await p.waitForSelector('.status', { state: 'attached', timeout: 5000 }).catch(() => {});
      await p.waitForSelector('.status', { state: 'detached', timeout: 600000 });
      await p.waitForTimeout(1600);
    },
    async key(k, ms = 250) {
      await p.keyboard.press(k);
      await p.waitForTimeout(ms);
    },
    obj: (kind, text) => (text ? p.locator(`.obj.kind-${kind}`, { hasText: text }).first() : p.locator(`.obj.kind-${kind}`).first()),
    async shot(path) {
      await p.screenshot({ path });
    },
    async done() {
      recording = false;
      await capture;
      fs.writeFileSync(`${out}/frames.json`, JSON.stringify(meta));
      await browser.close();
      return { frames: meta.length, seconds: meta.length ? (meta.at(-1).t - meta[0].t) / 1000 : 0, errors };
    },
  };
  return h;
}
