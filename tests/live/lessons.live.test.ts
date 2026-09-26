// Live: can a real model build open lessons in subjects it has never seen here, from the
// generic building blocks alone, and then test a class's prediction? Skipped unless LIVE=1.
//   LIVE=1 OPENAI_API_KEY=… npx vitest run tests/live/lessons.live.test.ts
import { appendFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Kernel, isCalc, type ObjectId } from '../../src/kernel';
import { openaiAgent } from '../../src/agent/openai';
import type { AgentHost } from '../../src/agent/host';

const LIVE = !!process.env.LIVE && !!process.env.OPENAI_API_KEY;
const MODEL = process.env.LIVE_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-5.5';

const LESSONS: [string, string][] = [
  ['I teach chemistry. Build a lesson on radioactive decay and half-life that my students can play with.', 'My students predict that after two half-lives nothing is left. Test it.'],
  ['Build a lesson on the simple pendulum. Does the period depend on how far you pull it back?', 'The class thinks doubling the length doubles the period. Test that.'],
  ['Make a lesson comparing simple and compound interest for my personal finance class.', 'Test this prediction: after 30 years compound interest gives more than twice as much as simple interest.'],
  ['Predator and prey: foxes and rabbits. Build something my biology class can explore.', 'Students say more foxes at the start means fewer rabbits at the peak. Test it.'],
];

for (const [build, test] of LESSONS)
  it.skipIf(!LIVE)(`${MODEL}: ${build.slice(0, 60)}…`, async () => {
    const kernel = new Kernel();
    const selection: ObjectId[] = [];
    const log: string[] = [];
    let rejected = 0;
    const host: AgentHost = {
      kernel, selection: () => selection, focus: () => {}, status: () => {}, highlight: () => {},
      say: (t) => log.push(`says: ${t}`),
      apply: (ops, s, refs) => {
        const r = kernel.dispatch(ops, 'ai', { summary: s, refs });
        if (!r.ok) rejected++;
        log.push(`ops ${ops.map((o) => o.op + (o.kind ? `:${o.kind}` : '')).join(', ')} → ${r.ok ? 'ok' : r.errors.join(' | ')}`);
        return r;
      },
    };
    const agent = openaiAgent({ mode: 'key', apiKey: process.env.OPENAI_API_KEY, model: MODEL });
    const history: { role: 'user' | 'ai'; text: string }[] = [];
    const ask = async (text: string) => {
      const n = log.length;
      await agent.run(text, host, history);
      history.push({ role: 'user', text }, { role: 'ai', text: log.slice(n).filter((l) => l.startsWith('says')).join(' ') });
    };
    await ask(build);
    const objs = () => Object.values(kernel.state().objects);
    const lessonKinds = objs().map((o) => o.kind);
    await ask(test);
    const report = `\n### ${build}\n${log.join('\n')}\nrejected batches: ${rejected}\nkinds: ${lessonKinds.join(', ')}\n`;
    if (process.env.LIVE_LOG) appendFileSync(process.env.LIVE_LOG, report);
    else console.log(report);
    expect(lessonKinds).toContain('variable');
    expect(objs().some((o) => ['formula', 'system', 'trials'].includes(o.kind))).toBe(true);
    expect(lessonKinds).toContain('graph');
    const exp = objs().find((o) => o.kind === 'experiment' && isCalc(kernel.state().objects[o.state.target]));
    expect(exp, 'an experiment on the lesson').toBeTruthy();
    expect(exp!.state.supported).not.toBeNull();
  }, 10 * 60 * 1000);
