import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSession, loadScenarios } from '../lib/mc-pilot.mjs';
import { developWorkflow, dryRunActions } from '../lib/workflow.mjs';

const pass = { verdict: 'pass', findings: [], summary: 'Test input accepted' };
const scenario = {
  id: 'two-players', players: 2, verification: ['multiplayer'], acceptanceCriteria: ['AC-A'], visual: false,
  setup: async () => {}, actions: async () => {}, assertions: async () => {}, screenshots: [], cleanup: async () => {}
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-multiplayer-'));
  const server = path.join(root, '.harness-artifacts/server');
  const evidence = path.join(root, 'evidence');
  const clients = [1, 2].map(index => ({
    name: `mcmod-test-${index}`, account: `TestPlayer${index}`, loader: 'neoforge', mcVersion: '1.21.1', running: false,
    launchArgs: ['--version-id', 'neoforge-21.1.252', '--game-dir', path.join(root, `.harness-artifacts/mct-home/clients/mcmod-test-${index}/minecraft`)]
  }));
  const files = {
    'gradle.properties': 'neo_version=21.1.252\nmod_id=test_input\nmod_version=1\n',
    'build/libs/test_input-1.jar': 'test archive', 'harness/log-allowlist.json': '[]',
    'node_modules/@kzheart_/mc-pilot/bin/mct': '',
    '.harness-artifacts/e2e-runtime.json': JSON.stringify({ clients: clients.map(client => client.name), address: '127.0.0.1:25579' }),
    '.harness-artifacts/server/eula.txt': 'eula=true\n',
    '.harness-artifacts/server/server.properties': 'server-ip=127.0.0.1\nserver-port=25579\nonline-mode=false\nlevel-name=world\nmax-players=2\n',
    '.harness-artifacts/server/world/keep.txt': 'user world',
    [`.harness-artifacts/server/libraries/net/neoforged/neoforge/21.1.252/${process.platform === 'win32' ? 'win' : 'unix'}_args.txt`]: ''
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text);
  }
  await mkdir(path.join(server, 'logs'), { recursive: true });
  await mkdir(path.join(root, '.harness-artifacts/mct-home/logs'), { recursive: true });
  const commands = [], sessions = [];
  const control = { failLaunch: null, disconnected: null, failStop: null, serverStarts: 0, serverStops: 0 };
  let nextPort = 30000;
  const runner = async (command, args, options) => {
    if (command === 'java') {
      control.serverStarts++;
      await writeFile(path.join(server, 'logs/latest.log'), 'INFO server ready\n');
      options.onOutput('Done (0.1s)!');
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      control.serverStops++;
      return { ok: true, code: 0, stdout: '', stderr: '' };
    }
    const cli = args.slice(1); commands.push(cli);
    let data = {};
    if (cli[0] === 'client') {
      const client = clients.find(item => item.name === cli[2]);
      if (cli[1] === 'list') data = { clients };
      if (cli[1] === 'launch') {
        client.running = true;
        await writeFile(path.join(root, `.harness-artifacts/mct-home/logs/client-${client.name}.log`), 'INFO joined\n', { flag: 'a' });
        if (control.failLaunch === client.name) return { ok: false, failure: 'launch failed', stdout: '', stderr: '' };
      }
      if (cli[1] === 'wait-ready') data = { connected: control.disconnected !== client.name, inWorld: control.disconnected !== client.name };
      if (cli[1] === 'stop') {
        if (control.failStop === client.name) return { ok: false, failure: 'stop failed', stdout: '', stderr: '' };
        client.running = false;
      }
    } else {
      assert.equal(cli[0], '--client');
      const client = clients.find(item => item.name === cli[1]);
      assert.ok(client, 'query must target a prepared client');
      data = { player: client.account };
      if (cli[2] === 'screenshot') {
        const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
        png.writeUInt32BE(854, 16); png.writeUInt32BE(480, 20);
        await writeFile(cli[cli.indexOf('--output') + 1], png);
      }
    }
    return { ok: true, stdout: JSON.stringify({ success: true, data }), stderr: '' };
  };
  t.after(async () => {
    control.failStop = null;
    try { for (const session of sessions) await session.stop(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, server, evidence, clients, control, commands,
    async open(playerCount = 2) {
      const session = await createSession(root, runner, evidence, { playerCount, checkPort: async port => port || nextPort++ });
      sessions.push(session); return session;
    }
  };
}

test('two clients share one server, route actions and screenshots, reload and stop together', async t => {
  const f = await fixture(t), session = await f.open();
  await session.start();
  const result = await session.batch([{
    ...scenario, visual: true,
    assertions: async ({ clients, mct }) => {
      assert.deepEqual(clients.map(client => client.name), ['TestPlayer1', 'TestPlayer2']);
      assert.equal((await mct(['status', 'all'])).player, 'TestPlayer1');
      for (const client of clients) assert.equal((await client.mct(['status', 'all'])).player, client.name);
    },
    screenshots: [{ id: 'observer', client: 1, criteria: ['Synthetic visual criterion'], prepare: async () => {},
      assertState: async ({ mct }) => assert.equal((await mct(['status', 'all'])).player, 'TestPlayer2') }]
  }, scenario], 0);
  assert.equal(f.control.serverStarts, 1); assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0].players, ['TestPlayer1', 'TestPlayer2']);
  assert.equal(result.screenshots[0].player, 'TestPlayer2');
  assert.equal(result.screenshots[0].client, 'mcmod-test-2');
  const launches = f.commands.filter(args => args[1] === 'launch');
  assert.equal(launches.length, 2); assert.notEqual(launches[0].at(-1), launches[1].at(-1));
  await session.reload(['resources', 'data']);
  assert.deepEqual(f.commands.filter(args => args.includes('combo')).map(args => args[1]), ['mcmod-test-1', 'mcmod-test-2']);
  assert.equal(f.commands.filter(args => args.includes('reload')).length, 1);
  assert.throws(() => session.query(['status', 'all'], 2), /Unknown session client/);
  assert.throws(() => session.query(['status', 'all', '--client=outside'], 1), /test target/);
  await session.stop();
  assert.ok(f.clients.every(client => !client.running)); assert.equal(f.control.serverStops, 1);
  assert.equal(await readFile(path.join(f.server, 'world/keep.txt'), 'utf8'), 'user world');
});

