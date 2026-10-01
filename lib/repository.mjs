import { harnessRoot } from './paths.mjs';
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { requireSuccess, redact } from './process.mjs';

// Mod implementation inputs; everything else in the repository is read-only.
export const modPaths = ['src', 'tests/e2e/scenarios', 'build.gradle', 'settings.gradle', 'gradle.properties'];
export const isModPath = file => modPaths.some(allowed => file === allowed || file.startsWith(allowed + '/'));

export async function assertHarnessUnchanged(root, runner, initial) {
  const current = await snapshot(root, runner);
  const changed = changedSince(initial, current).filter(file => !isModPath(file));
  if (changed.length) throw Object.assign(new Error(`Mod development changed protected files: ${changed.join(', ')}`), { code: 'HARNESS_CHANGED' });
  return current;
}

export async function walk(root, relative = '') {
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not a review/validation input: ${relative}/${entry.name}`);
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, name));
    else files.push(name);
  }
  return files;
}

export async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'));
}

export async function gitFiles(root, runner) {
  const result = requireSuccess(await runner('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }), 'git ls-files');
  // Existing projects may not yet ignore generated evidence; it is never source input.
  return [...new Set(result.stdout.split('\0').filter(file => file && !file.startsWith('.harness-artifacts/')))].sort();
}

export async function snapshot(root, runner) {
  const files = await gitFiles(root, runner);
  const hashes = {};
  for (const file of files) {
    try {
      const info = await lstat(path.join(root, file));
      if (info.isDirectory()) {
        // Git lists a submodule as one gitlink. Protect its pointer AND worktree.
        const entry = requireSuccess(await runner('git', ['ls-files', '--stage', '--', file], { cwd: root }), 'gitlink');
        if (!entry.stdout.startsWith('160000 ')) throw new Error(`Non-regular repository file: ${file}`);
        const childRoot = path.join(root, file);
        hashes[`${file}/@index`] = entry.stdout;
        hashes[`${file}/@HEAD`] = requireSuccess(await runner('git', ['rev-parse', 'HEAD'], { cwd: childRoot }), 'submodule HEAD').stdout.trim();
        for (const [child, hash] of Object.entries(await snapshot(childRoot, runner))) hashes[`${file}/${child}`] = hash;
        continue;
      }
      if (!info.isFile()) throw new Error(`Non-regular repository file: ${file}`);
      hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return hashes;
}

export function changedSince(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]).sort();
}

export async function workingChanges(root, runner) {
  const tracked = requireSuccess(await runner('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: root }), 'git diff');
  const untracked = requireSuccess(await runner('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root }), 'git untracked');
  return [...new Set((tracked.stdout + untracked.stdout).split('\0').filter(file => file && !file.startsWith('.harness-artifacts/')))].sort();
}

const rules = [
  [/^(docs|spec)\/|\.md$|^TEMPLATE_LICENSE/, 'documentation', {}],
  [/^tests\/e2e\//, 'e2e-scenario', { e2e: true }],
  [/^\.harness(?:\/|$)|^tests\/qualification\/|^package(?:-lock)?\.json$|^\.github\//, 'harness', {}],
  [/(?:registry|network|packet).*\.java$|^(?:gradle\/|libs\/)|\.gradle(?:\.kts)?$|^gradle\.properties$|\.toml$|mixins.*\.json$/i, 'registry-network-metadata', { gameTest: true, e2e: true, restart: true }],
  [/\/(?:client|screen|renderer)\/|(?:Client|Screen|Renderer)\w*\.java$/, 'client-java', { e2e: true, restart: true, visual: true }],
  [/\/assets\/[^/]+\/(?:textures|models|blockstates|lang)\//, 'visual-resource', { e2e: true, visual: true, reload: 'resources' }],
  [/\/data\/[^/]+\/(?:recipe|loot_table|tags|advancement)\/.*\.json$/, 'data', { gameTest: true, e2e: true, reload: 'data' }],
  [/\/data\//, 'worldgen-or-other-data', { gameTest: true, e2e: true, restart: true }],
  [/^src\/test\//, 'unit-tests', {}],
  [/\/logic\/.*\.java$/, 'pure-java', { restart: true }],
  [/\.java$/, 'server-world-java', { gameTest: true, e2e: true, restart: true }],
  [/^src\//, 'unknown-runtime', { gameTest: true, e2e: true, restart: true, visual: true }],
  [/.*/, 'build-or-other', {}]
];

export function classify(files) {
  const result = { categories: [], gameTest: false, e2e: false, visual: false, restart: false, reload: [] };
  for (const file of files) {
    const [, category, flags] = rules.find(([pattern]) => pattern.test(file.replaceAll('\\', '/')));
    if (!result.categories.includes(category)) result.categories.push(category);
    for (const key of ['gameTest', 'e2e', 'visual', 'restart']) result[key] ||= !!flags[key];
    if (flags.reload && !result.reload.includes(flags.reload)) result.reload.push(flags.reload);
  }
  return result;
}

export async function loadConfig(env = process.env) {
  const config = JSON.parse(await readFile(path.join(harnessRoot, 'config.json'), 'utf8'));
  config.models.implementer = env.HARNESS_CODEX_MODEL || config.models.implementer;
  config.models.reviewer = env.HARNESS_CLAUDE_MODEL || config.models.reviewer;
  if (!/opus/i.test(config.models.reviewer)) throw new Error('Reviewer model must be Opus');
  config.gameTest = env.HARNESS_GAME_TEST || config.gameTest;
  for (const name of ['codeReviews', 'gameBoots', 'visualReviews']) {
    const key = 'HARNESS_' + name.replace(/[A-Z]/g, letter => '_' + letter).toUpperCase();
    if (env[key]) config.budgets[name] = Number(env[key]);
    if (!Number.isInteger(config.budgets[name]) || config.budgets[name] < 1 || config.budgets[name] > 10) throw new Error(`Invalid budget: ${name} (1..10)`);
  }
  if (!['auto', 'required'].includes(config.gameTest)) throw new Error('gameTest must be auto or required');
  return config;
}
