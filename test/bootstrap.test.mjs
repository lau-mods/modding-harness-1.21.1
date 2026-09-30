import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { harnessRoot } from '../lib/paths.mjs';
import { run, requireSuccess } from '../lib/process.mjs';
import { staticValidation } from '../lib/validate.mjs';
import { snapshot, assertHarnessUnchanged } from '../lib/repository.mjs';

async function git(cwd, ...args) {
  return requireSuccess(await run('git', ['-c', 'user.name=Harness Test', '-c', 'user.email=harness-test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(cwd, '.disabled-test-hooks')}`, ...args], { cwd }), `fixture git ${args[0]}`).stdout.trim();
}
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'harness-bootstrap-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'harness-source'); await mkdir(source);
  for (const file of ['cli.mjs', 'lib', 'test', 'template', 'docs', 'prompts', 'schemas', 'README.md', 'AGENTS.md', 'CLAUDE.md',
    'package.json', 'package-lock.json', 'config.json', 'log-allowlist.json', '.gitignore']) {
    await cp(path.join(harnessRoot, file), path.join(source, file), { recursive: true,
      filter: input => !/(?:^|[/\\])(?:node_modules|build|\.gradle|\.harness-artifacts)(?:[/\\]|$)/.test(path.relative(harnessRoot, input)) });
  }
  await writeFile(path.join(source, 'template/initial-revision.txt'), 'release A\n');
  await git(source, 'init'); await git(source, 'add', '.'); await git(source, 'commit', '-m', 'fixture A');
  await git(source, 'tag', '-a', 'v1.2.3', '-m', 'fixture release');
  await git(source, 'remote', 'add', 'origin', source);
  return { dir, source, sha: await git(source, 'rev-parse', 'HEAD'),
    create: (target, flags = []) => run(process.execPath, [path.join(source, 'cli.mjs'), 'create', target, ...flags], { cwd: dir }) };
}

test('new and retrofitted systems share a pinned Git submodule and the same runtime contract', async t => {
  const f = await fixture(t), generated = path.join(f.dir, 'new system'), existing = path.join(f.dir, 'existing');
  const created = requireSuccess(await f.create(generated), 'create');
  assert.match(created.stdout, /"ref": "v1.2.3"/);
  assert.equal(path.resolve(await git(generated, 'rev-parse', '--show-toplevel')), generated);
  assert.equal(await git(path.join(generated, '.harness'), 'rev-parse', 'HEAD'), f.sha);
  assert.match(await git(generated, 'ls-files', '--stage', '.harness'), new RegExp(`^160000 ${f.sha}`));
  assert.equal(await git(generated, 'config', '-f', '.gitmodules', '--get', 'submodule..harness.url'), f.source);
  assert.match(await readFile(path.join(generated, '.harness/.git'), 'utf8'), /^gitdir: /);
  assert.equal((await run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: path.join(generated, '.harness') })).ok, false);
  assert.equal((await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: generated })).ok, false, 'generator does not auto-commit');
  const files = await readdir(generated);
  for (const forbidden of ['lib', 'cli.mjs', 'package.json', 'config.json', 'harness']) assert.ok(!files.includes(forbidden));
  for (const expected of ['.harness', 'src', 'spec', 'build.gradle', 'AGENTS.md', 'gradlew']) assert.ok(files.includes(expected));
  assert.match(await readFile(path.join(generated, 'settings.gradle'), 'utf8'), /rootProject.name = 'new-system'/);
  await git(generated, 'add', '.'); await git(generated, 'commit', '-m', 'fixture generated system');

  await cp(path.join(f.source, 'template'), existing, { recursive: true });
  await writeFile(path.join(existing, 'AGENTS.md'), 'Existing project instructions\n');
  await git(existing, 'init'); await git(existing, 'add', '.'); await git(existing, 'commit', '-m', 'existing history');
  await git(existing, 'tag', 'old-release');
  const history = await git(existing, 'rev-parse', 'HEAD');
  const original = await readFile(path.join(existing, 'build.gradle'), 'utf8');
  await git(existing, '-c', 'protocol.file.allow=always', 'submodule', 'add', f.source, '.harness');
  await git(path.join(existing, '.harness'), 'checkout', '--detach', f.sha);
  assert.equal(await git(existing, 'rev-parse', 'HEAD'), history);
  assert.equal(await git(existing, 'rev-parse', 'old-release'), history);
  assert.equal(await readFile(path.join(existing, 'build.gradle'), 'utf8'), original);
  assert.equal(await readFile(path.join(existing, 'AGENTS.md'), 'utf8'), 'Existing project instructions\n');
  const a = await staticValidation(existing, run), b = await staticValidation(generated, run);
  assert.equal(a.ok, true, JSON.stringify(a.errors)); assert.equal(b.ok, true, JSON.stringify(b.errors));
  assert.equal(a.specification, b.specification);
  for (const system of [existing, generated]) {
    const result = await run(process.execPath, [path.join(system, '.harness/cli.mjs'), 'validate', '--static'], { cwd: system, timeoutMs: 120_000 });
    requireSuccess(result, 'submodule validation');
  }
  const initial = await snapshot(generated, run);
  await writeFile(path.join(generated, '.harness/config.json'), '{}');
  await assert.rejects(assertHarnessUnchanged(generated, run, initial), /\.harness\/config.json/);
  await writeFile(path.join(generated, '.harness/config.json'), await readFile(path.join(f.source, 'config.json')));
  await assertHarnessUnchanged(generated, run, initial);
  // Normal execution still passes without the bootstrap template.
  await rm(path.join(generated, '.harness/template'), { recursive: true });
  requireSuccess(await run(process.execPath, [path.join(generated, '.harness/cli.mjs'), 'validate', '--static'], { cwd: generated }), 'template-independent runtime');
});

