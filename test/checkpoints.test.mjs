import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { projectFixture } from './fixtures.mjs';
import { run, requireSuccess } from '../lib/process.mjs';
import { harnessRoot } from '../lib/paths.mjs';
import { projectContext, singleMilestonePlan, validatePlan, milestoneContext } from '../lib/work-plan.mjs';
import { projectHash } from '../lib/project-model.mjs';
import { candidateFingerprint, assertCandidate, checkpointGit, head, assertHead } from '../lib/checkpoint-git.mjs';
import { checkpointDevelopment } from '../lib/checkpoints.mjs';
import { developWorkflow } from '../lib/workflow.mjs';
import { acceptanceCoverage, selectScenarios } from '../lib/coverage.mjs';
import { implementationPrompt } from '../lib/agents.mjs';
import { runDevelopment } from '../lib/develop.mjs';
import { save } from '../lib/repository.mjs';

const pass = { verdict: 'pass', findings: [], summary: 'Synthetic independent verdict' };
const fail = { verdict: 'changes_required', findings: [{ severity: 'major', category: 'correctness', file: 'fixture', location: 'fixture', problem: 'Incomplete slice', required_change: 'Complete it', reason: 'AC not met' }], summary: 'Synthetic rejected verdict' };
const config = { budgets: { codeReviews: 1, visualReviews: 1, gameBoots: 2 } };

