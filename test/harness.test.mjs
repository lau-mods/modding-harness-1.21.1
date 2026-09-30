import { projectFixture, properties } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, requireSuccess, gradleCommand, subscriptionEnv, redact } from '../lib/process.mjs';
import { classify, changedSince, snapshot, assertHarnessUnchanged, isModPath } from '../lib/repository.mjs';
import { harnessValidation, requiredTasks, parseSpec, hasGameTests, gameTest, resourceReferences, staticValidation, validate, requiredFiles } from '../lib/validate.mjs';
import { parseReview, validateReview, claudeArgs, visualSpecification, implement, codexPermissions, implementationPrompt } from '../lib/agents.mjs';
import { localAddress, relevantLogs, mct, logMark, logsAfter, syncPack, prepareOptions, prepareEarlyDisplay, createSession } from '../lib/mc-pilot.mjs';
import { developWorkflow, dryRunActions } from '../lib/workflow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pass = { verdict: 'pass', findings: [], summary: 'No blocking findings' };
const finding = { severity: 'major', category: 'correctness', file: 'x.mjs', location: '1', problem: 'A fails', required_change: 'Fix A', reason: 'AC fails' };
const fail = { verdict: 'changes_required', findings: [finding], summary: 'Correction required' };
const budgets = { codeReviews: 3, gameBoots: 2, visualReviews: 2 };
const specification = `Status: ready

## Identity
Mod ID: test_input
## Purpose
Synthetic parser and coverage input; no Mod implementation.
## Functional requirements
Test input only.
## Acceptance criteria
- AC-A: Synthetic criterion A.
- AC-B: Synthetic criterion B.
- AC-C: Synthetic criterion C.
- AC-D: Synthetic criterion D.
## Visual requirements
AC-D: Synthetic visual requirement.
## Persistence
Test input only.
## Multiplayer
Test input only.
## Compatibility
Test input only.
## Non-goals
No gameplay implementation.
## Reference assets
No references.
## Unresolved questions
None.
## Verification
| AC | Method | Evidence |
| --- | --- | --- |
| AC-A | e2e | case-a |
| AC-B | persistence | case-b |
| AC-C | multiplayer | case-c |
| AC-D | visual | case-a/point |
`;
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcmod-harness-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('process success, failure and missing executable are distinguishable', async () => {
  const ok = await run(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(requireSuccess(ok, 'test').stdout, 'ok');
  const bad = await run(process.execPath, ['-e', 'process.stderr.write("bad");process.exit(7)']);
  assert.equal(bad.code, 7); assert.throws(() => requireSuccess(bad, 'test'), /bad/);
  const missing = await run('mcmod-command-that-does-not-exist', []);
  assert.equal(missing.ok, false); assert.equal(missing.failure, 'ENOENT');
});

test('Mod edits preserve existing harness changes and protect all non-project files', async t => {
  const dir = await temp(t);
  await mkdir(path.join(dir, '.harness'));
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, '.harness/config.json'), 'existing user changes');
  await writeFile(path.join(dir, 'src/input.java'), 'before');
  const runner = async () => ({ ok: true, stdout: '.harness/config.json\0src/input.java\0README.md\0' });
  const initial = await snapshot(dir, runner);
  await writeFile(path.join(dir, 'src/input.java'), 'after');
  await assertHarnessUnchanged(dir, runner, initial);
  await writeFile(path.join(dir, 'README.md'), 'unexpected harness documentation');
  await assert.rejects(() => assertHarnessUnchanged(dir, runner, initial), /protected files: README.md/);
  await rm(path.join(dir, 'README.md'));
  await rm(path.join(dir, '.harness/config.json'));
  await assert.rejects(() => assertHarnessUnchanged(dir, runner, initial), /\.harness\/config.json/);
  for (const file of ['.harness/new.mjs', 'package.json', 'tests/e2e/README.md', 'AGENTS.md']) assert.equal(isModPath(file), false);
  for (const file of ['spec/PROJECT.md', 'spec/features/input.md', 'spec/PROJECT.template.md', 'spec/README.md', 'src/main/new.java', 'tests/e2e/scenarios/new.scenario.mjs', 'build.gradle']) assert.equal(isModPath(file), true);
});

test('Codex uses a restrictive filesystem profile and checks integrity even on CLI failure', async t => {
  const dir = await temp(t);
  await mkdir(path.join(dir, 'spec'));
  await writeFile(path.join(dir, 'spec/PROJECT.md'), 'accepted specification');
  await writeFile(path.join(dir, 'AGENTS.md'), 'existing user policy');
  const runner = async (command, args) => {
    if (command === 'git') return { ok: true, stdout: 'AGENTS.md\0spec/PROJECT.md\0' };
    assert.equal(command, 'codex');
    for (const flag of ['--strict-config', '--ignore-user-config', '--ignore-rules']) assert.ok(args.includes(flag));
    assert.ok(!args.includes('--sandbox')); assert.ok(args.includes('approval_policy="never"'));
    const profile = codexPermissions().at(-1);
    assert.match(profile, /"\." = "read"/); assert.match(profile, /"src" = "write"/);
    assert.match(profile, /"spec" = "write"/);
    assert.doesNotMatch(profile, /"harness" = "write"/);
    await writeFile(path.join(dir, 'AGENTS.md'), 'changed by a faulty runner');
    return { ok: false, code: 1, stdout: '', stderr: 'CLI failed' };
  };
  await assert.rejects(() => implement(dir, runner, { models: { implementer: 'gpt-6-sol' } }, path.join(dir, 'artifacts'), { task: 'test' }), /protected files: AGENTS.md/);
  assert.equal(await readFile(path.join(dir, 'AGENTS.md'), 'utf8'), 'changed by a faulty runner');
});

