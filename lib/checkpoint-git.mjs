import path from 'node:path';
import { readFile, lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { devNull } from 'node:os';
import { requireSuccess } from './process.mjs';
import { snapshot, workingChanges, isModPath, walk, gitFiles } from './repository.mjs';
import { hash } from './work-plan.mjs';

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, file);
}

export async function head(root, runner) {
  return requireSuccess(await runner('git', ['rev-parse', 'HEAD'], { cwd: root }), 'Git HEAD').stdout.trim();
}
export async function assertHead(root, runner, expected) {
  if (await head(root, runner) !== expected) throw Object.assign(new Error('Agent/stage changed Git HEAD; history integrity violated'), { code: 'HARNESS_CHANGED' });
}

export async function candidateFingerprint(root, runner, { requireJar = false } = {}) {
  const files = await snapshot(root, runner), modes = {};
  const index = requireSuccess(await runner('git', ['ls-files', '--stage', '-z'], { cwd: root }), 'Git index').stdout;
  const indexModes = new Map(index.split('\0').filter(Boolean).map(entry => { const [metadata, file] = entry.split('\t'); return [file, metadata.split(' ')[0]]; }));
  const fileMode = await runner('git', ['config', '--bool', 'core.fileMode'], { cwd: root });
  if (!fileMode.ok && fileMode.code !== 1) requireSuccess(fileMode, 'Git core.fileMode');
  const diskModes = process.platform !== 'win32' && fileMode.stdout.trim() !== 'false';
  for (const file of Object.keys(files)) {
    if (/\/@(?:index|HEAD)$/.test(file)) continue;
    modes[file] = diskModes ? ((await lstat(path.join(root, file))).mode & 0o111) : indexModes.get(file) === '100755' ? 0o111 : 0;
  }
  // Ignored source is neither reviewable nor committable. Reject it instead of
  // silently compiling an input absent from the verified Git tree.
  for (const area of ['src', 'tests/e2e/scenarios']) {
    for (const file of await walk(path.join(root, area))) {
      const name = `${area}/${file}`;
      if (['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(path.basename(file))) continue;
      if (/^src\/generated\/.*\/\.cache\//.test(name)) continue;
      if (!Object.hasOwn(files, name)) throw new Error(`Build/test input is ignored by Git: ${name}`);
    }
  }
  let jar = null;
  try {
    const props = await readFile(path.join(root, 'gradle.properties'), 'utf8');
    const modId = props.match(/^mod_id=([\w.-]+)\s*$/m)?.[1];
    const version = props.match(/^mod_version=([\w.+-]+)\s*$/m)?.[1];
    if (!modId || !version) throw new Error('Invalid Mod JAR metadata');
    const file = `build/libs/${modId}-${version}.jar`;
    jar = { file, sha256: hash(await readFile(path.join(root, file))) };
  } catch (error) { if (requireJar || error.code !== 'ENOENT') throw error; }
  // Canonical Git blobs account for attributes/EOL/filters. Raw hashes above
  // also bind the exact working files that produced the tested JAR.
  const paths = (await gitFiles(root, runner)).filter(file => Object.hasOwn(files, file));
  const blobs = {};
  if (paths.length) {
    const result = requireSuccess(await runner('git', ['hash-object', '--stdin-paths'], {
      cwd: root, input: paths.map(file => JSON.stringify(file)).join('\n') + '\n'
    }), 'Canonical Git content');
    const hashes = result.stdout.trim().split('\n');
    if (hashes.length !== paths.length || hashes.some(value => !/^[a-f0-9]{40,64}$/.test(value))) throw new Error('Invalid canonical Git fingerprint');
    paths.forEach((file, index) => { blobs[file] = hashes[index]; });
  }
  return { head: await head(root, runner), files, modes, blobs, index, jar };
}

export function assertCandidate(expected, current, { staged = false } = {}) {
  for (const key of ['head', 'files', 'modes', 'blobs', 'jar', ...(staged ? [] : ['index'])]) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(current[key])) throw new Error(`Verified candidate fingerprint mismatch: ${key}; revalidation required`);
  }
}

// Deliberately expose only checkpoint operations. There is no arbitrary Git
// command option, remote operation, history rewrite, or publish operation.
export function checkpointGit(root, runner, dir) {
  const isCommit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  const execute = async args => requireSuccess(await runner('git', args, { cwd: root }), `Git ${args[0]}`).stdout.trim();
  return {
    head: () => head(root, runner),
    changes: () => workingChanges(root, runner),
    async clean() {
      const files = await workingChanges(root, runner);
      if (files.length) throw new Error(`Checkpoint task requires a clean committed project: ${files.join(', ')}`);
    },
    async diff(base) {
      if (base !== 'HEAD' && !isCommit(base)) throw new Error('Invalid diff base commit');
      return execute(['diff', '--no-ext-diff', '--no-textconv', base, '--']);
    },
    async stage(candidate, allowedSpecification = false) {
      assertCandidate(candidate, await candidateFingerprint(root, runner, { requireJar: true }));
      const files = await workingChanges(root, runner);
      if (!files.length) throw new Error('Milestone has no committable changes');
      if (files.some(file => !isModPath(file) && !(allowedSpecification && file === 'spec/PROJECT.md'))) throw new Error('Checkpoint contains protected paths');
      await execute(['add', '--all', '--', ...files]);
      assertCandidate(candidate, await candidateFingerprint(root, runner, { requireJar: true }), { staged: true });
      const entries = (await runner('git', ['ls-files', '--stage', '-z'], { cwd: root }));
      requireSuccess(entries, 'Read staged files');
      for (const entry of entries.stdout.split('\0').filter(Boolean)) {
        const match = entry.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/);
        if (!match || match[3] !== '0') throw new Error('Unmerged Git index');
        const [, mode, oid, , file] = match;
        if (mode === '160000') continue;
        const expected = candidate.blobs[file];
        const expectedMode = candidate.modes[file] ? '100755' : '100644';
        if (oid !== expected || mode !== expectedMode) throw new Error(`Staged content differs from verified source: ${file}`);
      }
      const tree = await execute(['write-tree']);
      return tree;
    },
    async commit(candidate, tree, message) {
      assertCandidate(candidate, await candidateFingerprint(root, runner, { requireJar: true }), { staged: true });
      if (await execute(['write-tree']) !== tree) throw new Error('Staged tree changed before commit');
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, 'commit-message.txt');
      await writeFile(file, message + '\n');
      await execute(['-c', `core.hooksPath=${devNull}`, '-c', 'commit.gpgSign=false', 'commit', '--file', file]);
      return this.confirm(candidate, tree, message);
    },
    async confirm(candidate, tree, message) {
      const commit = await head(root, runner);
      const parent = await execute(['show', '-s', '--format=%P', commit]);
      if (parent !== candidate.head || await execute(['rev-parse', `${commit}^{tree}`]) !== tree || await execute(['show', '-s', '--format=%B', commit]) !== message.trim()) throw new Error('Unexpected checkpoint commit; stop for human inspection');
      const current = await candidateFingerprint(root, runner, { requireJar: true });
      assertCandidate({ ...candidate, head: commit }, current, { staged: true });
      await this.clean();
      return commit;
    },
    async verifyChain(base, commits, expected) {
      if (![base, ...commits, expected].every(isCommit)) throw new Error('Invalid checkpoint commit identity');
      let parent = base;
      await execute(['cat-file', '-e', `${base}^{commit}`]);
      for (const commit of commits) {
        if (await execute(['show', '-s', '--format=%P', commit]) !== parent) throw new Error('Completed checkpoint chain mismatch');
        parent = commit;
      }
      if (parent !== expected) throw new Error('Expected HEAD is not the last completed checkpoint');
    }
  };
}