async function fixture(t, count = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await projectFixture(root);
  await writeFile(path.join(root, '.gitignore'), '.harness-artifacts/\nbuild/\n');
  const ids = ['AC-001', 'AC-002'].slice(0, count);
  const spec = `Status: ready\n## Identity\nMod ID: test_input\n` +
    ['Purpose', 'Functional requirements'].map(name => `## ${name}\nSynthetic behavior.\n`).join('') +
    `## Acceptance criteria\n${ids.map(id => `- ${id}: Observable synthetic ${id} behavior.`).join('\n')}\n` +
    ['Visual requirements', 'Persistence', 'Multiplayer', 'Compatibility', 'Non-goals', 'Reference assets', 'Unresolved questions'].map(name => `## ${name}\nNone.\n`).join('') +
    `## Verification\n| AC | Method | Evidence |\n| --- | --- | --- |\n${ids.map(id => `| ${id} | static | src/main/resources/${id}.json |`).join('\n')}\n`;
  await writeFile(path.join(root, 'spec/PROJECT.md'), spec);
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid']]) requireSuccess(await run('git', ['config', key, value], { cwd: root }), 'fixture identity');
  requireSuccess(await run('git', ['add', '.'], { cwd: root }), 'fixture stage');
  requireSuccess(await run('git', ['commit', '-m', 'fixture baseline'], { cwd: root }), 'fixture commit');
  const base = await head(root, run), calls = [];
  const runner = async (command, args, options) => {
    assert.ok(!args.includes('push'), 'no publish operation may be invoked, even in tests');
    calls.push({ command, args });
    return run(command, args, options);
  };
  const source = { section: 'Functional requirements', quote: 'Synthetic behavior.' };
  const model = { version: 1, projectSourceHash: projectHash(spec), modId: 'test_input',
    features: [{ id: 'FEAT-001', title: 'Synthetic behavior', purpose: source.quote, source }],
    requirements: ids.map((id, index) => ({ id: `REQ-${String(index + 1).padStart(3, '0')}`, featureId: 'FEAT-001',
      text: `Observable synthetic ${id} behavior.`, source: { section: 'Acceptance criteria', quote: `- ${id}: Observable synthetic ${id} behavior.` } })),
    acceptanceCriteria: ids.map((id, index) => ({ id, requirementId: `REQ-${String(index + 1).padStart(3, '0')}`,
      text: `Observable synthetic ${id} behavior.`, source: { section: 'Acceptance criteria', quote: `- ${id}: Observable synthetic ${id} behavior.` },
      verification: [{ method: 'static', evidence: `src/main/resources/${id}.json` }] })),
    constraints: [], nonGoals: [], visualRequirements: [], persistenceRequirements: [], multiplayerRequirements: [], references: [], dependencies: [], openQuestions: [], retiredIds: [] };
  const context = projectContext(spec, model, base);
  const plan = singleMilestonePlan(context);
  plan.milestones = ids.map((id, index) => ({ ...structuredClone(plan.milestones[0]), id: `M0${index + 1}`, acceptanceCriteria: [id], title: `Complete ${id}`, goal: `Observable ${id}`, dependsOn: index ? ['M01'] : [], commitMessage: `feat: complete ${id}` }));
  const dir = path.join(root, '.harness-artifacts/checkpoints/test-run');
  const invocations = [], repairs = [], behavior = {};
  const services = {
    compile: async () => structuredClone(model), plan: async () => structuredClone(plan), reviewPlan: async () => pass,
    async develop(destination, settings) {
      const id = settings.milestone?.id ?? 'final';
      invocations.push(id);
      if (settings.repair) repairs.push({ id, ...settings.repair });
      const startHead = await head(root, runner);
      let candidate;
      const actions = {
        specification: async () => {}, record: async value => settings.onRecord?.(value),
        guard: () => assertHead(root, runner, startHead),
        async implement() {
          await mkdir(path.join(root, 'src/main/resources'), { recursive: true });
          for (const ac of settings.milestone.acceptanceCriteria) await writeFile(path.join(root, `src/main/resources/${ac}.json`), JSON.stringify({ milestone: id }));
          if (behavior[id] === 'head') {
            requireSuccess(await runner('git', ['add', 'src'], { cwd: root }), 'fault injection stage');
            requireSuccess(await runner('git', ['commit', '-m', 'fault-injected agent commit'], { cwd: root }), 'fault injection commit');
          }
        },
        verify: async () => {}, review: async () => behavior[id] === 'review' ? fail : pass,
        async build() {
          await mkdir(path.join(root, 'build/libs'), { recursive: true });
          await writeFile(path.join(root, 'build/libs/test_input-1.jar'), 'synthetic compiled candidate');
          candidate = await candidateFingerprint(root, runner, { requireJar: true });
        },
        gameTest: async () => ({ status: 'not-applicable' }), classify: async () => ({ e2e: true }), preflight: async () => 1,
        start: async () => {}, stop: async () => {},
        async e2e() { if (behavior[id] === 'e2e') throw new Error('Synthetic E2E failure'); return { screenshots: [{ file: 'synthetic.png' }] }; },
        visual: async () => behavior[id] === 'visual' ? fail : pass
      };
      const result = await developWorkflow(actions, config.budgets, { regression: settings.regression });
      if (behavior[id] === 'fingerprint') await writeFile(path.join(root, 'src/main/resources/late.json'), '{}');
      if (behavior[id] === 'jar') await writeFile(path.join(root, 'build/libs/test_input-1.jar'), 'unverified jar');
      return { ...result, candidate };
    }
  };
  return { root, dir, base, runner, context, plan, services, calls, invocations, repairs, behavior,
    execute: options => checkpointDevelopment(root, runner, config, dir, options, services),
    resume: options => checkpointDevelopment(root, runner, config, dir, { resume: true, ...options }, services) };
}

for (const count of [1, 2]) test(`${count} PROJECT milestone creates verified commits then final regression without publish`, async t => {
  const f = await fixture(t, count);
  const result = await f.execute();
  assert.equal(result.status, 'complete', result.error);
  assert.deepEqual(f.invocations, [...f.plan.milestones.map(m => m.id), 'final']);
  assert.equal(result.milestones.M01.status, 'committed');
  const log = requireSuccess(await run('git', ['log', '--format=%B', `${f.base}..HEAD`], { cwd: f.root }), 'log').stdout;
  assert.match(log, /Harness-Milestone: M01/);
  assert.equal(f.calls.filter(call => call.args.includes('commit')).length, count);
  assert.equal(await head(f.root, run), result.expectedHead);
});

for (const stage of ['review', 'e2e', 'visual', 'fingerprint', 'jar']) test(`${stage} failure never commits candidate`, async t => {
  const f = await fixture(t, 1); f.behavior.M01 = stage;
  const result = await f.execute();
  assert.equal(result.status, 'failed');
  assert.equal(await head(f.root, run), f.base);
  assert.equal(f.calls.filter(call => call.args.includes('commit')).length, 0);
  if (['fingerprint', 'jar'].includes(stage)) assert.match(result.error, /fingerprint mismatch/);
});

