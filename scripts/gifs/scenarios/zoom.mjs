// Semantic zoom: the same object at different levels — a chip at a glance, every weight
// up close, then down through a neuron's equation to its scalar arithmetic.
export default async function (h) {
  const { p } = h;
  const zb = (i) => p.locator('.zoombar button').nth(i);
  await h.caption('Semantic zoom: one object, many levels');
  await h.wait(1000);
  await h.click(p.locator('.chip:has-text("XOR")'));
  await h.wait(1200);

  await h.caption('Zoom out: objects collapse to their essence');
  for (let i = 0; i < 3; i++) { await h.click(zb(0)); await h.wait(250); }
  await h.wait(1800);

  await h.caption('Zoom in: every weight and bias appears');
  await h.click(zb(1));
  for (let i = 0; i < 3; i++) { await h.click(zb(2)); await h.wait(250); }
  await h.wait(1800);
  await h.click(zb(1));
  await h.wait(600);

  await h.caption('Double-click a neuron: its equation, with live weights');
  const out = h.obj('neural_network').locator('.neuron').last();
  const bb = await out.boundingBox();
  await h.moveTo(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await p.mouse.dblclick(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await h.wait(1600);

  await h.caption('Zoom further: the scalar arithmetic for one input');
  await h.click(p.locator('.obj.kind-equation button:has-text("zoom")').last());
  await h.wait(1600);
  const sel = p.locator('.obj.kind-equation select').last();
  for (const v of ['0,0', '0,1', '1,1']) {
    await h.click(sel);
    await sel.selectOption(v);
    await h.wait(1100);
  }

  await h.caption('Change a weight: every level follows');
  await h.dragY(h.obj('neural_network').locator('.edge-hit').first(), [-90, 40]);
  await h.wait(1800);
  await h.caption('');
  await h.wait(600);
}