test('an implementation can align PROJECT.md with user instructions while preserving the harness', async t => {
  const dir = await temp(t);
  await mkdir(path.join(dir, 'spec'));
  await writeFile(path.join(dir, 'spec/PROJECT.md'), specification);
  await writeFile(path.join(dir, 'AGENTS.md'), 'existing user policy');
  const task = { task: 'User instruction: rename criterion AC-A to AC-INPUT consistently.' };
  const runner = async (command, args, options) => {
    if (command === 'git') return { ok: true, stdout: 'AGENTS.md\0spec/PROJECT.md\0' };
    assert.equal(command, 'codex');
    assert.ok(options.input.includes(task.task));
    await writeFile(path.join(dir, 'spec/PROJECT.md'), specification.replaceAll('AC-A', 'AC-INPUT'));
    await writeFile(path.join(options.env.HARNESS_AGENT_FAST_DIR, 'validation.json'), JSON.stringify({ ok: true, static: { ok: true }, gradle: { ok: true, stage: 'compile' }, validatedFiles: await snapshot(dir, runner) }));
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };
  await implement(dir, runner, { models: { implementer: 'gpt-6-sol' } }, path.join(dir, 'artifacts'), task);
  assert.equal(await readFile(path.join(dir, 'spec/PROJECT.md'), 'utf8'), specification.replaceAll('AC-A', 'AC-INPUT'));
  assert.equal(await readFile(path.join(dir, 'AGENTS.md'), 'utf8'), 'existing user policy');
});

test('compile failure is repaired and revalidated within one Codex invocation', async t => {
  const dir = await temp(t);
  for (const file of requiredFiles) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), file.endsWith('.json') ? '{}' : 'fixture');
  }
  const source = 'src/main/java/Example.java';
  const resource = 'src/main/resources/assets/test_input/models/a.json';
  await mkdir(path.dirname(path.join(dir, source)), { recursive: true });
  await mkdir(path.dirname(path.join(dir, resource)), { recursive: true });
  await writeFile(path.join(dir, source), 'broken');
  await writeFile(path.join(dir, resource), '{}');
  await writeFile(path.join(dir, 'gradle.properties'), properties);
  await writeFile(path.join(dir, 'spec/PROJECT.md'), specification.replace(/\| AC-([A-D]) \|[^\n]+/g, `| AC-$1 | static | ${resource} |`));
  let codexCalls = 0, validations = 0;
  const files = [...requiredFiles, source, resource].join('\0') + '\0';
  const gradle = async (command, args) => {
    if (command === 'git') return { ok: true, stdout: files };
    if (args.includes('tasks')) return { ok: true, stdout: requiredTasks.join('\n'), stderr: '' };
    validations++;
    const ok = (await readFile(path.join(dir, source), 'utf8')) === 'fixed';
    return { ok, code: ok ? 0 : 1, stdout: '', stderr: ok ? '' : 'Java compile error' };
  };
  const runner = async (command, _args, options) => {
    if (command === 'git') return { ok: true, stdout: files };
    codexCalls++;
    assert.match(options.input, /validate --agent-fast/);
    const fast = { agentFast: true, requireReady: true };
    await assert.rejects(() => validate(dir, gradle, options.env.HARNESS_AGENT_FAST_DIR, fast), /Java compile error/);
    await writeFile(path.join(dir, source), 'fixed');
    await validate(dir, gradle, options.env.HARNESS_AGENT_FAST_DIR, fast);
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };
  await implement(dir, runner, { models: { implementer: 'gpt-6-sol' } }, path.join(dir, 'candidate'), { task: 'Implement' });
  assert.equal(codexCalls, 1);
  assert.equal(validations, 2);
  assert.equal((await readFile(path.join(dir, source), 'utf8')), 'fixed');
});

test('repair prompt includes relevant AC and changed files without resending the specification', () => {
  const expanded = specification + 'Additional detail. '.repeat(1000);
  const initial = implementationPrompt(expanded, { task: 'Implement' });
  const repair = implementationPrompt(expanded, { repair: true, task: 'Correct review findings', findings: [{ problem: 'AC-B fails' }], changedFiles: ['src/Example.java'] });
  assert.match(repair, /AC-B: Synthetic criterion B/);
  assert.match(repair, /src\/Example.java/);
  assert.doesNotMatch(repair, /Additional detail/);
  assert.ok(repair.length < initial.length / 4);
});

