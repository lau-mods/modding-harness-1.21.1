import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { projectFixture } from './fixtures.mjs';
import { run, requireSuccess } from '../lib/process.mjs';
import { parseSpec } from '../lib/validate.mjs';
import { projectHash, validateProjectModel, simulatedProjectModel } from '../lib/project-model.mjs';
import { projectContext, validatePlan, singleMilestonePlan, milestoneContext } from '../lib/work-plan.mjs';
import { checkpointDevelopment } from '../lib/checkpoints.mjs';
import { candidateFingerprint, head } from '../lib/checkpoint-git.mjs';

const source = { section: 'Features', quote: 'Copper Press turns one ingot into one plate.' };
const project = (extra = '') => `# Project\nMod ID: test_input\n## Purpose\nA small processing mod.\n## Features\n${source.quote}\n${extra}## Non-goals\nNo hopper automation.\n`;
function model(text, added = false) {
  const next = { section: 'Features', quote: 'Steel Furnace cooks one ore into one ingot.' };
  const features = [{ id: 'FEAT-001', title: 'Copper Press', purpose: source.quote, source }];
  const requirements = [{ id: 'REQ-001', featureId: 'FEAT-001', text: source.quote, source }];
  const acceptanceCriteria = [{ id: 'AC-001', requirementId: 'REQ-001', text: source.quote, source,
    verification: [{ method: 'static', evidence: 'src/main/resources/press.json' }] }];
  if (added) {
    features.push({ id: 'FEAT-002', title: 'Steel Furnace', purpose: next.quote, source: next });
    requirements.push({ id: 'REQ-002', featureId: 'FEAT-002', text: next.quote, source: next });
    acceptanceCriteria.push({ id: 'AC-002', requirementId: 'REQ-002', text: next.quote, source: next,
      verification: [{ method: 'static', evidence: 'src/main/resources/furnace.json' }] });
  }
  return { version: 1, projectSourceHash: projectHash(text), modId: 'test_input', features, requirements, acceptanceCriteria,
    constraints: [], nonGoals: [{ text: 'No hopper automation.', source: { section: 'Non-goals', quote: 'No hopper automation.' } }],
    visualRequirements: [], persistenceRequirements: [], multiplayerRequirements: [], references: [], dependencies: [], openQuestions: [], retiredIds: [] };
}

test('natural PROJECT.md compiles to traced IDs, features, requirements and verification without a task or AC table', () => {
  const text = project();
  assert.deepEqual(parseSpec(text).criteria, []);
  const derived = validateProjectModel(model(text), text);
  assert.equal(derived.acceptanceCriteria[0].source.quote, source.quote);
  const context = projectContext(text, derived, 'abc');
  assert.deepEqual(context.criteria, ['AC-001']);
  assert.equal(validatePlan(singleMilestonePlan(context), context).milestones.length, 1);
  assert.match(milestoneContext(context, singleMilestonePlan(context).milestones[0]).relevantSpec, /Copper Press/);
  assert.equal(validateProjectModel(simulatedProjectModel(text), text).features.length, 1);
});

test('deterministic model checks reject invented sources, duplicate IDs, stale hashes, missing verification and cycles', () => {
  const text = project(), good = model(text);
  for (const mutate of [
    value => { value.acceptanceCriteria[0].source.quote = 'hoppers also work'; },
    value => { value.acceptanceCriteria[0].id = 'REQ-001'; },
    value => { value.projectSourceHash = 'stale'; },
    value => { value.acceptanceCriteria[0].verification = []; },
    value => { value.requirements[0].featureId = 'FEAT-999'; },
    value => { value.references = [{ summary: 'invented', location: 'https://example.invalid', featureIds: [] }]; },
    value => { value.acceptanceCriteria[0].source = { section: 'Non-goals', quote: 'No hopper automation.' }; }
  ]) { const value = structuredClone(good); mutate(value); assert.throws(() => validateProjectModel(value, text)); }
  const larger = project('Steel Furnace cooks one ore into one ingot.\n');
  const cyclic = model(larger, true);
  cyclic.dependencies = [{ from: 'FEAT-001', to: 'FEAT-002' }, { from: 'FEAT-002', to: 'FEAT-001' }];
  assert.throws(() => validateProjectModel(cyclic, larger), /Cyclic/);
});

