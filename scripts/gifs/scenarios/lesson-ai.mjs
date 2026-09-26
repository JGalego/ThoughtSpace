// An open lesson built live by a language model from the generic building blocks, in a
// subject with no template: the teacher asks, the class plays, the prediction is tested.
export const model = 'gpt-5.5';
export default async function (h) {
  const { p } = h;
  await h.caption('Any subject, built live by the in-app AI (no template)');
  await h.wait(800);
  await h.say('I teach chemistry. Build a lesson on radioactive decay and half-life my students can play with.');
  await h.fit();
  await h.caption('Sliders, live formulas, a plot and a prediction for the class');
  const vars = p.locator('.obj.kind-variable');
  await h.slide(vars.nth(1), [await vars.nth(1).locator('input.slider').evaluate((el) => Number(el.max) * 0.8), await vars.nth(1).locator('input.slider').evaluate((el) => Number(el.max) * 0.3)]);
  await h.slide(vars.nth(2), [await vars.nth(2).locator('input.slider').evaluate((el) => Number(el.max) * 0.9)]);
  await h.wait(800);
  await h.caption('The class tests its prediction: the kernel computes the verdict');
  await h.say('The class predicts the answer. Test the prediction.');
  await h.key('Escape');
  await h.fit();
  const exp = p.locator('.obj.kind-experiment').last();
  if (await exp.count()) await h.hover(exp.locator('table'), 3000);
  await h.caption('');
  await h.wait(800);
}
