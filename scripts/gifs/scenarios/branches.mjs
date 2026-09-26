// Branching: explore an alternative without losing the original — object variants that
// carry their assumption, a live comparison, and whole-workspace forks you can diff.
export default async function (h) {
  const { p } = h;
  await h.caption('Branches: explore alternatives, keep the history');
  await h.wait(1000);
  await h.click(p.locator('.chip:has-text("XOR")'));
  await h.wait(1200);

  await h.caption('Give the neuron a hidden layer and train it');
  const net = h.obj('neural_network');
  await h.click(net.locator('button[title^="add a hidden layer"]'));
  await h.wait(900);
  await h.click(net.locator('.btn.primary'));
  await h.wait(1400);

  await h.caption('"What if we used ReLU?" — a branch beside the original, assumption recorded');
  await h.click(net.locator('.obj-head'));
  await h.say('What if we used relu?');

  await h.caption('Compare the branches — live, side by side');
  await h.click(p.locator('.suggest-item button:has-text("Compare")').first());
  await h.wait(2200);
  await h.hover(h.obj('comparison'), 1800);

  await h.caption('Or fork the whole workspace: a timeline with an explicit parent');
  await p.keyboard.press('Escape');
  await h.click(p.locator('.topbar .tb-btn:has-text("main")'));
  await p.locator('.pop input').nth(0).fill('sigmoid-world');
  await p.locator('.pop input').nth(1).fill('what if the hidden units were sigmoid?');
  await h.wait(900);
  await h.click(p.locator('.pop button:has-text("Fork")'));
  await h.wait(800);

  await h.caption('Change something in the fork…');
  await h.click(net.locator('.obj-head'));
  await h.wait(600);
  await p.locator('.inspector select').first().selectOption('sigmoid');
  await h.wait(1200);

  await h.caption('…and diff it against main: what changed, from which common ancestor');
  await h.click(p.locator('.topbar .tb-btn:has-text("sigmoid-world")'));
  await h.wait(700);
  await h.click(p.locator('.pop .item:has-text("main") button'));
  await h.wait(2600);

  await h.caption('Switch back: main is untouched');
  await h.click(p.locator('.inspector .close'));
  await h.click(p.locator('.topbar .tb-btn:has-text("sigmoid-world")'));
  await h.wait(500);
  await h.click(p.locator('.pop .item:has-text("main") span').first());
  await h.wait(2000);
  await h.caption('');
  await h.wait(600);
}