test('harness mutation at a stage boundary stops instead of asking Codex to repair it', async () => {
  const actions = dryRunActions(async () => {});
  let dirty = false;
  actions.verify = async () => { dirty = true; };
  actions.guard = async () => { if (dirty) throw Object.assign(new Error('Protected harness changed'), { code: 'HARNESS_CHANGED' }); };
  const state = await developWorkflow(actions, budgets);
  assert.equal(state.status, 'failed'); assert.equal(state.codeAttempts, 1);
  assert.equal(state.codeReviews, 0); assert.equal(state.boots, 0);
  assert.match(state.error, /Protected harness/);
});

test('a final integrity failure preserves the original failure', async () => {
  const actions = dryRunActions(async () => {});
  actions.review = async () => { throw new Error('review service unavailable'); };
  let stopped = false;
  actions.stop = async () => { stopped = true; };
  actions.guard = async () => { if (stopped) throw new Error('Protected file changed during cleanup'); };
  const state = await developWorkflow(actions, budgets);
  assert.equal(state.status, 'failed'); assert.equal(state.error, 'review service unavailable');
  assert.equal(state.integrityError, 'Protected file changed during cleanup');
});

test('harness maintenance findings stop instead of triggering a Mod correction', async () => {
  const actions = dryRunActions(async () => {});
  actions.review = async () => ({ ...fail, findings: [{ ...finding, category: 'protected-input', severity: 'blocker', file: '.harness/config.json' }] });
  const state = await developWorkflow(actions, budgets);
  assert.equal(state.status, 'failed'); assert.equal(state.codeAttempts, 1);
  assert.equal(state.codeReviews, 1); assert.equal(state.boots, 0);
  assert.match(state.error, /Harness maintenance or user decision required/);
});

test('process timeout, output cap, abort, stdin and literal argv', async () => {
  const timed = await run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 30 });
  assert.equal(timed.failure, 'timeout');
  const capped = await run(process.execPath, ['-e', 'process.stdout.write("a".repeat(10000))'], { maxBytes: 100 });
  assert.equal(capped.failure, 'output limit');
  const controller = new AbortController(); controller.abort();
  assert.equal((await run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: controller.signal })).ok, false);
  const literal = '$(echo BAD) & "日本語"';
  const echoed = await run(process.execPath, ['-e', 'process.stdin.on("data",x=>process.stdout.write(x));process.stdout.write(process.argv[1])', literal], { input: literal });
  assert.equal(echoed.stdout, literal + literal);
});

test('Windows Gradle calls wrapper Java main without a shell', () => {
  const windows = gradleCommand('/project space', ['build'], 'win32', { JAVA_HOME: '/JDK 21' });
  assert.equal(windows.command, path.join('/JDK 21', 'bin', 'java.exe'));
  assert.ok(windows.args.includes('org.gradle.wrapper.GradleWrapperMain'));
  assert.ok(windows.args.includes('build'));
  assert.equal(gradleCommand('/repo', ['test'], 'linux').command, '/repo/gradlew');
  assert.ok(!gradleCommand('/repo', ['classes', 'test'], 'linux', {}).args.includes('--no-daemon'));
  assert.ok(gradleCommand('/repo', ['classes', 'test'], 'linux', { CI: 'true' }).args.includes('--no-daemon'));
});

test('agent-fast validation runs static checks and compile/unit without harness self-tests', async t => {
  const dir = await temp(t);
  const project = path.join(dir, 'project');
  await projectFixture(project);
  let gradleCalls = 0;
  const runner = async (command, args, options) => {
    if (command === 'git') return run(command, args, options);
    assert.equal(command, gradleCommand(project, ['classes', 'test']).command);
    if (args.includes('tasks')) return { ok: true, stdout: requiredTasks.join('\n'), stderr: '' };
    assert.ok(args.indexOf('classes') >= 0 && args[args.indexOf('classes') + 1] === 'test');
    assert.ok(args.includes('--no-daemon'));
    gradleCalls++;
    return { ok: true, code: 0, stdout: 'BUILD SUCCESSFUL', stderr: '' };
  };
  const result = await validate(project, runner, dir, { agentFast: true });
  assert.equal(gradleCalls, 1);
  assert.deepEqual(result.harness, { status: 'not-run' });
  assert.ok(result.validatedFiles['spec/PROJECT.md']);
});

test('subscription environment does not forward API credentials', () => {
  const env = subscriptionEnv({ PATH: 'x', OPENAI_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CODE_USE_BEDROCK: '1' });
  assert.deepEqual(env, { PATH: 'x' });
  assert.doesNotMatch(redact('api_key=verysecret sk-123456789012345678'), /verysecret|123456/);
});

