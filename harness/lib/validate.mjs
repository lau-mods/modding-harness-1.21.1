import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { walk, gitFiles, save } from './repository.mjs';
import { gradleCommand, requireSuccess } from './process.mjs';

export const requiredFiles = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'spec/README.md', 'spec/PROJECT.md',
  'spec/PROJECT.template.md', 'harness/config.json', 'harness/schemas/review.schema.json',
  'docs/ai/HARNESS_ARCHITECTURE.md', 'docs/ai/DEVELOPMENT_WORKFLOW.md', 'docs/ai/CODE_QUALITY.md',
  'docs/ai/REVIEW_POLICY.md', 'docs/ai/TESTING_POLICY.md', 'docs/ai/VISUAL_TESTING.md',
  'docs/ai/SPEC_WRITING.md', 'docs/ai/upstream-baseline.json', 'tests/e2e/README.md',
  'build.gradle', 'settings.gradle', 'gradle.properties', 'package.json', 'package-lock.json',
  'harness/prompts/harness-review.txt', 'harness/prompts/code-review.txt', 'harness/prompts/visual-review.txt',
  'gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar'];

export function parseSpec(text, { allowDraft = false } = {}) {
  const ready = /^Status:\s*ready\s*$/mi.test(text);
  if (!ready) {
    if (allowDraft && /^Status:\s*draft\s*$/mi.test(text)) return { ready: false, criteria: [] };
    throw new Error('spec/PROJECT.md is not ready. Replace the placeholder and set Status: ready; see spec/README.md');
  }
  if (/TEMPLATE_NOT_CONFIGURED|\bTODO\b|\bTBD\b|<FILL[^>]*>/i.test(text)) throw new Error('Specification contains unresolved placeholders');
  const headings = ['Identity', 'Purpose', 'Functional requirements', 'Acceptance criteria', 'Visual requirements',
    'Persistence', 'Multiplayer', 'Compatibility', 'Non-goals', 'Reference assets', 'Unresolved questions'];
  for (const heading of headings) {
    const match = text.match(new RegExp(`^## ${heading}\\s*\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'mi'));
    if (!match?.[1].trim()) throw new Error(`Specification section missing or empty: ${heading}`);
  }
  const modId = text.match(/^Mod ID:\s*([a-z][a-z0-9_]{1,63})\s*$/m)?.[1];
  const criteria = [...text.matchAll(/^- (AC-[A-Za-z0-9-]+):\s*\S.+$/gm)].map(match => match[1]);
  if (!modId || !criteria.length || new Set(criteria).size !== criteria.length) throw new Error('Specification needs a valid Mod ID and unique AC-* acceptance criteria');
  return { ready, modId, criteria };
}

export async function hasGameTests(root) {
  for (const file of await walk(path.join(root, 'src/main/java'))) {
    if (!file.endsWith('.java')) continue;
    const source = (await readFile(path.join(root, 'src/main/java', file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    if (/@(?:[\w.]+\.)?GameTest(?:Generator)?\b/.test(source)) return true;
  }
  return false;
}

// Deliberately check only unambiguous file references, not registry IDs or foreign namespaces.
export function resourceReferences(file, json) {
  const refs = [];
  if (/\/models\//.test(file)) {
    if (typeof json.parent === 'string') refs.push(['models', json.parent, '.json']);
    for (const value of Object.values(json.textures ?? {})) if (typeof value === 'string' && !value.startsWith('#')) refs.push(['textures', value, '.png']);
  }
  if (/\/blockstates\//.test(file)) {
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.model === 'string') refs.push(['models', value.model, '.json']);
      for (const child of Object.values(value)) visit(child);
    };
    visit(json);
  }
  return refs;
}

export async function staticValidation(root, runner, { requireReady = false } = {}) {
  const errors = [];
  for (const file of requiredFiles) try { await access(path.join(root, file)); } catch { errors.push(`Missing required file: ${file}`); }
  const files = await gitFiles(root, runner);
  // Generated resources may be gitignored by a downstream project but are build inputs.
  const generated = (await walk(path.join(root, 'src/generated/resources'))).map(file => `src/generated/resources/${file}`);
  const all = [...new Set([...files, ...generated])];
  const resources = new Set();
  const namespaces = new Set();
  for (const file of all) {
    const resource = file.match(/^src\/(?:main|generated)\/resources\/assets\/(.+)$/);
    if (resource) {
      try { await access(path.join(root, file)); resources.add(resource[1]); namespaces.add(resource[1].split('/')[0]); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const props = await readFile(path.join(root, 'gradle.properties'), 'utf8');
  const modId = props.match(/^mod_id=(.+)$/m)?.[1].trim();
  if (modId) namespaces.add(modId);
  let spec;
  try {
    spec = parseSpec(await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8'), { allowDraft: !requireReady });
    if (spec.ready) {
      if (!new RegExp(`^mod_id=${spec.modId}\\s*$`, 'm').test(props)) errors.push('Spec Mod ID and gradle.properties mod_id differ');
    }
  } catch (error) { errors.push(error.message); }
  for (const file of all) {
    if (/^(?:\.harness-artifacts|node_modules|build|run)\//.test(file)) continue;
    if (/\.json(?:\.mcmeta)?$|\.mcmeta$/.test(file)) {
      try {
        const json = JSON.parse(await readFile(path.join(root, file), 'utf8'));
        for (const [kind, ref, ext] of resourceReferences(file, json)) {
          const [namespace, name] = ref.includes(':') ? ref.split(':') : ['minecraft', ref];
          if (namespace === 'minecraft' || !namespaces.has(namespace)) continue;
          if (!resources.has(`${namespace}/${kind}/${name}${ext}`)) errors.push(`${file}: missing local ${kind} reference ${ref}`);
        }
      } catch (error) { if (error.code !== 'ENOENT') errors.push(`${file}: ${error.message}`); }
    }
    if (file.endsWith('.md')) {
      let text;
      try { text = await readFile(path.join(root, file), 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        if (/^[a-z]+:|^#|^</i.test(target)) continue;
        try { await access(path.resolve(root, path.dirname(file), target.split('#')[0])); }
        catch { errors.push(`${file}: broken documentation link ${target}`); }
      }
    }
  }
  return { ok: errors.length === 0, errors, specification: spec?.ready ? 'ready' : 'draft', filesChecked: all.length };
}

export async function validate(root, runner, artifactDir, { stage = 'compile', requireReady = false } = {}) {
  const result = { static: await staticValidation(root, runner, { requireReady }) };
  await save(path.join(artifactDir, 'validation.json'), result);
  if (!result.static.ok) throw new Error(result.static.errors.join('\n'));
  const tests = (await walk(path.join(root, 'harness/test'))).filter(file => file.endsWith('.test.mjs'));
  result.harness = await runner(process.execPath, ['--test', ...tests.map(file => path.join(root, 'harness/test', file))], { cwd: root });
  await save(path.join(artifactDir, 'harness-tests.log'), result.harness.stdout + result.harness.stderr);
  requireSuccess(result.harness, 'Harness tests');
  if (stage !== 'static') {
    const command = gradleCommand(root, stage === 'build' ? ['build'] : ['classes', 'test']);
    result.gradle = await runner(command.command, command.args, { cwd: root, timeoutMs: 900_000 });
    await save(path.join(artifactDir, 'gradle.log'), result.gradle.stdout + result.gradle.stderr);
    requireSuccess(result.gradle, 'Gradle validation');
  }
  const summary = { ok: true, static: result.static, harness: { ok: true }, gradle: result.gradle ? { ok: true, stage } : { status: 'not-run' } };
  await save(path.join(artifactDir, 'validation.json'), summary);
  return summary;
}

export async function gameTest(root, runner, dir, mode = 'auto') {
  if (mode === 'auto' && !await hasGameTests(root)) {
    const result = { status: 'not-applicable', reason: 'No @GameTest or @GameTestGenerator in src/main/java' };
    await save(path.join(dir, 'gametest.json'), result);
    return result;
  }
  const cmd = gradleCommand(root, ['runGameTestServer']);
  const result = await runner(cmd.command, cmd.args, { cwd: root, timeoutMs: 900_000 });
  await save(path.join(dir, 'gametest.log'), result.stdout + result.stderr);
  requireSuccess(result, 'NeoForge GameTest');
  const summary = { status: 'pass' };
  await save(path.join(dir, 'gametest.json'), summary);
  return summary;
}
