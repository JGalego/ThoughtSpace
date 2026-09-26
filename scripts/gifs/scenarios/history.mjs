// History and provenance: every change is an event — who made it and why — so you can
// inspect any object, see exactly what the AI sees, and step back through time.
export default async function (h) {
  const { p } = h;
  await h.caption('History: every change is an event, and nothing is lost');
  await h.wait(1000);
  await h.click(p.locator('.chip:has-text("XOR")'));
  await h.wait(1000);
  const net = h.obj('neural_network');
  await h.click(net.locator('button[title^="add a hidden layer"]'));
  await h.wait(500);
  await h.click(net.locator('.btn.primary'));
  await h.wait(1000);

  await h.caption('Inspect any object: parameters, provenance, relations, its own history');
  await h.click(net.locator('.obj-head'));
  await h.wait(1600);
  const ins = p.locator('.inspector');
  await ins.evaluate((el) => el.scrollTo({ top: 400, behavior: 'smooth' }));
  await h.wait(1600);

  await h.caption('…and exactly what the AI sees: semantics, not pixels');
  await h.click(ins.locator('h5:has-text("What the AI sees")'));
  await ins.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
  await h.wait(2400);

  await h.caption('✦ made by the AI · ● made by you — on every object');
  await h.click(ins.locator('.close'));
  await h.hover(p.locator('.prov-mark').first(), 1200);

  await h.caption('Undo walks back through the event log (⌘Z)…');
  await p.keyboard.press('Escape');
  for (let i = 0; i < 4; i++) { await h.click(p.locator('.topbar .tb-btn[title^="undo"]')); await h.wait(700); }
  await h.caption('…and redo replays it exactly (⇧⌘Z)');
  for (let i = 0; i < 4; i++) { await h.click(p.locator('.topbar .tb-btn[title^="redo"]')); await h.wait(700); }

  await h.caption('The branch menu keeps the whole timeline');
  await h.click(p.locator('.topbar .tb-btn:has-text("main")'));
  await h.wait(2600);
  await p.keyboard.press('Escape');
  await h.caption('');
  await h.wait(600);
}