test('classification is conservative and combines changes', () => {
  assert.equal(classify(['spec/PROJECT.md', 'docs/a.md']).e2e, false);
  assert.equal(classify(['src/main/java/mod/logic/Count.java']).e2e, false);
  assert.equal(classify(['src/main/java/mod/Block.java']).gameTest, true);
  assert.equal(classify(['src/main/java/mod/InventoryScreen.java']).restart, true);
  assert.deepEqual(classify(['src/main/resources/assets/foo/lang/en_us.json']).reload, ['resources']);
  assert.deepEqual(classify(['src/main/resources/data/foo/recipe/a.json']).reload, ['data']);
  assert.equal(classify(['src/main/resources/data/foo/worldgen/biome/a.json']).restart, true);
  assert.equal(classify(['src/main/resources/assets/foo/textures/network.png']).restart, false);
  assert.equal(classify(['src/main/templates/META-INF/neoforge.mods.toml']).restart, true);
  const mixed = classify(['src/main/resources/assets/foo/models/x.json', 'src/main/java/mod/network/Packet.java']);
  assert.equal(mixed.restart, true); assert.equal(mixed.visual, true);
  assert.equal(classify(['src/unknown.cfg']).restart, true);
  const scenarioOnly = classify(['tests/e2e/scenarios/input.scenario.mjs']);
  assert.equal(scenarioOnly.e2e, true); assert.equal(scenarioOnly.restart, false); assert.deepEqual(scenarioOnly.reload, []);
  assert.equal(classify(['tests/qualification/input.java']).e2e, false);
});

test('hash differences include modifications, additions and deletions', () => {
  assert.deepEqual(changedSince({ a: '1', b: '2' }, { a: '2', c: '3' }), ['a', 'b', 'c']);
});

test('strict structured review rejects prose, errors and contradictory results', () => {
  assert.deepEqual(parseReview(JSON.stringify({ subtype: 'success', structured_output: pass })), pass);
  for (const value of [JSON.stringify(pass), '```json\n{}\n```', JSON.stringify({ subtype: 'error_max_turns', structured_output: pass }), JSON.stringify({ subtype: 'success', result: JSON.stringify(pass) })]) assert.throws(() => parseReview(value));
  assert.throws(() => validateReview({ ...pass, findings: [finding] }), /Contradictory/);
  assert.throws(() => validateReview({ ...fail, findings: [{ ...finding, severity: 'critical' }] }));
  assert.throws(() => validateReview({ ...pass, other: true }));
  assert.throws(() => validateReview({ ...fail, findings: [] }));
  assert.deepEqual(validateReview({ ...pass, findings: [{ ...finding, severity: 'minor' }] }).verdict, 'pass');
});

test('review args provide no execution/edit/MCP tools', () => {
  const args = claudeArgs('opus', {});
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(flag));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('visual evidence includes accepted AC wording and referenced assets', () => {
  const source = specification.replace('No references.', '[reference](references/input.png)');
  const spec = visualSpecification(source, ['AC-D']);
  assert.equal(spec.requirements, 'AC-D: Synthetic visual requirement.');
  assert.deepEqual(spec.acceptanceCriteria, [{ id: 'AC-D', requirement: 'Synthetic criterion D.' }]);
  assert.deepEqual(spec.referenceFiles, ['spec/references/input.png']);
  assert.throws(() => visualSpecification(source.replace('references/input.png', '../private.png'), ['AC-D']), /inside spec\/references/);
});

test('schema keys match parser contract', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'schemas/review.schema.json'), 'utf8'));
  assert.deepEqual(schema.required.sort(), Object.keys(pass).sort());
  assert.deepEqual(schema.properties.findings.items.required.sort(), Object.keys(finding).sort());
  assert.equal(schema.additionalProperties, false);
});

test('template placeholders are rejected and independent complete input is accepted', async () => {
  const text = 'Status: draft\nTEMPLATE_NOT_CONFIGURED';
  assert.throws(() => parseSpec(text), /not ready/);
  assert.throws(() => parseSpec(text.replace('Status: draft', 'Status: ready')), /placeholder/);
  assert.equal(parseSpec(specification).modId, 'test_input');
  assert.throws(() => parseSpec(specification.replace('## Non-goals', '## Missing')), /Non-goals/);
  assert.throws(() => parseSpec(specification + '\nTODO'), /placeholder/);
});

test('no GameTest skips without calling Gradle; annotations and generators run it', async t => {
  const dir = await temp(t); await mkdir(path.join(dir, 'src/main/java'), { recursive: true });
  let calls = 0;
  const runner = async () => { calls++; return { ok: true, stdout: 'done', stderr: '' }; };
  assert.equal((await gameTest(dir, runner, path.join(dir, 'artifacts'))).status, 'not-applicable');
  assert.equal(calls, 0);
  await writeFile(path.join(dir, 'src/main/java/Test.java'), '// @GameTest\n/* @GameTestGenerator */\nclass Test {}');
  assert.equal(await hasGameTests(dir), false);
  await writeFile(path.join(dir, 'src/main/java/Test.java'), '@net.minecraft.gametest.framework.GameTestGenerator\nclass Test {}');
  assert.equal(await hasGameTests(dir), true);
  assert.equal((await gameTest(dir, runner, path.join(dir, 'artifacts'))).status, 'pass'); assert.equal(calls, 1);
});