test('agent HEAD mutation stops immediately without resetting the violating history', async t => {
  const f = await fixture(t, 1); f.behavior.M01 = 'head';
  const result = await f.execute();
  assert.equal(result.status, 'failed'); assert.match(result.error, /HEAD/);
  assert.equal(f.calls.filter(call => call.args.includes('commit')).length, 1, 'only fault injection committed');
  assert.notEqual(await head(f.root, run), f.base);
});

test('M02 failure preserves M01 and resumes exactly M02 with its uncommitted candidate', async t => {
  const f = await fixture(t); f.behavior.M02 = 'e2e';
  const failed = await f.execute();
  assert.equal(failed.status, 'failed'); assert.equal(failed.completedMilestones[0].id, 'M01');
  const first = await head(f.root, run);
  f.behavior.M02 = undefined;
  const resumed = await f.resume();
  assert.equal(resumed.status, 'complete', resumed.error);
  assert.equal(resumed.milestones.M01.commit, first);
  assert.deepEqual(f.invocations, ['M01', 'M02', 'M02', 'final']);
  assert.equal(f.repairs[0].id, 'M02');
  assert.match(f.repairs[0].evidence, /M02\/attempt-1/);
});

test('resume rejects HEAD mismatch and leaves saved state untouched', async t => {
  const f = await fixture(t); await f.execute({ stopAfter: 'M01' });
  const before = await readFile(path.join(f.dir, 'state.json'), 'utf8');
  requireSuccess(await run('git', ['commit', '--allow-empty', '-m', 'external change'], { cwd: f.root }), 'external commit');
  const result = await f.resume();
  assert.equal(result.status, 'failed'); assert.match(result.error, /HEAD/);
  assert.equal(await readFile(path.join(f.dir, 'state.json'), 'utf8'), before);
});

for (const file of ['spec/PROJECT.md', 'src/main/resources/AC-001.json']) test(`resume rejects edited ${file}`, async t => {
  const f = await fixture(t); await f.execute({ stopAfter: 'M01' });
  await writeFile(path.join(f.root, file), (await readFile(path.join(f.root, file), 'utf8')) + '\nchanged');
  const result = await f.resume(); assert.equal(result.status, 'failed');
  assert.match(result.error, /hash changed|fingerprint mismatch/);
});

test('replan only changes remaining milestone definitions and requires a new review', async t => {
  const f = await fixture(t); const first = await f.execute({ stopAfter: 'M01' });
  const oldCommit = first.milestones.M01.commit;
  f.plan.milestones[0].goal = 'tampered completed goal';
  assert.match((await f.resume({ replan: true })).error, /immutable/);
  f.plan.milestones[0].goal = 'Observable AC-001';
  f.plan.milestones[1].goal = 'Revised but complete AC-002 behavior';
  let reviewed = false; f.services.reviewPlan = async (_context, proposal, completed) => {
    assert.equal(completed.length, 1); assert.equal(proposal.milestones[1].goal, f.plan.milestones[1].goal); reviewed = true; return pass;
  };
  const result = await f.resume({ replan: true });
  assert.equal(result.status, 'complete', result.error); assert.equal(reviewed, true);
  assert.equal(result.milestones.M01.commit, oldCommit);
});

test('schema, coverage, ordering and immutable plan hashes are checked deterministically', async t => {
  const f = await fixture(t);
  for (const change of [plan => plan.milestones.pop(), plan => plan.milestones[1].dependsOn = ['M99'], plan => plan.milestones[1].acceptanceCriteria = ['AC-001'], plan => plan.milestones[0].unexpected = true]) {
    const bad = structuredClone(f.plan); change(bad); assert.throws(() => validatePlan(bad, f.context));
  }
  const result = await f.execute({ planOnly: true }); assert.equal(result.status, 'planned');
  const planFile = path.join(f.dir, result.planFile); await writeFile(planFile, JSON.stringify({ ...f.plan, projectId: 'changed' }));
  assert.match((await f.resume()).error, /Plan hash mismatch/);
});

