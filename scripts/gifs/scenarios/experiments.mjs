// Experiments and claims: an AI claim starts unverified, a seeded experiment tests it,
// the verdict is computed, the experiment reproduces bit-for-bit, and provenance shows why.
export default async function (h) {
  const { p } = h;
  await h.caption('Experiments: claims only count with evidence');
  await h.wait(1200);
  await h.click(p.locator('.chip:has-text("XOR")'));
  await h.wait(1400);

  await h.caption('The AI states a claim — it starts UNVERIFIED');
  await h.hover(h.obj('claim'), 1600);

  await h.caption('"Test it": a controlled experiment — one variable, constant everything else, 6 seeds');
  await h.click(p.locator('.suggest-item button:has-text("Test it")'));
  await h.wait(2200);

  await h.caption('Hypothesis, constants, per-seed loss curves, and a computed verdict');
  const exp = h.obj('experiment');
  await h.hover(exp.locator('table'), 1600);
  await h.hover(exp.locator('.pill').first(), 1400);

  await h.caption('The claim is now SUPPORTED — by the experiment, not by assertion');
  await h.hover(h.obj('claim'), 1800);

  await h.caption('Reproduce: re-run every seed and check the results hash');
  await h.click(exp.locator('button:has-text("Reproduce")'));
  await h.wait(1200);
  await h.click(exp.locator('button:has-text("Reproduce")'));
  await h.wait(1600);

  await h.caption('Provenance: who made it, from what, verified by which computation');
  await h.click(h.obj('claim').locator('.obj-head'));
  await h.wait(2600);
  await h.caption('');
  await h.wait(800);
}