test('resource reference extraction avoids registry IDs and texture variables', () => {
  assert.deepEqual(resourceReferences('src/main/resources/assets/foo/models/x.json', { parent: 'minecraft:block/cube_all', textures: { all: '#side', side: 'foo:block/test' } }), [['models', 'minecraft:block/cube_all', '.json'], ['textures', 'foo:block/test', '.png']]);
  assert.deepEqual(resourceReferences('src/main/resources/data/foo/recipe/a.json', { item: 'foo:registered_in_java' }), []);
});

test('resource validation reports deleted local files but accepts builtin and foreign references', async t => {
  const dir = await temp(t);
  const model = 'src/main/resources/assets/testmod/models/block/a.json';
  await mkdir(path.dirname(path.join(dir, model)), { recursive: true });
  await mkdir(path.join(dir, 'spec'));
  await writeFile(path.join(dir, 'gradle.properties'), 'mod_id=testmod\n');
  await writeFile(path.join(dir, 'spec/PROJECT.md'), 'Status: draft\n');
  await writeFile(path.join(dir, model), JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: 'testmod:block/deleted', side: 'othermod:block/external' } }));
  const runner = async () => ({ ok: true, stdout: `${model}\0src/main/resources/assets/testmod/textures/block/deleted.png\0` });
  const result = await staticValidation(dir, runner);
  assert.ok(result.errors.some(error => error.includes('missing local textures reference testmod:block/deleted')));
  assert.ok(!result.errors.some(error => error.includes('reference othermod') || error.includes('reference minecraft')));
});

test('repository static/documentation checks pass without Minecraft', async () => {
  const result = await harnessValidation(run);
  assert.deepEqual(result.errors, []);
});

test('dry-run executes review correction and visual reload in one boot', async () => {
  const records = [];
  const state = await developWorkflow(dryRunActions(async s => records.push(structuredClone(s))), budgets);
  assert.equal(state.status, 'pass'); assert.equal(state.boots, 1); assert.equal(state.codeReviews, 3); assert.equal(state.visualReviews, 2);
  assert.ok(state.events.indexOf('build') > state.events.indexOf('code-review'));
  assert.ok(state.events.indexOf('minecraft-start') > state.events.indexOf('gametest'));
  assert.ok(state.events.includes('resource-reload')); assert.ok(records.length > 5);
});

test('review cycles terminate and no game starts before pass', async () => {
  const actions = dryRunActions(async () => {}); actions.review = async () => fail;
  const state = await developWorkflow(actions, budgets);
  assert.equal(state.status, 'failed'); assert.equal(state.codeReviews, 3); assert.equal(state.boots, 0);
  assert.match(state.error, /budget exhausted/);
});

test('deterministic failures use bounded fixes and never reach reviewer/client', async () => {
  const actions = dryRunActions(async () => {}); actions.verify = async () => { throw new Error('compile failure'); };
  const state = await developWorkflow(actions, budgets);
  assert.equal(state.codeAttempts, 3); assert.equal(state.codeReviews, 0); assert.equal(state.boots, 0);
  assert.equal(state.status, 'failed');
});

test('game boot budget stops Java restart and keeps failure evidence', async () => {
  const actions = dryRunActions(async () => {}); actions.review = async () => pass;
  actions.classifyCorrection = async () => ({ restart: true, reload: [] });
  const state = await developWorkflow(actions, { ...budgets, gameBoots: 1 });
  assert.equal(state.status, 'failed'); assert.equal(state.boots, 1); assert.match(state.error, /boot budget/);
});

test('scenario-only corrections reuse the existing Minecraft session without reload', async () => {
  const actions = dryRunActions(async () => {}); actions.review = async () => pass;
  actions.classifyCorrection = async () => ({ restart: false, reload: [] });
  const state = await developWorkflow(actions, budgets);
  assert.equal(state.status, 'pass'); assert.equal(state.boots, 1); assert.ok(!state.events.includes('resource-reload'));
});

test('runtime failure is corrected then reruns batch without premature visual review', async () => {
  const actions = dryRunActions(async () => {}); actions.review = async () => pass;
  let calls = 0; actions.e2e = async () => { if (++calls === 1) throw new Error('runtime error'); return { screenshots: [] }; };
  actions.classifyCorrection = async () => ({ restart: true, reload: [] });
  const state = await developWorkflow(actions, budgets);
  assert.equal(state.status, 'pass'); assert.equal(state.boots, 2); assert.equal(state.visualReviews, 0);
});

test('build/GameTest failure is corrected through verification and code re-review', async () => {
  const actions = dryRunActions(async () => {}); actions.review = async () => pass;
  actions.classify = async () => ({ e2e: false });
  let builds = 0; actions.build = async () => { if (++builds === 1) throw new Error('packaging failed'); };
  const state = await developWorkflow(actions, budgets);
  assert.equal(state.status, 'pass'); assert.equal(state.codeReviews, 2); assert.equal(state.boots, 0);
});

