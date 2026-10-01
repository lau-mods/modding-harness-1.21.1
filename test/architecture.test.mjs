import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { harnessRoot } from '../lib/paths.mjs';
import { run, requireSuccess } from '../lib/process.mjs';
import { loadConfig, walk, snapshot, assertHarnessUnchanged } from '../lib/repository.mjs';
import { staticValidation, gradleContract, requiredTasks, validate } from '../lib/validate.mjs';
import { doctor } from '../lib/doctor.mjs';
import { review } from '../lib/agents.mjs';
import { mct } from '../lib/mc-pilot.mjs';
import { projectFixture } from './fixtures.mjs';

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-architecture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// These inputs intentionally contain no template, npm package, docs, or CLAUDE.md.
test('existing project contract is independent of harness configuration and template files', async t => {
  const dir = await temporary(t);
  await projectFixture(dir);
  await writeFile(path.join(dir, 'config.json'), '{"models":{"reviewer":"wrong"}}');
  assert.equal((await staticValidation(dir, run)).ok, true);
  assert.equal((await loadConfig({})).models.reviewer, 'opus');
  assert.equal((await loadConfig({ HARNESS_GAME_BOOTS: '4', HARNESS_GAME_TEST: 'required' })).budgets.gameBoots, 4);
  await assert.rejects(loadConfig({ HARNESS_GAME_BOOTS: '0' }), /Invalid budget/);
  await rm(path.join(dir, 'spec/PROJECT.md'));
  const missing = await staticValidation(dir, run);
  assert.ok(missing.errors.includes('Missing required file: spec/PROJECT.md'));
  await rm(path.join(dir, 'gradle.properties'));
  assert.ok((await staticValidation(dir, run)).errors.some(value => value.includes('mod_id')));
});

test('submodule-shaped CLI uses invocation project and explicit --project without template', async t => {
  const dir = await temporary(t), system = path.join(dir, 'system'), runtime = path.join(system, '.harness');
  await projectFixture(system);
  await writeFile(path.join(system, 'spec/PROJECT.md'), '# Project\nMod ID: test_input\n## Requirements\nA synthetic behavior is observable in the game.\n');
  await writeFile(path.join(system, '.gitignore'), '.harness-artifacts/\n.harness/\nconfig.json\n');
  requireSuccess(await run('git', ['add', '.'], { cwd: system }), 'fixture stage');
  requireSuccess(await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture baseline'], { cwd: system }), 'fixture commit');
  await mkdir(runtime);
  for (const name of ['cli.mjs', 'lib', 'config.json', 'prompts', 'schemas', 'docs', 'log-allowlist.json']) {
    await cp(path.join(harnessRoot, name), path.join(runtime, name), { recursive: true });
  }
  await writeFile(path.join(system, 'config.json'), 'invalid project decoy');
  for (const [cwd, args] of [[system, []], [dir, ['--project', system]]]) {
    const result = await run(process.execPath, [path.join(runtime, 'cli.mjs'), 'develop', '--dry-run', ...args], { cwd });
    requireSuccess(result, 'CLI dry-run');
    assert.match(result.stdout, /"status": "complete"/);
    assert.match(result.stdout, /"simulated": true/);
  }
  for (const [initial, args] of [[system, []], [dir, ['--project', system]]]) {
    requireSuccess(await run(process.execPath, [path.join(runtime, 'lib/npm-cli.mjs'), 'develop', '--dry-run', ...args], {
      cwd: runtime, env: { ...process.env, INIT_CWD: initial }
    }), 'npm invocation context');
  }
  await access(path.join(system, '.harness-artifacts/checkpoints'));
  await assert.rejects(access(path.join(runtime, '.harness-artifacts')));
  for (const args of [['setup-runtime', '--players=2', '--players=3'], ['validate', '--build', '--build']]) {
    const invalid = await run(process.execPath, [path.join(runtime, 'cli.mjs'), ...args], { cwd: system });
    assert.equal(invalid.code, 2, 'existing duplicate-option rejection is preserved');
  }
  const script = `import { staticValidation } from ${JSON.stringify(pathToFileURL(path.join(runtime, 'lib/validate.mjs')).href)}; import { run } from ${JSON.stringify(pathToFileURL(path.join(runtime, 'lib/process.mjs')).href)}; console.log(JSON.stringify(await staticValidation(process.cwd(), run)));`;
  await writeFile(path.join(system, 'config.json'), '{}');
  const check = requireSuccess(await run(process.execPath, ['--input-type=module', '-e', script], { cwd: system }), 'separated static check');
  assert.equal(JSON.parse(check.stdout).ok, true);
  // The runtime template or source cannot satisfy a missing project spec.
  await rm(path.join(system, 'spec/PROJECT.md'));
  const absent = requireSuccess(await run(process.execPath, ['--input-type=module', '-e', script], { cwd: system }), 'missing project check');
  assert.equal(JSON.parse(absent.stdout).ok, false);
});

test('Gradle task contract reports exact missing tasks and never launches them', async t => {
  const dir = await temporary(t);
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { ok: true, stdout: requiredTasks.filter(task => task !== 'runData').map(task => task + ' - description').join('\n'), stderr: '' };
  };
  const result = await gradleContract(dir, runner);
  assert.equal(result.ok, false); assert.deepEqual(result.missing, ['runData']);
  assert.deepEqual(calls[0].args.slice(0, 2), ['tasks', '--all']);
  assert.equal(calls[0].options.cwd, dir);
  await gradleContract(dir, runner, { agentFast: true });
  assert.ok(calls[1].args.includes('--no-daemon'));
});

