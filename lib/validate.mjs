import { harnessRoot } from './paths.mjs';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { walk, gitFiles, save, snapshot } from './repository.mjs';
import { gradleCommand, requireSuccess } from './process.mjs';

// Only actual runtime inputs are required of an existing project.
export const requiredFiles = ['AGENTS.md', 'spec/PROJECT.md', 'build.gradle', 'settings.gradle',
  'gradle.properties', 'gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar',
  'gradle/wrapper/gradle-wrapper.properties'];
export const runtimeFiles = ['cli.mjs', 'config.json', 'package.json', 'package-lock.json',
  'schemas/review.schema.json', 'schemas/work-plan.schema.json', 'prompts/plan-review.txt', 'prompts/harness-review.txt', 'prompts/code-review.txt',
  'prompts/visual-review.txt', 'log-allowlist.json', 'docs/ai/AGENT_POLICY.md', 'docs/ai/CODE_QUALITY.md'];
export const requiredTasks = ['classes', 'test', 'build', 'runClient', 'runServer', 'runGameTestServer', 'runData'];

export function metadataErrors(props) {
  const errors = [];
  for (const key of ['minecraft_version', 'neo_version', 'mod_id', 'mod_version']) {
    if (!new RegExp(`^${key}=\\S.*$`, 'm').test(props)) errors.push(`gradle.properties must define ${key}`);
  }
  if (!/^minecraft_version=1\.21\.1\s*$/m.test(props)) errors.push('minecraft_version must be 1.21.1');
  return errors;
}

export async function gradleContract(root, runner, { agentFast = false } = {}) {
  // Listing tasks configures Gradle, but never executes Minecraft lifecycle tasks.
  const command = gradleCommand(root, ['tasks', '--all']);
  if (agentFast && !command.args.includes('--no-daemon')) command.args.push('--no-daemon');
  const result = await runner(command.command, command.args, { cwd: root, timeoutMs: 900_000 });
  const tasks = new Set(result.stdout.split(/\r?\n/).map(line => line.match(/^([\w:]+)(?:\s|$)/)?.[1]));
  const missing = requiredTasks.filter(task => !tasks.has(task));
  return { ok: result.ok && !missing.length, missing, detail: result.ok
    ? (missing.length ? `Missing Gradle tasks: ${missing.join(', ')}` : requiredTasks.join(', '))
    : `Cannot list Gradle tasks: ${result.failure ?? result.stderr ?? result.stdout}` };
}

export async function harnessValidation() {
  const errors = [];
  for (const file of runtimeFiles) try { await access(path.join(harnessRoot, file)); }
  catch { errors.push(`Missing harness file: ${file}`); }
  // template/ is deliberately outside normal runtime checks and self-tests.
  for (const file of ['config.json', 'package.json', 'package-lock.json', 'log-allowlist.json', 'schemas/review.schema.json', 'schemas/work-plan.schema.json']) {
    try { JSON.parse(await readFile(path.join(harnessRoot, file), 'utf8')); }
    catch (error) { errors.push(`${file}: ${error.message}`); }
  }
  return { ok: !errors.length, errors };
}

export async function harnessTests(runner, artifactDir) {
  const tests = (await walk(path.join(harnessRoot, 'test'))).filter(file => file.endsWith('.test.mjs') && file !== 'bootstrap.test.mjs');
  if (!tests.length) throw new Error('Harness self-tests are missing');
  const result = await runner(process.execPath, ['--test', ...tests.map(file => path.join(harnessRoot, 'test', file))], { cwd: harnessRoot });
  await save(path.join(artifactDir, 'harness-tests.log'), result.stdout + result.stderr);
  requireSuccess(result, 'Harness tests');
  return result;
}

export function parseSpec(text, { allowDraft = false } = {}) {
  const ready = /^Status:\s*ready\s*$/mi.test(text);
  if (!ready) {
    if (allowDraft && /^Status:\s*draft\s*$/mi.test(text)) return { ready: false, criteria: [] };
    throw new Error('spec/PROJECT.md is not ready. Replace the placeholder and set Status: ready; see .harness/docs/ai/SPEC_WRITING.md');
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
  let props = '';
  try { props = await readFile(path.join(root, 'gradle.properties'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  errors.push(...metadataErrors(props));
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
    if (/^(?:\.harness|\.harness-artifacts|node_modules|build|run)\//.test(file)) continue;
    if (/\.json(?:\.mcmeta)?$|\.mcmeta$/.test(file)) {
      try {
        const json = JSON.parse(await readFile(path.join(root, file), 'utf8'));
        for (const [kind, ref, ext] of /^src\/(main|generated)\/resources\//.test(file) ? resourceReferences(file, json) : []) {
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

export async function validate(root, runner, artifactDir, { stage = 'compile', requireReady = false, agentFast = false, criteria } = {}) {
  const result = { static: await staticValidation(root, runner, { requireReady }) };
  await save(path.join(artifactDir, 'validation.json'), result);
  if (!result.static.ok) throw new Error(result.static.errors.join('\n'));
  if (result.static.specification === 'ready') {
    const { acceptanceCoverage } = await import('./coverage.mjs');
    await acceptanceCoverage(root, artifactDir, { criteria, reviewed: false });
  }
  if (!agentFast) {
    const runtime = await harnessValidation();
    if (!runtime.ok) throw new Error(runtime.errors.join('\n'));
    result.harness = await harnessTests(runner, artifactDir);
  }

  if (stage !== 'static') {
    result.contract = await gradleContract(root, runner, { agentFast });
    await save(path.join(artifactDir, 'gradle-contract.json'), result.contract);
    if (!result.contract.ok) throw new Error(result.contract.detail);
    const command = gradleCommand(root, stage === 'build' ? ['build'] : ['classes', 'test']);
    // A sandboxed Codex daemon must not be shared with unsandboxed harness builds.
    if (agentFast && !command.args.includes('--no-daemon')) command.args.push('--no-daemon');
    result.gradle = await runner(command.command, command.args, { cwd: root, timeoutMs: 900_000 });
    await save(path.join(artifactDir, 'gradle.log'), result.gradle.stdout + result.gradle.stderr);
    requireSuccess(result.gradle, 'Gradle validation');
  }
  const summary = { ok: true, static: result.static, harness: agentFast ? { status: 'not-run' } : { ok: true }, gradle: result.gradle ? { ok: true, stage } : { status: 'not-run' } };
  if (agentFast) summary.validatedFiles = await snapshot(root, runner);
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
