// Biology lesson: an SIR epidemic, vaccination, and herd immunity. The class tests a
// prediction, then a more contagious disease overturns it.
export default async function (h) {
  const { p } = h;
  await h.caption('Biology: how many people must be vaccinated to stop an epidemic?');
  await h.wait(1000);
  await h.click(p.locator('.chip:has-text("vaccinated")'));
  await h.wait(1600);

  await h.caption('The SIR model: three rates of change, simulated over a year');
  await h.hover(h.obj('system'), 1800);
  await h.caption('Vaccinate more people and watch the infection curve flatten');
  await h.slide(h.obj('variable', 'Fraction vaccinated'), [0.3, 0.5, 0.65, 0]);
  await h.hover(h.obj('graph', 'Over a year'), 1000);

  await h.caption('Prediction: vaccinating 60% is enough. Test it.');
  await h.hover(h.obj('claim'), 1000);
  await h.click(p.locator('.suggest-item button:has-text("Test it")'));
  await h.wait(1800);
  await h.key('Escape');
  await h.caption('Holds for R₀ = 2.5: the outbreak never takes off at 60%');
  await h.hover(h.obj('experiment').locator('table'), 2400);

  await h.caption('But measles is far more contagious: raise R₀');
  await h.slide(h.obj('variable', 'R₀'), [6]);
  await h.hover(h.obj('formula', 'Herd-immunity'), 1600);
  await h.caption('Test the same prediction again');
  await h.say('test the prediction again');
  await h.caption('Refuted: at R₀ = 6 the threshold is 83% — 60% no longer protects anyone');
  await h.hover(p.locator('.obj.kind-experiment').last().locator('table'), 2600);
  await h.caption('');
  await h.wait(600);
}