test('reviewer service failure is not converted into a Mod correction', async () => {
  const actions = dryRunActions(async () => {}); actions.review = async () => pass;
  actions.visual = async () => { throw new Error('authentication expired'); };
  const state = await developWorkflow(actions, budgets);
  assert.equal(state.status, 'failed'); assert.equal(state.codeAttempts, 1); assert.match(state.error, /authentication/);
});

test('no runtime changes and failed cleanup are explicit', async () => {
  const actions = dryRunActions(async () => {}); actions.review = async () => pass; actions.classify = async () => ({ e2e: false });
  assert.equal((await developWorkflow(actions, budgets)).boots, 0);
  actions.stop = async () => { throw new Error('cleanup failure'); };
  assert.equal((await developWorkflow(actions, budgets)).status, 'failed');
});

test('local address rejects remote hosts, DNS aliases and invalid ports', () => {
  assert.equal(localAddress('127.0.0.1:25575'), 25575);
  for (const address of ['localhost:25565', 'example.org:25565', '127.0.0.1:99999', '127.0.0.1:80']) assert.throws(() => localAddress(address));
});

test('MC Pilot validates both CLI and action success without shell execution', async t => {
  const fixture = await temp(t);
  const runner = async (_cmd, args) => { assert.equal(args.at(-1), 'all'); return { ok: true, stdout: JSON.stringify({ success: true, data: { success: true, data: { world: true } } }) }; };
  assert.deepEqual(await mct(fixture, runner, ['status', 'all']), { world: true });
  await assert.rejects(() => mct(fixture, async () => ({ ok: true, stdout: '{"success":true,"data":{"success":false,"error":"NO_WORLD"}}' }), ['status', 'all']), /action failed/);
});

test('generated packs update/delete their own resources but never take over user packs', async t => {
  const dir = await temp(t); const pack = path.join(dir, 'pack');
  const source = path.join(dir, 'src/main/resources/assets/foo/lang');
  await mkdir(source, { recursive: true }); await writeFile(path.join(source, 'en_us.json'), '{"x":"first"}');
  await syncPack(dir, pack, 'assets');
  assert.equal(JSON.parse(await readFile(path.join(pack, 'pack.mcmeta'))).pack.pack_format, 34);
  await rm(path.join(source, 'en_us.json')); await syncPack(dir, pack, 'assets');
  await assert.rejects(() => readFile(path.join(pack, 'assets/foo/lang/en_us.json')), /ENOENT/);
  const userPack = path.join(dir, 'user-pack'); await mkdir(userPack); await writeFile(path.join(userPack, 'keep.txt'), 'user data');
  await assert.rejects(() => syncPack(dir, userPack, 'assets'), /Refusing/);
  assert.equal(await readFile(path.join(userPack, 'keep.txt'), 'utf8'), 'user data');
});

test('visual options preserve unrelated settings and enable the generated pack', async t => {
  const dir = await temp(t); await writeFile(path.join(dir, 'options.txt'), 'unrelated:true\nfov:1\n');
  await prepareOptions(dir); const result = await readFile(path.join(dir, 'options.txt'), 'utf8');
  assert.match(result, /unrelated:true/); assert.match(result, /fov:0/); assert.match(result, /file\/harness-resources/);
});

test('early display preparation creates config and is idempotent', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'config/fml.toml');
  await prepareEarlyDisplay(dir);
  assert.equal(await readFile(file, 'utf8'), 'earlyWindowControl = false\n');
  await prepareEarlyDisplay(dir);
  assert.equal(await readFile(file, 'utf8'), 'earlyWindowControl = false\n');
});

test('early display preparation preserves comments, CRLF and unrelated table settings', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'config/fml.toml');
  await mkdir(path.dirname(file));
  const original = '# FML\r\n  earlyWindowControl = true # splash\r\nmaxThreads = -1\r\n[dependencyOverrides]\r\nearlyWindowControl = ["+example"]';
  await writeFile(file, original);
  await prepareEarlyDisplay(dir);
  assert.equal(await readFile(file, 'utf8'), original.replace('= true', '= false'));
  const withoutRootSetting = '# FML\n[dependencyOverrides]\nearlyWindowControl = ["+example"]';
  await writeFile(file, withoutRootSetting);
  await prepareEarlyDisplay(dir);
  assert.equal(await readFile(file, 'utf8'), 'earlyWindowControl = false\n' + withoutRootSetting);
});

test('managed server stop sends a save/stop command before forced termination', async () => {
  const controller = new AbortController();
  const result = await run(process.execPath, ['-e', 'process.stdout.write("ready");process.stdin.on("data",s=>{if(s.toString()==="stop\\n"){process.stdout.write("saved");process.exit(0)}})'], {
    signal: controller.signal, stopInput: 'stop\n', onOutput: text => { if (text.includes('ready')) controller.abort(); }
  });
  assert.equal(result.code, 0); assert.match(result.stdout, /saved/);
});

