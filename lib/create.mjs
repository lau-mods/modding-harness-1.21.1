import { cp, mkdir, mkdtemp, readdir, readFile, writeFile, lstat, rm, rename, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { harnessRoot } from './paths.mjs';
import { run, requireSuccess } from './process.mjs';
import { walk } from './repository.mjs';

export async function createProject(target, { harnessUrl, harnessRef } = {}, runner = run) {
  target = path.resolve(target);
  const git = async (cwd, args) => requireSuccess(await runner('git', args, { cwd }), `git ${args[0]}`).stdout.trim();
  // Reject a nonempty destination before cloning or touching existing project files.
  let entries = [];
  try {
    if (!(await lstat(target)).isDirectory()) throw new Error('Target must be a directory');
    entries = await readdir(target);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (entries.some(name => name !== '.git')) throw new Error('create requires an empty target (an existing .git is allowed); use submodule add for existing projects');
  if (entries.includes('.git')) {
    const top = await git(target, ['rev-parse', '--show-toplevel']);
    if (await realpath(top) !== await realpath(target) || (await git(target, ['ls-files', '-z']))) throw new Error('Target Git repository must have an empty index');
  }
  const url = harnessUrl || await git(harnessRoot, ['remote', 'get-url', 'origin']);
  if (!url || url.startsWith('-')) throw new Error('A harness origin URL or --harness-url is required');
  if (/^https?:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error('Use a credential-free harness URL; HTTP credentials must not be stored in .gitmodules');
  }
  // Local paths must remain valid after installing into a different directory.
  const local = path.isAbsolute(url) || url.startsWith('.') || !/^[^/\\]+:/.test(url);
  const remote = local ? path.resolve(harnessUrl ? process.cwd() : harnessRoot, url) : url;
  let ref = harnessRef, expected;
  if (!ref) {
    if (await git(harnessRoot, ['status', '--porcelain', '--untracked-files=normal'])) {
      throw new Error('Harness checkout has uncommitted changes; commit/release first or select a committed --harness-ref');
    }
    expected = await git(harnessRoot, ['rev-parse', 'HEAD']);
    const tags = (await git(harnessRoot, ['tag', '--points-at', 'HEAD', '--sort=-version:refname'])).split('\n');
    ref = tags.find(tag => /^v?\d+\.\d+\.\d+$/.test(tag)) || expected;
  }
  if (!ref || ref.startsWith('-') || /[\s~^:?*\[\\]/.test(ref) || ref.includes('..')) throw new Error('Use an exact tag or full commit SHA for --harness-ref');
  const staging = await mkdtemp(path.join(os.tmpdir(), 'modding-harness-create-'));
  try {
    const checkout = path.join(staging, 'checkout');
    await git(staging, ['clone', '--no-checkout', '--', remote, checkout]);
    // Branch names never become the pin. An override accepts only a tag or full SHA.
    const selector = /^[a-f0-9]{40}$/i.test(ref) ? ref : `refs/tags/${ref}`;
    const revision = await git(checkout, ['rev-parse', '--verify', `${selector}^{commit}`]);
    if (expected && revision !== expected) throw new Error('Remote release tag differs from the current harness commit');
    await git(checkout, ['checkout', '--detach', revision]);
    const template = path.join(checkout, 'template');
    const files = await walk(template);
    if (!files.includes('build.gradle') || !files.includes('AGENTS.md') || !files.includes('settings.gradle')) throw new Error('Selected harness revision has no supported template');
    if (files.some(file => /^(?:\.git|\.harness)(?:\/|$)/.test(file))) throw new Error('Template must contain project files only');
    // Materialize only the template at the SAME revision that will be pinned.
    await mkdir(target, { recursive: true });
    for (const name of await readdir(template)) await cp(path.join(template, name), path.join(target, name), { recursive: true, force: false, errorOnExist: true });
    const name = path.basename(target).replace(/[^a-zA-Z0-9_.-]/g, '-');
    const settings = path.join(target, 'settings.gradle');
    await writeFile(settings, (await readFile(settings, 'utf8')) + `\nrootProject.name = '${name}'\n`);
    if (!entries.includes('.git')) await git(target, ['init']);
    try { await rename(checkout, path.join(target, '.harness')); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await cp(checkout, path.join(target, '.harness'), { recursive: true, force: false, errorOnExist: true });
    }
    // Git reuses the existing pinned checkout, avoiding a second network clone.
    await git(target, ['submodule', 'add', '--', remote, '.harness']);
    await git(target, ['submodule', 'absorbgitdirs', '--', '.harness']);
    return { target, remote, ref, revision };
  } catch (error) {
    throw new Error(`Creation failed: ${error.message}\nAny files already materialized in ${target} are preserved; inspect them before retrying.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
