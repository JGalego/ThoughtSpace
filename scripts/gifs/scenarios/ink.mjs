// Drawing: ink becomes meaning where it lands — a line across a single neuron's plot is its
// boundary, coloured dots are data, a loop selects, and everything else stays ink.
export default async function (h) {
  const { p } = h;
  const across = (bb, a, c, n = 22) => Array.from({ length: n }, (_, i) => [bb.x + bb.width * (a[0] + ((c[0] - a[0]) * i) / (n - 1)), bb.y + bb.height * (a[1] + ((c[1] - a[1]) * i) / (n - 1))]);
  await h.caption('Claude is drawing on ThoughtSpace');
  await h.wait(1200);
  await h.caption('1 · Start with an idea');
  await h.say("Let's understand why XOR requires a hidden layer.");

  await h.caption('2 · Pick up the pen (P)');
  await h.click(p.locator('.tb-btn:has-text("Draw")'));
  await h.wait(600);
  const plot = p.locator('.obj.kind-graph .plot').first();
  let gb = await plot.boundingBox();
  await h.caption('3 · Draw the boundary you want — the neuron adopts it');
  await h.draw(across(gb, [0.1, 0.55], [0.75, 0.05]));
  await h.draw(across(gb, [0.3, 0.95], [0.95, 0.3]));
  await h.caption('…every straight line leaves a corner on the wrong side');
  await h.draw(across(gb, [0.5, 0.02], [0.5, 0.98]), 1600);

  await h.caption('4 · Coloured ink on data is data: orange = class 1, blue = class 0');
  await h.click(p.locator('.swatch').nth(1));
  const db = await p.locator('.obj.kind-dataset .plot').boundingBox();
  await h.draw([[db.x + db.width * 0.5, db.y + db.height * 0.5], [db.x + db.width * 0.5 + 1, db.y + db.height * 0.5]], 900);
  await h.click(p.locator('.swatch').nth(2));
  await h.draw([[db.x + db.width * 0.18, db.y + db.height * 0.5], [db.x + db.width * 0.18 + 1, db.y + db.height * 0.5]], 1200);

  await h.caption('5 · Everything else stays ink, attached to what it was drawn on');
  await h.click(p.locator('.swatch').nth(0));
  gb = await plot.boundingBox();
  const qx = gb.x + gb.width + 34, qy = gb.y + 40;
  const q = Array.from({ length: 26 }, (_, i) => { const t = -Math.PI * 0.9 + (i / 25) * Math.PI * 1.45; return [qx + 16 * Math.cos(t), qy + 16 * Math.sin(t)]; });
  await h.draw([...q, [qx + 2, qy + 28], [qx + 1, qy + 40]], 250);
  await h.draw([[qx + 1, qy + 54], [qx + 2, qy + 55]], 1400);

  await h.caption('6 · A loop selects: circle the network and its plot…');
  const nb = await p.locator('.obj.kind-neural_network').first().boundingBox();
  gb = await p.locator('.obj.kind-graph').first().boundingBox();
  const cx = (nb.x + gb.x + gb.width) / 2, cy = (nb.y + gb.y + gb.height) / 2;
  const rx = (gb.x + gb.width - nb.x) / 2 + 26, ry = Math.max(nb.height, gb.height) / 2 + 30;
  await h.draw(Array.from({ length: 60 }, (_, i) => [cx + rx * Math.cos(-Math.PI / 2 + (i / 55) * 2 * Math.PI), cy + ry * Math.sin(-Math.PI / 2 + (i / 55) * 2 * Math.PI)]), 800);
  await h.key('Escape');
  await h.click(p.locator('.obj.kind-neural_network .obj-head').first());
  await h.caption('…and ask about "this" — the AI answers with objects and its own ink');
  await h.say("Why doesn't this one work?");
  await h.caption('ThoughtSpace — ink that means something');
  await h.wait(3000);
}
