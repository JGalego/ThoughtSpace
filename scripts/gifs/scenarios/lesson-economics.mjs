// Economics lesson: tax incidence. The intuition "whoever is charged pays" is tested and
// refuted; the slopes decide.
export default async function (h) {
  const { p } = h;
  await h.caption('Economics: sellers are charged a tax. Who really pays it?');
  await h.wait(1000);
  await h.click(p.locator('.chip:has-text("tax")'));
  await h.wait(1600);

  await h.caption('Demand, supply, and supply shifted up by the tax');
  await h.hover(h.obj('graph', 'The market'), 1800);
  await h.caption('The common intuition: sellers pay it all. Test it.');
  await h.hover(h.obj('claim'), 1200);
  await h.click(p.locator('.suggest-item button:has-text("Test it")'));
  await h.wait(1800);
  await h.key('Escape');
  await h.caption('Refuted: with these slopes buyers pay half, whatever the tax');
  await h.hover(h.obj('experiment').locator('table'), 2400);

  await h.caption('Make supply steeper (sellers less flexible)…');
  await h.slide(h.obj('variable', 'Supply slope'), [2, 4]);
  await h.caption('…and buyers pay less of it: the flexible side escapes the tax');
  await h.hover(h.obj('formula', "Buyers' share"), 2000);
  await h.slide(h.obj('variable', 'Demand slope'), [4]);
  await h.hover(h.obj('formula', "Buyers' share"), 1800);
  await h.caption('');
  await h.wait(600);
}