test('explicit older release uses matching template; untagged checkout pins SHA; pointers are guarded', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'template/initial-revision.txt'), 'commit B\n');
  await git(f.source, 'add', '.'); await git(f.source, 'commit', '-m', 'fixture B');
  const shaB = await git(f.source, 'rev-parse', 'HEAD');
  const old = path.join(f.dir, 'old'), current = path.join(f.dir, 'current');
  requireSuccess(await f.create(old, ['--harness-ref', 'v1.2.3']), 'old release');
  assert.equal(await readFile(path.join(old, 'initial-revision.txt'), 'utf8'), 'release A\n');
  assert.equal(await git(path.join(old, '.harness'), 'rev-parse', 'HEAD'), f.sha);
  const result = requireSuccess(await f.create(current), 'SHA default');
  assert.match(result.stdout, new RegExp(`"ref": "${shaB}"`));
  assert.equal(await readFile(path.join(current, 'initial-revision.txt'), 'utf8'), 'commit B\n');
  await git(current, 'add', '.'); await git(current, 'commit', '-m', 'fixture project');
  const initial = await snapshot(current, run);
  await git(path.join(current, '.harness'), 'checkout', '--detach', f.sha);
  assert.equal(await readFile(path.join(current, 'initial-revision.txt'), 'utf8'), 'commit B\n', 'submodule updates never synchronize project files');
  await assert.rejects(assertHarnessUnchanged(current, run, initial), /\.harness\/@HEAD/);
  await git(path.join(current, '.harness'), 'checkout', '--detach', shaB);
  await git(current, 'update-index', '--cacheinfo', `160000,${f.sha},.harness`);
  await assert.rejects(assertHarnessUnchanged(current, run, initial), /\.harness\/@index/);
});

test('empty Git repository is preserved, unsafe/nonempty targets and moving branches are rejected', async t => {
  const f = await fixture(t), empty = path.join(f.dir, 'empty');
  await mkdir(empty); await git(empty, 'init'); await git(empty, 'commit', '--allow-empty', '-m', 'existing empty history');
  const head = await git(empty, 'rev-parse', 'HEAD');
  requireSuccess(await f.create(empty), 'existing empty repo');
  assert.equal(await git(empty, 'rev-parse', 'HEAD'), head);
  const before = await readFile(path.join(empty, 'AGENTS.md'), 'utf8');
  assert.match((await f.create(empty)).stderr, /empty target/);
  assert.equal(await readFile(path.join(empty, 'AGENTS.md'), 'utf8'), before);
  const rejected = path.join(f.dir, 'rejected');
  await git(f.source, 'branch', 'moving');
  assert.equal((await f.create(rejected, ['--harness-ref', 'moving'])).ok, false);
  assert.equal((await f.create(rejected, ['--harness-ref', '--help'])).ok, false);
  assert.match((await f.create(rejected, ['--harness-url', 'https://synthetic@example.invalid/repo', '--harness-ref', f.sha])).stderr, /credential-free/);
  await assert.rejects(readdir(rejected), { code: 'ENOENT' });
  await writeFile(path.join(f.source, 'config.json'), '{}');
  assert.match((await f.create(rejected)).stderr, /uncommitted changes/);
  // An explicit committed ref deliberately ignores the dirty generator's files.
  requireSuccess(await f.create(rejected, ['--harness-ref', f.sha, '--harness-url', f.source]), 'explicit pin');
  assert.equal(await readFile(path.join(rejected, 'initial-revision.txt'), 'utf8'), 'release A\n');
});

test('template preserves MDK versions and run configurations', async () => {
  const props = await readFile(path.join(harnessRoot, 'template/gradle.properties'), 'utf8');
  assert.match(props, /^minecraft_version=1\.21\.1$/m); assert.match(props, /^neo_version=21\.1\.252$/m);
  const gradle = await readFile(path.join(harnessRoot, 'template/build.gradle'), 'utf8');
  assert.match(gradle, /JavaLanguageVersion.of\(21\)/); assert.match(gradle, /version '2\.0\.148'/);
  for (const name of ['client', 'server', 'gameTestServer', 'data']) assert.match(gradle, new RegExp(`\\b${name} \\{`));
});
