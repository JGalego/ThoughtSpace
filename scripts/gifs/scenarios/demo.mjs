// The canonical journey with a real model as the in-app AI (default gpt-5.5; needs
// OPENAI_API_KEY on the dev server). Waits on the model are sped up in the GIF.
export const model = 'gpt-5.5';

export default async function (h, { model }) {
  const { p } = h;
  const single = () => p.locator('.obj.kind-neural_network', { hasText: '2→1' }).first();
  await h.caption(`Claude is driving · the in-app AI is ${model}`);
  await h.wait(1500);
  await h.caption('1 · Start with an idea');
  await h.say("Let's understand why XOR requires a hidden layer.");

  await h.caption('2 · Hands on: drag a weight, watch the boundary move');
  await h.dragY(single().locator('.edge-hit').first(), [-120, 180, -60], 40);
  await h.wait(600);

  await h.caption('3 · Change the problem: click a point to relabel it (XOR → AND)');
  const pts = p.locator('.obj.kind-dataset .pt');
  if ((await pts.count()) >= 4) {
    await h.click(pts.nth(3));
    await h.wait(1200);
    await h.click(pts.nth(3));
    await h.wait(600);
  }

  await h.caption('4 · Train it (deterministic, seeded)');
  await h.click(single().locator('.btn.primary'));
  await h.wait(1500);

  await h.caption('5 · "Why doesn\'t this one work?" — with the network selected');
  await h.click(single().locator('.obj-head'));
  await h.say("Why doesn't this one work?");

  await h.caption('6 · "Show me the smallest change that makes it work."');
  await h.click(single().locator('.obj-head'));
  await h.say('Show me the smallest change that makes it work.');

  await h.caption('7 · Compare the branches');
  const cmp = p.locator('.suggest-item button:has-text("Compare branches")').first();
  if (await cmp.count()) {
    await h.click(cmp);
    await h.wait(1500);
  } else if (!(await p.$('.obj.kind-comparison'))) {
    await h.click(single().locator('.obj-head'));
    await h.say('Compare this with the working branch.');
  }

  await h.caption('8 · "Turn this into a reusable XOR network glyph."');
  await h.click(p.locator('.obj.kind-neural_network:has(.pill.ok)').last().locator('.obj-head'));
  await h.say('Turn this into a reusable XOR network glyph.');

  await h.caption('9 · Semantic zoom: out to the essence, in to every weight');
  const zb = (i) => p.locator('.zoombar button').nth(i);
  for (let i = 0; i < 3; i++) { await h.click(zb(0)); await h.wait(300); }
  await h.wait(1200);
  await h.click(zb(1));
  for (let i = 0; i < 3; i++) { await h.click(zb(2)); await h.wait(200); }
  await h.wait(1500);
  await h.click(zb(1));
  await h.wait(600);

  await h.caption('10 · The glyph keeps its construction — expand it');
  const g = p.locator('.obj.kind-glyph').first();
  if (await g.count()) {
    await h.click(g.locator('button:has-text("Expand")'));
    await h.wait(2200);
  }
  await h.caption('ThoughtSpace — think with the network as a living object');
  await h.wait(2500);
}
