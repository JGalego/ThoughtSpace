// Open lesson, any subject: type the mathematics and get something to play with.
// Sliders appear for every unknown, the formula is live, the curve can be dragged,
// predictions become experiments, and "what if" branches.
export default async function (h) {
  const { p } = h;
  await h.caption('Any subject: just type the mathematics');
  await h.wait(1000);
  await h.say('y = a*sin(b*x) + c');
  await h.caption('A slider for every unknown, a live formula and its curve');
  await h.slide(h.obj('variable', 'a'), [3, 1.5]);
  await h.slide(h.obj('variable', 'b'), [3, 2]);
  await h.slide(h.obj('variable', 'c'), [4, 2]);
  await h.dragAlong(h.obj('graph').locator('svg.chart'), [0.5, 0.8, 0.6]);

  await h.caption('Write a prediction in words — it becomes an experiment');
  await h.say('test: y increases as c increases');
  await h.key('Escape');
  await h.hover(h.obj('experiment').locator('table'), 1800);

  await h.caption('What if? A branch keeps the original and compares');
  await h.say('what if b = 4');
  await h.hover(h.obj('comparison'), 2400);
  await h.caption('');
  await h.wait(600);
}
