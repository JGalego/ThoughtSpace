// Direct manipulation: the network is a living object — probe it with data, drag its
// weights, change the problem, train it, scrub through training, find what is fragile.
export default async function (h) {
  const { p } = h;
  await h.caption('Hands on: the network is a living object');
  await h.wait(1000);
  await h.click(p.locator('.chip:has-text("XOR")'));
  await h.wait(1200);

  await h.caption('Hover a data point: the network lights up with its activations');
  const pts = h.obj('dataset').locator('.pt');
  for (let i = 0; i < 4; i++) await h.hover(pts.nth(i), 700);

  await h.caption('Drag weights and biases: the boundary and the equation follow');
  const net = h.obj('neural_network');
  await h.dragY(net.locator('.edge-hit').nth(0), [-70, 30]);
  await h.dragY(net.locator('.edge-hit').nth(1), [60, -20]);
  await h.dragY(net.locator('.neuron').last(), [-40]);
  await h.wait(600);

  await h.caption('Change the problem: click points to turn XOR into AND');
  await h.click(pts.nth(1));
  await h.wait(400);
  await h.click(pts.nth(2));
  await h.wait(900);

  await h.caption('Train it: on AND, a single neuron converges');
  await h.click(net.locator('.btn.primary'));
  await h.wait(1400);

  await h.caption('Scrub through training: the boundary at every epoch');
  const run = h.obj('simulation');
  const slider = run.locator('input[type=range]');
  const sb = await slider.boundingBox();
  await h.moveTo(sb.x + sb.width - 4, sb.y + sb.height / 2);
  await p.mouse.down();
  for (let i = 0; i <= 30; i++) { await p.mouse.move(sb.x + sb.width - 4 - (i / 30) * (sb.width - 8), sb.y + sb.height / 2); await h.wait(45); }
  for (let i = 0; i <= 30; i++) { await p.mouse.move(sb.x + 4 + (i / 30) * (sb.width - 8), sb.y + sb.height / 2); await h.wait(45); }
  await p.mouse.up();

  await h.caption('Which weight is fragile? A sweep shows loss and accuracy as it moves');
  await h.click(net.locator('.obj-head'));
  await h.say('How sensitive is this network to its weights?');
  await h.wait(1200);
  await h.caption('');
  await h.wait(600);
}