test('horizontal/incomplete plan is routed through independent review and rejected before implementation', async t => {
  const f = await fixture(t); f.plan.milestones[0].goal = 'Only registry infrastructure, no working behavior';
  f.services.reviewPlan = async () => fail;
  const result = await f.execute(); assert.equal(result.status, 'failed'); assert.match(result.error, /Plan review/);
  assert.deepEqual(f.invocations, []); assert.equal(await head(f.root, run), f.base);
});

test('plan-only runs planning/review but no implementation or commit; resume executes it', async t => {
  const f = await fixture(t, 1);
  assert.equal((await f.execute({ planOnly: true })).status, 'planned');
  assert.deepEqual(f.invocations, []); assert.equal(await head(f.root, run), f.base);
  assert.equal((await f.resume()).status, 'complete');
});

test('stop-after commits the named milestone and pauses before the next', async t => {
  const f = await fixture(t); const stopped = await f.execute({ stopAfter: 'M01' });
  assert.equal(stopped.status, 'stopped'); assert.deepEqual(f.invocations, ['M01']);
  assert.equal((await f.resume()).status, 'complete');
});

test('dry-run invokes no external AI, Gradle, Minecraft or commit and is explicitly simulated', async t => {
  const f = await fixture(t, 1);
  const dryConfig = { budgets: { codeReviews: 3, visualReviews: 2, gameBoots: 3 } };
  const result = await checkpointDevelopment(f.root, f.runner, dryConfig, f.dir, { dryRun: true }, {
    plan: () => assert.fail('planner'), reviewPlan: () => assert.fail('review'), develop: () => assert.fail('runtime') });
  assert.equal(result.status, 'complete', result.error); assert.equal(result.simulated, true);
  assert.equal(await head(f.root, run), f.base);
  assert.ok(f.calls.every(call => call.command === 'git' && !call.args.includes('commit')));
});

test('final regression failure preserves every checkpoint and never rewrites or adds a fix commit', async t => {
  const f = await fixture(t); f.behavior.final = 'e2e';
  const result = await f.execute(); assert.equal(result.status, 'failed'); assert.match(result.error, /Final regression/);
  assert.equal(result.completedMilestones.length, 2); assert.equal(f.calls.filter(call => call.args.includes('commit')).length, 2);
  assert.equal(await head(f.root, run), result.completedMilestones[1].commit);
  assert.ok(f.calls.every(call => !['reset', 'rebase', 'checkout', 'stash', 'merge', 'push'].some(command => call.args.includes(command))));
});

test('static coverage never imports an unreviewed scenario', async t => {
  const f = await fixture(t, 1);
  await mkdir(path.join(f.root, 'tests/e2e/scenarios'), { recursive: true });
  await writeFile(path.join(f.root, 'tests/e2e/scenarios/unsafe.scenario.mjs'), 'throw new Error("Unreviewed code executed");');
  const specFile = path.join(f.root, 'spec/PROJECT.md');
  await writeFile(specFile, (await readFile(specFile, 'utf8')).replace('static | src/main/resources/AC-001.json', 'e2e | unsafe'));
  assert.equal((await acceptanceCoverage(f.root, f.dir, { reviewed: false })).status, 'references-pending-review');
  await assert.rejects(acceptanceCoverage(f.root, f.dir), /Unreviewed code executed/);
});

test('scenario selection unions required evidence, smoke and affected regression', () => {
  const scenarios = [{ id: 'required' }, { id: 'smoke', alwaysRun: true }, { id: 'affected', affectedPaths: ['src/main/java'] }, { id: 'unrelated', affectedPaths: ['src/main/resources'] }];
  const selected = selectScenarios(scenarios, [{ method: 'persistence', evidence: 'required' }], ['src/main/java/A.java'], { runtimeChanged: true });
  assert.deepEqual(selected.map(s => s.id), ['required', 'smoke', 'affected']);
  assert.equal(selectScenarios(scenarios, [], [], { fullRegression: true }).length, 4);
});

