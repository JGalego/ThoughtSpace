// Physics lesson: which launch angle throws furthest? Sliders, a live formula, a
// simulated flight with drag, and a class prediction that an experiment settles —
// then air drag changes the answer.
export default async function (h) {
  const { p } = h;
  await h.caption('Physics: which angle throws a ball furthest?');
  await h.wait(1000);
  await h.click(p.locator('.chip:has-text("ball furthest")'));
  await h.wait(1600);

  await h.caption('Everything that matters is a slider — drag the launch angle');
  await h.slide(h.obj('variable', 'Launch angle'), [60, 15, 45]);
  await h.wait(600);

  await h.caption('…or drag along the curve itself: the range formula is live');
  await h.dragAlong(h.obj('graph', 'Range vs angle').locator('svg.chart'), [0.55, 0.85, 0.3, 0.52]);
  await h.wait(600);

  await h.caption('The class predicts 45° goes furthest. Test it.');
  await h.hover(h.obj('claim'), 1000);
  await h.click(p.locator('.suggest-item button:has-text("Test it")'));
  await h.wait(1800);
  await h.key('Escape');
  await h.caption('A controlled experiment: only the angle varies — prediction holds (no air)');
  await h.hover(h.obj('experiment').locator('table'), 2400);

  await h.caption('Now turn on air drag…');
  await h.slide(h.obj('variable', 'Air drag'), [0.05]);
  await h.hover(h.obj('graph', 'Path of the ball'), 1400);

  await h.caption('…and test the same prediction again');
  await h.say('test the prediction again');
  await h.caption('With drag, a lower angle wins: the claim is now REFUTED');
  await h.hover(p.locator('.obj.kind-experiment').last().locator('table'), 2600);
  await h.hover(h.obj('claim'), 2000);
  await h.caption('');
  await h.wait(600);
}