test('preflight rejects insufficient clients, shared accounts and already running instances', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.open(3), /Prepare 3 clients/);
  f.clients[1].account = f.clients[0].account;
  await assert.rejects(() => f.open(), /distinct offline usernames/);
  f.clients[1].account = 'TestPlayer2'; f.clients[1].running = true;
  await assert.rejects(() => f.open(), /already running/);
  assert.equal(f.control.serverStarts, 0);
  assert.ok(!f.commands.some(args => args[1] === 'stop'));
});

test('a partially failed launch still stops both owned clients and the shared server', async t => {
  const f = await fixture(t), session = await f.open();
  f.control.failLaunch = 'mcmod-test-2';
  await assert.rejects(() => session.start(), /launch failed/);
  await session.stop();
  assert.deepEqual(f.commands.filter(args => args[1] === 'stop').map(args => args[2]), ['mcmod-test-1', 'mcmod-test-2']);
  assert.equal(f.control.serverStops, 1); assert.ok(f.clients.every(client => !client.running));
});

test('one client stop failure does not prevent cleanup of the peer or server', async t => {
  const f = await fixture(t), session = await f.open();
  await session.start(); f.control.failStop = 'mcmod-test-1';
  await assert.rejects(() => session.stop(), { code: 'CLEANUP_FAILED' });
  assert.equal(f.clients[1].running, false); assert.equal(f.control.serverStops, 1);
  f.control.failStop = null; await session.stop();
  assert.equal(f.clients[0].running, false);
});

test('a disconnected peer or errors in its log cannot pass a multiplayer batch', async t => {
  const f = await fixture(t), session = await f.open();
  await session.start(); f.control.disconnected = 'mcmod-test-2';
  await assert.rejects(() => session.batch([scenario], 0), /not connected.*mcmod-test-2/);
  f.control.disconnected = null;
  await assert.rejects(() => session.batch([{
    ...scenario, actions: async () => writeFile(path.join(f.root, '.harness-artifacts/mct-home/logs/client-mcmod-test-2.log'), 'ERROR peer failure\n', { flag: 'a' })
  }], 1), /mcmod-test-2[\s\S]*peer failure/);
  const result = JSON.parse(await readFile(path.join(f.evidence, 'e2e-1.json')));
  assert.equal(result.status, 'failed'); assert.deepEqual(result.results, []);
  await session.reload(['resources']);
  await writeFile(path.join(f.root, '.harness-artifacts/mct-home/logs/client-mcmod-test-2.log'), 'ERROR peer reload failure\n', { flag: 'a' });
  await assert.rejects(() => session.batch([scenario], 2), /mcmod-test-2[\s\S]*peer reload failure/);
});