test('automatic regression waits for future milestone ACs while required evidence and smoke remain mandatory', () => {
  const scenarios = [
    { id: 'current', acceptanceCriteria: ['AC-001'] },
    { id: 'future', acceptanceCriteria: ['AC-002'] },
    { id: 'cross-feature', acceptanceCriteria: ['AC-001', 'AC-002'] },
    { id: 'smoke', acceptanceCriteria: ['AC-001'], alwaysRun: true }
  ];
  assert.deepEqual(selectScenarios(scenarios, [], ['src/main/java/A.java'], { runtimeChanged: true, criteria: ['AC-001'] }).map(s => s.id), ['current', 'smoke']);
  assert.deepEqual(selectScenarios(scenarios, [], [], { fullRegression: true, criteria: ['AC-001', 'AC-002'] }).map(s => s.id), scenarios.map(s => s.id));
  assert.ok(selectScenarios(scenarios, [{ method: 'e2e', evidence: 'cross-feature' }], [], { criteria: ['AC-001'] }).some(s => s.id === 'cross-feature'));
});

test('milestone prompt carries only current slice and repair findings, not future context', async t => {
  const f = await fixture(t);
  const current = milestoneContext(f.context, f.plan.milestones[0]);
  const prompt = implementationPrompt(f.context.specText, { milestone: current, repair: true, findings: ['current failure'] });
  assert.match(prompt, /AC-001/); assert.doesNotMatch(prompt, /AC-002/); assert.match(prompt, /Excluded scope/); assert.match(prompt, /Findings\/errors:.*current failure/);
  assert.match(prompt, /spec\/\*\*.*read-only/);
});

test('commit gate rejects an index race', async t => {
  const f = await fixture(t, 1);
  await mkdir(path.join(f.root, 'src/main/resources'), { recursive: true });
  await writeFile(path.join(f.root, 'src/main/resources/input.json'), '{}');
  await mkdir(path.join(f.root, 'build/libs'), { recursive: true });
  await writeFile(path.join(f.root, 'build/libs/test_input-1.jar'), 'jar');
  const candidate = await candidateFingerprint(f.root, run, { requireJar: true });
  requireSuccess(await run('git', ['add', 'src'], { cwd: f.root }), 'external index change');
  await assert.rejects(checkpointGit(f.root, run, f.dir).stage(candidate), /index/);
  const current = await candidateFingerprint(f.root, run, { requireJar: true });
  assert.doesNotThrow(() => assertCandidate(current, current));
});

for (const when of ['before', 'after']) test(`resume recovers durable intent when commit is interrupted ${when} Git advances HEAD`, async t => {
  const f = await fixture(t, 1);
  let interrupted = false;
  const runner = async (command, args, options) => {
    if (args.includes('commit') && !interrupted) {
      interrupted = true;
      if (when === 'after') requireSuccess(await f.runner(command, args, options), 'commit before simulated crash');
      throw new Error('Simulated interruption at commit boundary');
    }
    return f.runner(command, args, options);
  };
  assert.equal((await checkpointDevelopment(f.root, runner, config, f.dir, {}, f.services)).status, 'failed');
  const saved = JSON.parse(await readFile(path.join(f.dir, 'state.json'), 'utf8'));
  assert.ok(saved.pending);
  const result = await f.resume();
  assert.equal(result.status, 'complete', result.error);
  assert.deepEqual(f.invocations, ['M01', 'final']);
  assert.equal(f.calls.filter(call => call.args.includes('commit')).length, 1);
});

