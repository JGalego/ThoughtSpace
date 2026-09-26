// Glyphs: a working construction becomes a reusable, parameterised object that keeps its
// insides — expand it, tweak its knobs, and stamp out fresh copies from the library.
export default async function (h) {
  const { p } = h;
  await h.caption('Glyphs: abstraction that keeps the construction');
  await h.wait(1000);
  await h.click(p.locator('.chip'));
  await h.wait(1000);
  await h.click(h.obj('neural_network').locator('.obj-head'));
  await h.say('Show me the smallest change that makes it work.');

  await h.caption('"Turn this into a reusable XOR network glyph."');
  await h.click(p.locator('.obj.kind-neural_network.variant .obj-head'));
  await h.say('Turn this into a reusable XOR network glyph.');

  const g = h.obj('glyph');
  await h.caption('One object, exposed knobs, a live output — the data still flows in');
  await h.hover(g, 1600);

  await h.caption('Turn a knob: the inner network re-initialises…');
  const seed = g.locator('.glyph-params input[type=text]').last();
  await h.click(seed);
  await p.keyboard.press('Control+A');
  await p.keyboard.type('4', { delay: 60 });
  await p.keyboard.press('Enter');
  await h.wait(1000);
  await h.caption('…train the glyph: it trains what is inside');
  await h.click(g.locator('button:has-text("Train")'));
  await h.wait(1400);

  await h.caption('Expand: the whole construction is still there');
  await h.click(g.locator('button:has-text("Expand")'));
  await h.wait(2400);
  await h.click(g.locator('button:has-text("Collapse")'));
  await h.wait(900);

  await h.caption('Reuse it: new instances from the glyph library');
  await h.click(p.locator('.topbar .tb-btn:has-text("Glyphs")'));
  await h.wait(900);
  await h.click(p.locator('.pop .item').first());
  await h.wait(1600);
  await h.caption('');
  await h.wait(800);
}