test('real MC Pilot adapter batches mocked CLI actions and preserves worlds on cleanup/failure', async t => {
  const dir = await temp(t);
  const clientDir = path.join(dir, '.harness-artifacts/mct-home/clients/mcmod-fixture/minecraft');
  const serverDir = path.join(dir, '.harness-artifacts/server');
  const files = {
    'gradle.properties': 'neo_version=21.1.252\nmod_id=test_input\nmod_version=2\n', 
     'build/libs/test_input-2.jar': 'current build',
    'build/libs/test_input-1.jar': 'old version', 'build/libs/old_id-2.jar': 'old identity',
    '.harness-artifacts/e2e-runtime.json': JSON.stringify({ client: 'mcmod-fixture', address: '127.0.0.1:25579' }),
    '.harness-artifacts/server/eula.txt': 'eula=true\n',
    '.harness-artifacts/server/server.properties': 'server-ip=127.0.0.1\nserver-port=25579\nonline-mode=false\nlevel-name=world\n',
    '.harness-artifacts/server/world/keep.txt': 'world data',
    [`.harness-artifacts/server/libraries/net/neoforged/neoforge/21.1.252/${process.platform === 'win32' ? 'win' : 'unix'}_args.txt`]: ''
  };
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), text); }
  await mkdir(path.join(serverDir, 'logs'), { recursive: true });
  await mkdir(path.join(dir, '.harness-artifacts/mct-home/logs'), { recursive: true });
  let running = false, cleaned = 0, launches = 0;
  const runner = async (command, args, options = {}) => {
    if (command === 'java') {
      await writeFile(path.join(serverDir, 'logs/latest.log'), 'INFO Started\n');
      options.onOutput('Done (1.0s)!');
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      return { ok: true, code: 0, signal: null, stdout: 'stopped', stderr: '' };
    }
    const cli = args.slice(1); let data;
    if (cli[0] === 'client' && cli[1] === 'list') data = { clients: [{ name: 'mcmod-fixture', account: 'TestPlayer', loader: 'neoforge', mcVersion: '1.21.1', wsPort: 25580, running, launchArgs: ['--version-id', 'neoforge-21.1.252', '--game-dir', clientDir] }] };
    else if (cli[0] === 'client' && cli[1] === 'launch') {
      assert.equal(await readFile(path.join(clientDir, 'config/fml.toml'), 'utf8'), 'earlyWindowControl = false\n');
      assert.equal(cli[cli.indexOf('--ws-port') + 1], '25580'); running = true; launches++;
      await writeFile(path.join(dir, '.harness-artifacts/mct-home/logs/client-mcmod-fixture.log'), 'INFO joined\n'); data = {};
    }
    else if (cli[0] === 'client' && cli[1] === 'wait-ready') data = { connected: true, inWorld: true };
    else if (cli[0] === 'client' && cli[1] === 'stop') { running = false; data = { stopped: true }; }
    else data = { success: true, data: { x: 0.5 } };
    return { ok: true, stdout: JSON.stringify({ success: true, data }), stderr: '' };
  };
  const checkedPorts = [];
  const session = await createSession(dir, runner, path.join(dir, 'evidence'), { checkPort: async port => { checkedPorts.push(port); return port || 25580; } });
  try {
    await session.start();
    const scenario = { id: 'fixture', visual: false, setup: async () => {}, actions: async () => {}, assertions: async ({ mct }) => assert.equal((await mct(['position', 'get'])).x, 0.5), cleanup: async () => { cleaned++; } };
    assert.equal((await session.batch([scenario, { ...scenario, id: 'second' }], 0)).results.length, 2);
    await assert.rejects(() => session.batch([{ ...scenario, assertions: async () => { throw new Error('state mismatch'); } }], 1), /state mismatch/);
    assert.equal(cleaned, 3); assert.equal(launches, 1);
    assert.throws(() => session.query(['client', 'launch', 'other']), /lifecycle/);
    assert.throws(() => session.query(['--client', 'other', 'client', 'launch', 'other']), /lifecycle/);
    assert.throws(() => session.query(['status', 'all', '--client=other']), /test target/);
  } finally { await session.stop(); }
  assert.equal(running, false);
  assert.deepEqual(checkedPorts, [25579, 0]);
  for (const base of [serverDir, clientDir]) assert.equal(await readFile(path.join(base, 'mods/harness-under-test.jar'), 'utf8'), 'current build');
  await writeFile(path.join(dir, 'gradle.properties'), 'neo_version=21.1.252\nmod_id=test_input\nmod_version=3\n');
  await assert.rejects(() => session.start(), /test_input-3\.jar/);
  assert.equal(launches, 1);
  assert.equal(await readFile(path.join(serverDir, 'world/keep.txt'), 'utf8'), 'world data');
});