test('Git modes are preserved when core.fileMode is false, as on Windows', async t => {
  const f = await fixture(t, 1);
  requireSuccess(await run('git', ['update-index', '--chmod=+x', 'gradlew'], { cwd: f.root }), 'executable wrapper');
  requireSuccess(await run('git', ['commit', '-m', 'fixture executable wrapper'], { cwd: f.root }), 'fixture mode baseline');
  requireSuccess(await run('git', ['config', 'core.fileMode', 'false'], { cwd: f.root }), 'unreliable filesystem modes');
  await chmod(path.join(f.root, 'gradlew'), 0o644);
  await mkdir(path.join(f.root, 'src/main/resources'), { recursive: true });
  await writeFile(path.join(f.root, 'src/main/resources/input.json'), '{}');
  await mkdir(path.join(f.root, 'build/libs'), { recursive: true });
  await writeFile(path.join(f.root, 'build/libs/test_input-1.jar'), 'jar');
  const candidate = await candidateFingerprint(f.root, f.runner, { requireJar: true });
  assert.equal(candidate.modes.gradlew, 0o111);
  const git = checkpointGit(f.root, f.runner, f.dir), tree = await git.stage(candidate);
  await git.commit(candidate, tree, 'feat: verify preserved executable mode');
  assert.match((await run('git', ['ls-files', '--stage', 'gradlew'], { cwd: f.root })).stdout, /^100755 /);
});

test('canonical fingerprint supports CRLF checkouts while preserving verified raw files', async t => {
  const f = await fixture(t, 1);
  await writeFile(path.join(f.root, '.gitattributes'), '*.txt text eol=lf\n');
  requireSuccess(await run('git', ['add', '.gitattributes'], { cwd: f.root }), 'fixture attributes');
  requireSuccess(await run('git', ['commit', '-m', 'fixture normalization'], { cwd: f.root }), 'fixture attributes commit');
  await mkdir(path.join(f.root, 'src/main/resources'), { recursive: true });
  await writeFile(path.join(f.root, 'src/main/resources/input.txt'), 'raw\r\nbytes\r\n');
  await mkdir(path.join(f.root, 'build/libs'), { recursive: true });
  await writeFile(path.join(f.root, 'build/libs/test_input-1.jar'), 'jar');
  const candidate = await candidateFingerprint(f.root, f.runner, { requireJar: true });
  const git = checkpointGit(f.root, f.runner, f.dir), tree = await git.stage(candidate);
  await git.commit(candidate, tree, 'feat: commit verified normalized content');
  assert.equal(await readFile(path.join(f.root, 'src/main/resources/input.txt'), 'utf8'), 'raw\r\nbytes\r\n');
  assert.equal((await run('git', ['show', 'HEAD:src/main/resources/input.txt'], { cwd: f.root })).stdout, 'raw\nbytes\n');
});

test('shared real development actions repair visual findings through resource reload', async t => {
  const f = await fixture(t, 1);
  await mkdir(path.join(f.root, 'tests/e2e/scenarios'), { recursive: true });
  await mkdir(path.join(f.root, 'src/main/resources'), { recursive: true });
  await writeFile(path.join(f.root, 'src/main/resources/AC-001.json'), '{}');
  await writeFile(path.join(f.root, 'tests/e2e/scenarios/fixture.scenario.mjs'), `export default {id:'fixture',acceptanceCriteria:['AC-001'],visual:true,async setup(){},async actions(){},async assertions(){},async cleanup(){},screenshots:[{id:'point',criteria:['synthetic'],async prepare(){},async assertState(){}}]};`);
  requireSuccess(await run('git', ['add', 'src', 'tests'], { cwd: f.root }), 'fixture scenarios');
  requireSuccess(await run('git', ['commit', '-m', 'fixture scenario baseline'], { cwd: f.root }), 'fixture scenario commit');
  let implementations = 0, visuals = 0, reloads = 0, starts = 0;
  const runner = async (command, args, options) => {
    if (command === 'git') return f.runner(command, args, options);
    assert.ok(args.includes('build'));
    await mkdir(path.join(f.root, 'build/libs'), { recursive: true });
    await writeFile(path.join(f.root, 'build/libs/test_input-1.jar'), `compiled-${implementations}`);
    return { ok: true, stdout: 'BUILD SUCCESSFUL', stderr: '' };
  };
  const services = {
    doctor: async () => ({ checks: [] }), validate: async () => ({ ok: true }),
    async implement(_root, _runner, _config, dir, input) {
      implementations++;
      if (implementations === 2) assert.equal(input.repair, true);
      await mkdir(path.join(f.root, 'src/main/resources/assets/test_input/lang'), { recursive: true });
      await writeFile(path.join(f.root, 'src/main/resources/assets/test_input/lang/en_us.json'), JSON.stringify({ label: `candidate-${implementations}` }));
      await save(path.join(dir, 'validation.json'), { ok: true });
    },
    review: async (_root, _runner, _config, _dir, kind) => kind === 'visual' && ++visuals === 1 ? fail : pass,
    createSession: async () => ({ playerCount: 1, async start() { starts++; }, async ready() {}, async stop() {},
      async reload(kinds) { assert.deepEqual(kinds, ['resources']); reloads++; },
      async batch() { return { screenshots: [{ file: 'synthetic.png' }] }; } })
  };
  const result = await runDevelopment(f.root, runner, { budgets: { codeReviews: 3, visualReviews: 2, gameBoots: 3 }, gameTest: 'auto' }, f.dir,
    { checkpoint: true, milestone: f.plan.milestones[0], context: milestoneContext(f.context, f.plan.milestones[0]), criteria: ['AC-001'] }, services);
  assert.equal(result.status, 'pass', result.error);
  assert.equal(implementations, 2); assert.equal(reloads, 1); assert.equal(starts, 1);
  assert.ok(result.candidate.jar.sha256);
});

