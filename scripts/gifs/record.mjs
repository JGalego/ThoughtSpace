// Record demo GIFs of ThoughtSpace in use.
//   npm run dev &                                   (another terminal)
//   node scripts/gifs/record.mjs experiments         one scenario
//   node scripts/gifs/record.mjs all                 every scenario
//   MODEL=gpt-5.5 node scripts/gifs/record.mjs journey   (the in-app AI; needs OPENAI_API_KEY on the dev server)
// Needs Playwright (PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs if it isn't installed
// locally) and Python with Pillow. GIFs land in docs/media/thoughtspace-<name>.gif.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { session } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const names = process.argv[2] === 'all' || !process.argv[2]
  ? fs.readdirSync(path.join(here, 'scenarios')).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, ''))
  : process.argv.slice(2);

for (const name of names) {
  const scenario = await import(path.join(here, 'scenarios', `${name}.mjs`));
  const model = process.env.MODEL ?? scenario.model ?? 'offline';
  const out = path.join(process.env.GIF_TMP ?? path.join(os.tmpdir(), 'thoughtspace-gifs'), name);
  const h = await session({ out, model });
  try {
    await scenario.default(h, { model });
  } finally {
    const r = await h.done();
    console.log(`${name}: ${r.frames} frames, ${r.seconds.toFixed(0)} s${r.errors.length ? `\n  errors: ${r.errors.join('\n  ')}` : ''}`);
  }
  const gif = path.join(root, 'docs/media', `thoughtspace-${name}.gif`);
  const busy = model === 'offline' ? '>> the AI is working - sped up 5x' : `>> the in-app AI (${model}) is working - sped up 5x`;
  const py = spawnSync('python3', [path.join(root, 'scripts/make-gif.py'), out, gif, busy], { stdio: 'inherit' });
  if (py.status !== 0) process.exitCode = 1;
}
