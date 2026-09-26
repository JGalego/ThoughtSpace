// Maths lesson: build a square wave from sines, and discover the Gibbs phenomenon by
// testing the natural prediction that enough terms remove the bump.
export default async function (h) {
  const { p } = h;
  await h.caption('Maths: can smooth sine waves build a square wave?');
  await h.wait(1000);
  await h.click(p.locator('.chip:has-text("square wave")'));
  await h.wait(1600);

  await h.caption('A live sum of n sines, typeset as you build it');
  await h.hover(h.obj('formula', 'Sum of n sines'), 1600);
  await h.caption('Add terms: the corners sharpen…');
  await h.slide(h.obj('variable', 'Number of sine terms'), [5, 10, 20, 40]);
  await h.hover(h.obj('graph'), 1400);
  await h.caption('…but the bump at the jump stays about 9% high');
  await h.hover(h.obj('formula', 'Overshoot'), 1800);

  await h.caption('Prediction: with 50 terms the bump disappears. Test it.');
  await h.click(p.locator('.suggest-item button:has-text("Test it")'));
  await h.wait(1800);
  await h.key('Escape');
  await h.caption('Refuted: the Gibbs phenomenon — more terms squeeze the bump, never remove it');
  await h.hover(h.obj('experiment').locator('table'), 2800);
  await h.caption('');
  await h.wait(600);
}