test('checkpoint CLI validates combinations and supports a real no-external dry-run', async t => {
  const f = await fixture(t, 1);
  const cli = path.join(harnessRoot, 'cli.mjs');
  for (const args of [['--resume', '--dry-run'], ['--task', 'spec/tasks/TASK-001.md']]) {
    assert.equal((await run(process.execPath, [cli, 'develop', ...args], { cwd: f.root })).code, 2);
  }
  const projectOnly = await run(process.execPath, [cli, 'develop', '--dry-run'], { cwd: f.root });
  assert.equal(projectOnly.code, 0, projectOnly.stderr); assert.match(projectOnly.stdout, /"simulated": true/);
  assert.equal(await head(f.root, run), f.base);
});

for (const method of ['e2e', 'visual', 'persistence', 'multiplayer', 'gametest']) test(`shared actions enforce spec-required ${method} for a pure-logic change`, async t => {
  const f = await fixture(t, 1);
  const evidence = method === 'gametest' ? 'src/main/java/FixtureTests.java' : method === 'visual' ? 'required/point' : 'required';
  const specFile = path.join(f.root, 'spec/PROJECT.md');
  await writeFile(specFile, (await readFile(specFile, 'utf8')).replace('static | src/main/resources/AC-001.json', `${method} | ${evidence}`));
  await mkdir(path.join(f.root, 'src/main/java'), { recursive: true });
  if (method === 'gametest') await writeFile(path.join(f.root, evidence), '@GameTest void fixture() {}');
  else {
    await mkdir(path.join(f.root, 'tests/e2e/scenarios'), { recursive: true });
    await writeFile(path.join(f.root, 'tests/e2e/scenarios/required.scenario.mjs'), `export default {id:'required',acceptanceCriteria:['AC-001'],visual:${method === 'visual'},
      ${method === 'persistence' ? "phase:'after-restart'," : ''}${method === 'multiplayer' ? "players:2,verification:['multiplayer']," : ''}
      async setup(){},async actions(){},async assertions(){},async cleanup(){},screenshots:${method === 'visual' ? "[{id:'point',criteria:['synthetic'],async prepare(){},async assertState(){}}]" : '[]'}};`);
  }
  requireSuccess(await run('git', ['add', '--all'], { cwd: f.root }), 'required verification fixture');
  requireSuccess(await run('git', ['commit', '-m', 'fixture required verification'], { cwd: f.root }), 'fixture commit');
  let starts = 0, batches = 0, visuals = 0, gameTests = 0;
  const runner = async (command, args, options) => {
    if (command === 'git') return f.runner(command, args, options);
    assert.ok(args.includes('build'));
    await mkdir(path.join(f.root, 'build/libs'), { recursive: true });
    await writeFile(path.join(f.root, 'build/libs/test_input-1.jar'), 'fixture jar');
    return { ok: true, stdout: '', stderr: '' };
  };
  const services = {
    doctor: async () => ({ checks: [] }), validate: async () => ({ ok: true }),
    async implement(_root, _runner, _config, dir) {
      await mkdir(path.join(f.root, 'src/main/java/example/logic'), { recursive: true });
      await writeFile(path.join(f.root, 'src/main/java/example/logic/Value.java'), 'class Value {}');
      await save(path.join(dir, 'validation.json'), { ok: true });
    },
    async review(_root, _runner, _config, _dir, kind) { if (kind === 'visual') visuals++; return pass; },
    async gameTest(_root, _runner, _dir, mode) { assert.equal(mode, 'required'); gameTests++; return { status: 'pass' }; },
    createSession: async (_root, _runner, _dir, settings) => ({ playerCount: settings.playerCount, async start() { starts++; }, async stop() {},
      async batch(scenarios) { batches += scenarios.length; return { screenshots: method === 'visual' ? [{ file: 'synthetic.png' }] : [] }; } })
  };
  const result = await runDevelopment(f.root, runner, { ...config, gameTest: 'auto' }, f.dir, { checkpoint: true }, services);
  assert.equal(result.status, 'pass', result.error);
  assert.equal(starts, method === 'gametest' ? 0 : method === 'persistence' ? 2 : 1);
  assert.equal(batches, method === 'gametest' ? 0 : 1);
  assert.equal(visuals, method === 'visual' ? 1 : 0);
  assert.equal(gameTests, method === 'gametest' ? 1 : 0);
});

