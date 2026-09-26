// Statistics lesson: the central limit theorem with seeded random trials.
export default async function (h) {
  const { p } = h;
  await h.caption('Statistics: why do averages make bell curves?');
  await h.wait(1000);
  await h.click(p.locator('.chip:has-text("bell curves")'));
  await h.wait(1600);

  await h.caption('One die: 3000 rolls, every face equally likely — flat');
  await h.hover(h.obj('graph'), 1600);
  await h.caption('Average 2, 5, 30 dice at a time and watch the shape');
  await h.slide(h.obj('variable', 'Dice per average'), [2, 5, 12, 30]);
  await h.hover(h.obj('graph'), 1400);
  await h.caption('Seeded: the whole class sees the same sample. 🎲 draws a fresh one');
  await h.click(h.obj('trials').locator('button:has-text("🎲")'));
  await h.wait(700);
  await h.click(h.obj('trials').locator('button:has-text("🎲")'));
  await h.wait(900);

  await h.caption('Prediction: averaging more dice narrows the spread. Test it.');
  await h.click(p.locator('.suggest-item button:has-text("Test it")'));
  await h.wait(1800);
  await h.key('Escape');
  await h.caption('Supported — and it matches the theory: σ/√n');
  await h.hover(h.obj('experiment').locator('table'), 2200);
  await h.hover(h.obj('formula', 'Predicted spread'), 1600);
  await h.caption('');
  await h.wait(600);
}
