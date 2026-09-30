import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, requireSuccess, gradleCommand, subscriptionEnv, redact } from '../lib/process.mjs';
import { classify, changedSince } from '../lib/repository.mjs';
import { parseSpec, hasGameTests, gameTest, resourceReferences, staticValidation } from '../lib/validate.mjs';
import { parseReview, validateReview, claudeArgs, visualSpecification } from '../lib/agents.mjs';
import { localAddress, relevantLogs, mct, logMark, logsAfter, syncPack, prepareOptions, createSession } from '../lib/mc-pilot.mjs';
import { developWorkflow, dryRunActions } from '../lib/workflow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pass = { verdict: 'pass', findings: [], summary: 'No blocking findings' };
const finding = { severity: 'major', category: 'correctness', file: 'x.mjs', location: '1', problem: 'A fails', required_change: 'Fix A', reason: 'AC fails' };
const fail = { verdict: 'changes_required', findings: [finding], summary: 'Correction required' };
const budgets = { codeReviews: 3, gameBoots: 2, visualReviews: 2 };
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

test('visual evidence includes accepted AC wording and referenced assets', async () => {
  const source = (await readFile(path.join(root, 'spec/PROJECT.template.md'), 'utf8'))
    .replace('現在なし。参考画像を追加する場合は', '[color](references/copper.png) を使用。参考画像を追加する場合は');
  const spec = visualSpecification(source, ['AC-VISUAL']);
  assert.match(spec.requirements, /銅/);
  assert.match(spec.acceptanceCriteria.find(item => item.id === 'AC-VISUAL').requirement, /白い目盛り/);
  assert.deepEqual(spec.referenceFiles, ['spec/references/copper.png']);
  assert.throws(() => visualSpecification(source.replace('references/copper.png', '../private.png'), ['AC-VISUAL']), /inside spec\/references/);
});

test('schema keys match parser contract', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'harness/schemas/review.schema.json'), 'utf8'));
  assert.deepEqual(schema.required.sort(), Object.keys(pass).sort());
  assert.deepEqual(schema.properties.findings.items.required.sort(), Object.keys(finding).sort());
  assert.equal(schema.additionalProperties, false);
});

test('placeholder is rejected but template-based completed specification is accepted', async () => {
  assert.throws(() => parseSpec('Status: draft\nTEMPLATE_NOT_CONFIGURED'), /not ready/);
  const example = (await readFile(path.join(root, 'spec/PROJECT.template.md'), 'utf8')).replace('Status: draft', 'Status: ready');
  assert.equal(parseSpec(example).modId, 'copper_counter');
  assert.throws(() => parseSpec(example.replace('## Non-goals', '## Missing')), /Non-goals/);
  assert.throws(() => parseSpec(example + '\nTODO'), /placeholder/);
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
  const result = await staticValidation(root, run);
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
  await mkdir(path.join(fixture, 'node_modules/@kzheart_/mc-pilot/bin'), { recursive: true });
  await writeFile(path.join(fixture, 'node_modules/@kzheart_/mc-pilot/bin/mct'), 'mock');
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
    'gradle.properties': 'neo_version=21.1.252\n', 'harness/log-allowlist.json': '[]',
    'node_modules/@kzheart_/mc-pilot/bin/mct': '', 'build/libs/test.jar': 'fixture',
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
      return { ok: true, stdout: 'stopped', stderr: '' };
    }
    const cli = args.slice(1); let data;
    if (cli[0] === 'client' && cli[1] === 'list') data = { clients: [{ name: 'mcmod-fixture', loader: 'neoforge', mcVersion: '1.21.1', wsPort: 25580, running, launchArgs: ['--version-id', 'neoforge-21.1.252', '--game-dir', clientDir] }] };
    else if (cli[0] === 'client' && cli[1] === 'launch') { running = true; launches++; await writeFile(path.join(dir, '.harness-artifacts/mct-home/logs/client-mcmod-fixture.log'), 'INFO joined\n'); data = {}; }
    else if (cli[0] === 'client' && cli[1] === 'wait-ready') data = { connected: true, inWorld: true };
    else if (cli[0] === 'client' && cli[1] === 'stop') { running = false; data = { stopped: true }; }
    else data = { success: true, data: { x: 0.5 } };
    return { ok: true, stdout: JSON.stringify({ success: true, data }), stderr: '' };
  };
  const checkedPorts = [];
  const session = await createSession(dir, runner, path.join(dir, 'evidence'), { checkPort: async port => checkedPorts.push(port) });
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
  assert.deepEqual(checkedPorts, [25579, 25580]);
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