test('multiplayer and screenshot metadata reject an insufficient or unknown player', async t => {
  const f = await fixture(t), scenarioDir = path.join(f.root, 'tests/e2e/scenarios');
  await mkdir(scenarioDir, { recursive: true });
  const write = (players, client = 0) => writeFile(path.join(scenarioDir, 'input.scenario.mjs'),
    `export default {id:'input',acceptanceCriteria:['AC-A'],players:${players},verification:['multiplayer'],visual:true,setup:async()=>{},actions:async()=>{},assertions:async()=>{},cleanup:async()=>{},screenshots:[{id:'view',client:${client},criteria:['test'],prepare:async()=>{},assertState:async()=>{}}]}`);
  await write(1); await assert.rejects(() => loadScenarios(f.root, ['AC-A']), /at least two players/);
  await write(2, 2); await assert.rejects(() => loadScenarios(f.root, ['AC-A']), /Screenshot client/);
  await write(2, 1); assert.equal((await loadScenarios(f.root, ['AC-A']))[0].players, 2);
});

test('the game budget counts each multiplayer client, including persistence restarts', async () => {
  const actions = dryRunActions(async () => {});
  actions.review = async () => pass; actions.preflight = async () => 2;
  actions.e2e = async () => ({ screenshots: [] });
  let starts = 0; actions.start = async () => { starts++; };
  const budgets = { codeReviews: 3, gameBoots: 2, visualReviews: 2 };
  const accepted = await developWorkflow(actions, budgets);
  assert.equal(accepted.status, 'pass'); assert.equal(accepted.boots, 2); assert.equal(accepted.sessions, 1);
  actions.e2e = async () => ({ screenshots: [], requiresRestart: true });
  actions.e2ePersistence = async () => ({ screenshots: [] });
  const limited = await developWorkflow(actions, budgets);
  assert.equal(limited.status, 'failed'); assert.match(limited.error, /boot budget/);
  assert.equal(limited.boots, 2); assert.equal(starts, 2);
  const persisted = await developWorkflow(actions, { ...budgets, gameBoots: 4 });
  assert.equal(persisted.status, 'pass'); assert.equal(persisted.boots, 4); assert.equal(persisted.sessions, 2);
  actions.stop = async () => { throw new Error('A client did not stop'); };
  const failedCleanup = await developWorkflow(actions, budgets);
  assert.equal(failedCleanup.status, 'failed'); assert.equal(failedCleanup.sessionStopped, false);
  assert.equal(failedCleanup.cleanupError, 'A client did not stop');
});

test('failed multiplayer shutdown never requests a Mod correction or another boot', async () => {
  const actions = dryRunActions(async () => {});
  actions.review = async () => pass; actions.preflight = async () => 2;
  actions.e2e = async () => ({ screenshots: [], requiresRestart: true });
  actions.stop = async () => { throw Object.assign(new Error('A client did not stop'), { code: 'CLEANUP_FAILED' }); };
  let starts = 0; actions.start = async () => { starts++; };
  const result = await developWorkflow(actions, { codeReviews: 3, gameBoots: 4, visualReviews: 2 });
  assert.equal(result.status, 'failed'); assert.equal(result.sessionStopped, false);
  assert.equal(result.codeAttempts, 1); assert.equal(starts, 1);
  assert.equal(result.error, 'A client did not stop');
});

test('an exhausted multiplayer runtime cycle preserves its failure in the summary', async () => {
  const actions = dryRunActions(async () => {});
  actions.review = async () => pass; actions.preflight = async () => 2;
  actions.e2e = async () => { throw new Error('Peer did not receive the update'); };
  const result = await developWorkflow(actions, { codeReviews: 3, gameBoots: 2, visualReviews: 1 });
  assert.equal(result.status, 'failed'); assert.equal(result.codeAttempts, 1);
  assert.deepEqual(result.lastFailure.failures, ['Peer did not receive the update']);
});