test('existing projects need no template gitignore for runtime evidence integrity', async t => {
  const dir = await temporary(t); await projectFixture(dir);
  await rm(path.join(dir, '.gitignore'));
  const initial = await snapshot(dir, run);
  await mkdir(path.join(dir, '.harness-artifacts/validate'), { recursive: true });
  await writeFile(path.join(dir, '.harness-artifacts/validate/output.json'), 'generated evidence');
  await assertHarnessUnchanged(dir, run, initial);
  assert.equal((await staticValidation(dir, run)).ok, true);
});

test('validate runs harness self-tests in harness root and Gradle in project root', async t => {
  const dir = await temporary(t); await projectFixture(dir);
  const runner = async (command, args, options) => {
    if (command === 'git') return run(command, args, options);
    if (command === process.execPath) {
      assert.equal(options.cwd, harnessRoot);
      assert.ok(args.slice(1).every(file => file.startsWith(path.join(harnessRoot, 'test'))));
      assert.ok(!args.some(file => file.includes('bootstrap.test')));
    } else {
      assert.equal(options.cwd, dir);
      if (args.includes('tasks')) return { ok: true, stdout: requiredTasks.join('\n'), stderr: '' };
      assert.ok(args.includes('build'));
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  assert.equal((await validate(dir, runner, path.join(dir, '.harness-artifacts/check'), { stage: 'build' })).ok, true);
});

test('doctor reads project contract while runtime resources and MC Pilot stay in harness', async t => {
  const dir = await temporary(t); await projectFixture(dir);
  const runner = async (command, args, options) => {
    assert.equal(options.cwd, dir);
    if (command === 'git') return run(command, args, options);
    if (command === process.execPath) {
      assert.equal(args[0], path.join(harnessRoot, 'node_modules/@kzheart_/mc-pilot/bin/mct'));
      return { ok: true, stdout: JSON.stringify({ success: true, data: {} }), stderr: '' };
    }
    if (args.includes('tasks')) return { ok: true, stdout: requiredTasks.join('\n'), stderr: '' };
    return { ok: false, stdout: '', stderr: 'Synthetic unavailable tool' };
  };
  const checks = (await doctor(dir, runner)).checks;
  assert.equal(checks.find(check => check.name === 'Required repository files').ok, true);
  assert.equal(checks.find(check => check.name === 'Gradle task contract').ok, true);
  assert.ok(!checks.some(check => /CLAUDE|spec\/README|package.json/.test(check.name)));
  await mct(dir, runner, ['schema']);
});

test('code review loads common docs, schema and prompts from harness, source from project', async t => {
  const dir = await temporary(t); await projectFixture(dir);
  await mkdir(path.join(dir, 'src')); await writeFile(path.join(dir, 'src/Project.java'), 'project source');
  requireSuccess(await run('git', ['add', '.'], { cwd: dir }), 'stage fixture');
  requireSuccess(await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: dir }), 'commit fixture');
  const runner = async (command, args, options) => {
    if (command === 'git') return run(command, args, options);
    if (args[0] === 'auth') return { ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) };
    if (args[0] === '--help') return { ok: true, stdout: '--permission-prompts --json-schema --safe-mode --restricted --tools --strict-mcp-config --no-session-persistence' };
    assert.equal(await readFile(path.join(options.cwd, 'src/Project.java'), 'utf8'), 'project source');
    assert.equal(await readFile(path.join(options.cwd, 'docs/ai/CODE_QUALITY.md'), 'utf8'), await readFile(path.join(harnessRoot, 'docs/ai/CODE_QUALITY.md'), 'utf8'));
    assert.match(options.input, /observable acceptance criteria/);
    return { ok: true, stdout: JSON.stringify({ subtype: 'success', structured_output: { verdict: 'pass', findings: [], summary: 'Synthetic review result' } }) };
  };
  assert.equal((await review(dir, runner, await loadConfig({}), path.join(dir, '.harness-artifacts/review'), 'code')).verdict, 'pass');
});

test('common documentation links resolve without a project or template', async () => {
  for (const file of ['README.md', 'AGENTS.md', 'CLAUDE.md', ...(await walk(path.join(harnessRoot, 'docs'))).map(file => 'docs/' + file)].filter(file => file.endsWith('.md'))) {
    const text = await readFile(path.join(harnessRoot, file), 'utf8');
    for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      if (/^[a-z]+:|^#|^</i.test(target)) continue;
      const destination = path.resolve(harnessRoot, path.dirname(file), target.split('#')[0]);
      assert.ok(!destination.startsWith(path.join(harnessRoot, 'template')), file);
      await access(destination);
    }
  }
});