test('unchanged IDs persist and removed IDs retire instead of being reassigned', () => {
  const oldText = project('Steel Furnace cooks one ore into one ingot.\n');
  const previous = model(oldText, true), newText = project();
  const current = model(newText); current.retiredIds = ['FEAT-002', 'REQ-002', 'AC-002'];
  assert.equal(validateProjectModel(current, newText, previous).acceptanceCriteria[0].id, 'AC-001');
  assert.throws(() => validateProjectModel(model(newText), newText, previous), /retired/);
  const reassigned = structuredClone(current); reassigned.acceptanceCriteria[0].id = 'AC-002';
  assert.throws(() => validateProjectModel(reassigned, newText, previous));
});

test('critical product ambiguity returns NEEDS_PROJECT_CLARIFICATION with source', () => {
  const text = project('The press output may be one or two plates.\n');
  const value = model(text);
  value.openQuestions = [{ question: 'One or two plates?', why: 'Output quantity changes gameplay.', alternatives: ['one', 'two'], projectEdit: 'Specify output quantity.',
    source: { section: 'Features', quote: 'The press output may be one or two plates.' } }];
  assert.throws(() => validateProjectModel(value, text), /NEEDS_PROJECT_CLARIFICATION/);
});

test('PROJECT-only checkpoint compiles, plans, verifies and commits locally; spec change creates only new work', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-project-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await projectFixture(root);
  await writeFile(path.join(root, '.gitignore'), '.harness-artifacts/\nbuild/\n');
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid']]) requireSuccess(await run('git', ['config', key, value], { cwd: root }), 'git config');
  requireSuccess(await run('git', ['add', '.'], { cwd: root }), 'stage');
  requireSuccess(await run('git', ['commit', '-m', 'template baseline'], { cwd: root }), 'commit');
  await writeFile(path.join(root, 'spec/PROJECT.md'), project());
  const firstBase = await head(root, run);
  const config = { budgets: { codeReviews: 1, visualReviews: 1, gameBoots: 1 } };
  const pass = { verdict: 'pass', findings: [], summary: 'Synthetic review' };
  const calls = [];
  const runner = async (command, args, options) => { assert.ok(!args.includes('push')); calls.push(args); return run(command, args, options); };
  const services = {
    compile: async () => model(await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8'),
      (await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8')).includes('Steel Furnace')),
    plan: async context => singleMilestonePlan(context), reviewPlan: async () => pass,
    async develop(_destination, settings) {
      if (!settings.regression) {
        await mkdir(path.join(root, 'src/main/resources'), { recursive: true });
        for (const id of settings.milestone.acceptanceCriteria) await writeFile(path.join(root, `src/main/resources/${id}.json`), '{}');
      }
      await mkdir(path.join(root, 'build/libs'), { recursive: true });
      await writeFile(path.join(root, 'build/libs/test_input-1.jar'), 'mock jar');
      return { status: 'pass', candidate: await candidateFingerprint(root, runner, { requireJar: true }) };
    }
  };
  const dir1 = path.join(root, '.harness-artifacts/checkpoints/run-1');
  const planned = await checkpointDevelopment(root, runner, config, dir1, { planOnly: true }, services);
  assert.equal(planned.status, 'planned', planned.error);
  assert.equal(await head(root, run), firstBase, 'plan-only must not commit');
  const first = await checkpointDevelopment(root, runner, config, dir1, { resume: true }, services);
  assert.equal(first.status, 'complete', first.error);
  assert.notEqual(first.expectedHead, firstBase);
  assert.deepEqual(first.completedCriteria.M01, ['AC-001']);
  const beforeChange = first.expectedHead;
  await writeFile(path.join(root, 'spec/PROJECT.md'), project('Steel Furnace cooks one ore into one ingot.\n'));
  const stale = await checkpointDevelopment(root, runner, config, dir1, { resume: true }, services);
  assert.match(stale.error, /PROJECT.md hash changed/);
  const dir2 = path.join(root, '.harness-artifacts/checkpoints/run-2');
  const second = await checkpointDevelopment(root, runner, config, dir2, {}, services);
  assert.equal(second.status, 'complete', second.error);
  assert.deepEqual(second.plannedCriteria, ['AC-002']);
  assert.equal((await readFile(path.join(dir2, second.planFile), 'utf8')).includes('AC-001'), false);
  assert.equal(requireSuccess(await run('git', ['rev-parse', 'HEAD^'], { cwd: root }), 'parent').stdout.trim(), beforeChange);
  assert.ok(calls.every(args => !args.includes('push')));
});