test('schema used by the real planner omits provider-unsupported uniqueness but deterministic validation enforces it', async t => {
  const schema = await readFile(path.join(harnessRoot, 'schemas/work-plan.schema.json'), 'utf8');
  assert.doesNotMatch(schema, /uniqueItems/);
  const f = await fixture(t, 1);
  f.plan.milestones[0].acceptanceCriteria.push('AC-001');
  assert.throws(() => validatePlan(f.plan, f.context), /array/);
});

test('missing checkpoint state is a normal CLI failure, not an uncaught exception', async t => {
  const f = await fixture(t, 1);
  const result = await run(process.execPath, [path.join(harnessRoot, 'cli.mjs'), 'develop', '--resume'], { cwd: f.root });
  assert.equal(result.code, 1); assert.doesNotMatch(result.stderr, /at async|node:internal/);
});

test('rejected plan evidence is preserved when planning is retried', async t => {
  const f = await fixture(t, 1);
  f.services.reviewPlan = async () => fail;
  assert.equal((await f.execute({ planOnly: true })).status, 'failed');
  const rejectedFile = path.join(f.dir, 'plan-1/review-result.json');
  const rejected = await readFile(rejectedFile, 'utf8');
  f.services.reviewPlan = async () => pass;
  const result = await f.resume({ planOnly: true });
  assert.equal(result.status, 'planned', result.error);
  assert.equal(result.planFile, 'plan-2/plan.json');
  assert.equal(await readFile(rejectedFile, 'utf8'), rejected);
});

test('corrupt saved commit identities cannot become Git command options', async t => {
  const f = await fixture(t, 1); await f.execute({ planOnly: true });
  const file = path.join(f.dir, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.expectedHead = '--output=unexpected-file';
  await writeFile(file, JSON.stringify(state));
  const result = await f.resume();
  assert.equal(result.status, 'failed'); assert.match(result.error, /Invalid checkpoint commit identity/);
  assert.ok(!f.calls.some(call => call.args.includes(state.expectedHead)));
});

test('completed runs resume without repeating regression but still reject changed inputs', async t => {
  const f = await fixture(t, 1);
  assert.equal((await f.execute()).status, 'complete');
  const completed = await readFile(path.join(f.dir, 'state.json'), 'utf8');
  assert.equal((await f.resume({ replan: true })).status, 'failed');
  assert.equal(await readFile(path.join(f.dir, 'state.json'), 'utf8'), completed);
  assert.equal((await f.resume()).status, 'complete');
  assert.deepEqual(f.invocations, ['M01', 'final']);
  await writeFile(path.join(f.root, 'src/main/resources/AC-001.json'), '{"changed":true}');
  assert.equal((await f.resume()).status, 'failed');
  assert.deepEqual(f.invocations, ['M01', 'final']);
});