test('log windows ignore old errors; suppression is exact and preserves other failures', async t => {
  const dir = await temp(t); const file = path.join(dir, 'latest.log');
  await writeFile(file, 'ERROR old\n'); const mark = await logMark(file);
  await writeFile(file, 'ERROR old\nINFO scenario\nERROR new\n');
  const text = await logsAfter(file, mark); assert.doesNotMatch(text, /old/); assert.match(relevantLogs(text), /new/);
  assert.equal(relevantLogs('[10:00:00] ERROR benign', [{ message: 'ERROR benign', reason: 'fixture' }]), '');
  assert.match(relevantLogs('[10:00:00] ERROR benign-extra', [{ message: 'ERROR benign', reason: 'fixture' }]), /benign-extra/);
  const neo = '[30Sep2026 11:21:38.209] [Server thread/ERROR] [example.Logger/]: known fixture message';
  assert.equal(relevantLogs(neo, [{ message: '[Server thread/ERROR] [example.Logger/]: known fixture message', reason: 'fixture' }]), '');
  assert.match(relevantLogs(neo.replace('fixture message', 'different failure'), [{ message: '[Server thread/ERROR] [example.Logger/]: known fixture message', reason: 'fixture' }]), /different failure/);
});

test('AC coverage rejects an uncovered required criterion before any process starts', async t => {
  const { acceptanceCoverage } = await import('../lib/coverage.mjs');
  const dir = await temp(t);
  await mkdir(path.join(dir, 'spec'), { recursive: true });
  await writeFile(path.join(dir, 'spec/PROJECT.md'), specification.replace(/^\| AC-B .*\n/m, ''));
  await assert.rejects(() => acceptanceCoverage(dir, path.join(dir, 'evidence')), /AC-B: no verification assigned/);
  const report = JSON.parse(await readFile(path.join(dir, 'evidence/acceptance-coverage.json')));
  assert.equal(report.executed, false); assert.equal(report.status, 'failed');
});

test('AC coverage validates reverse scenario/visual/persistence mappings', async t => {
  const { acceptanceCoverage } = await import('../lib/coverage.mjs');
  const dir = await temp(t);
  await mkdir(path.join(dir, 'spec'), { recursive: true });
  await mkdir(path.join(dir, 'tests/e2e/scenarios'), { recursive: true });
  await writeFile(path.join(dir, 'spec/PROJECT.md'), specification);
  for (const [id, ac, phase, visual] of [['case-a', ['AC-A', 'AC-D'], 'candidate', true], ['case-b', ['AC-B'], 'after-restart', false], ['case-c', ['AC-C'], 'candidate', false]]) {
    await writeFile(path.join(dir, `tests/e2e/scenarios/${id}.scenario.mjs`), `export default {id:${JSON.stringify(id)},acceptanceCriteria:${JSON.stringify(ac)},phase:${JSON.stringify(phase)},visual:${visual},players:2,verification:['multiplayer'],setup:async()=>{},actions:async()=>{},assertions:async()=>{},cleanup:async()=>{},screenshots:${visual ? "[{id:'point',criteria:['Synthetic visual requirement.'],prepare:async()=>{},assertState:async()=>{}}]" : '[]'}}`);
  }
  assert.equal((await acceptanceCoverage(dir, path.join(dir, 'evidence'))).percent, 100);
  const updatedSpec = specification.replaceAll('AC-A', 'AC-INPUT');
  await writeFile(path.join(dir, 'spec/PROJECT.md'), updatedSpec);
  const scenarioFile = path.join(dir, 'tests/e2e/scenarios/case-a.scenario.mjs');
  await writeFile(scenarioFile, (await readFile(scenarioFile, 'utf8')).replaceAll('AC-A', 'AC-INPUT'));
  const updated = await acceptanceCoverage(dir, path.join(dir, 'evidence'));
  assert.equal(updated.percent, 100);
  assert.deepEqual(updated.scenarios.find(s => s.id === 'case-a').acceptanceCriteria, ['AC-INPUT', 'AC-D']);
  await writeFile(path.join(dir, 'spec/PROJECT.md'), updatedSpec.replace('case-a/point', 'case-a/missing'));
  await assert.rejects(() => acceptanceCoverage(dir, path.join(dir, 'evidence')), /visual evidence/);
});

test('persistence spends a second boot and cannot bypass the game budget', async () => {
  const actions = dryRunActions(async () => {});
  actions.review = async () => pass; actions.visual = async () => pass;
  actions.e2e = async () => ({ screenshots: [], requiresRestart: true });
  let persistence = 0;
  actions.e2ePersistence = async () => { persistence++; return { screenshots: [] }; };
  const result = await developWorkflow(actions, budgets);
  assert.equal(result.status, 'pass'); assert.equal(result.boots, 2); assert.equal(persistence, 1);
  const limited = await developWorkflow(actions, { ...budgets, gameBoots: 1 });
  assert.equal(limited.status, 'failed'); assert.equal(limited.boots, 1); assert.equal(persistence, 1);
  assert.equal(limited.codeAttempts, 1); assert.match(limited.error, /Game boot budget exhausted/);
});

test('a scenario-only candidate executes runtime evidence instead of a zero-boot pass', async () => {
  const actions = dryRunActions(async () => {});
  actions.review = async () => pass;
  actions.classify = async () => classify(['tests/e2e/scenarios/new-acceptance.scenario.mjs']);
  let batches = 0;
  actions.e2e = async () => { batches++; return { screenshots: [] }; };
  const result = await developWorkflow(actions, budgets);
  assert.equal(result.status, 'pass'); assert.equal(result.boots, 1); assert.equal(batches, 1);
});
