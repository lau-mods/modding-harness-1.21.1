import { harnessRoot } from './paths.mjs';
import { readFile, writeFile, mkdir, copyFile, lstat, realpath, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { save, gitFiles, modPaths, snapshot, assertHarnessUnchanged } from './repository.mjs';
import { subscriptionEnv, requireSuccess } from './process.mjs';
import { head, assertHead } from './checkpoint-git.mjs';
import { hash } from './work-plan.mjs';
import { projectHash, validateProjectModel } from './project-model.mjs';

export function validateReview(value) {
  const keys = ['verdict', 'findings', 'summary'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error('Invalid review object');
  if (!['pass', 'changes_required'].includes(value.verdict) || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.findings)) throw new Error('Invalid review verdict/summary/findings');
  const fields = ['severity', 'category', 'file', 'location', 'problem', 'required_change', 'reason'];
  for (const finding of value.findings) {
    if (!finding || typeof finding !== 'object' || Object.keys(finding).length !== fields.length || fields.some(key => typeof finding[key] !== 'string' || !finding[key].trim())) throw new Error('Invalid review finding');
    if (!['blocker', 'major', 'minor'].includes(finding.severity)) throw new Error('Invalid finding severity');
  }
  if (value.verdict === 'pass' && value.findings.some(finding => finding.severity !== 'minor')) throw new Error('Contradictory review: pass with blocker/major');
  if (value.verdict === 'changes_required' && !value.findings.length) throw new Error('Review requires changes but supplies no findings');
  return value;
}

export function parseReview(output) {
  const envelope = JSON.parse(output);
  if (envelope.is_error || envelope.subtype !== 'success') throw new Error(`Claude review failed: ${envelope.subtype ?? 'invalid envelope'}`);
  if (!envelope.structured_output) throw new Error('Claude did not return structured_output; free text is not accepted');
  return validateReview(envelope.structured_output);
}

export function claudeArgs(model, schema) {
  return ['-p', '--model', model, '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--safe-mode', '--restricted', '--tools', 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--no-session-persistence',
    '--json-schema', JSON.stringify(schema), '--output-format', 'json'];
}

export function visualSpecification(text, ids, model) {
  if (model) {
    const requirements = model.visualRequirements.map(item => item.text).join('\n');
    const acceptanceCriteria = model.acceptanceCriteria.filter(item => ids.includes(item.id)).map(item => ({ id: item.id, requirement: item.text }));
    if (!requirements || !acceptanceCriteria.length) throw new Error('Visual review requires accepted visual requirements and AC text');
    const references = text.match(/^## (?:Reference assets|References|参考資料)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/mi)?.[1]?.trim() ?? '';
    const referenceFiles = [...(requirements + '\n' + references).matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)]
      .map(match => match[1].split('#')[0]).filter(file => !/^[a-z]+:/i.test(file))
      .map(file => path.posix.normalize(path.posix.join('spec', file)));
    if (referenceFiles.some(file => !file.startsWith('spec/references/'))) throw new Error('Visual reference links must point inside spec/references/');
    return { requirements, acceptanceCriteria, references, referenceFiles: [...new Set(referenceFiles)] };
  }
  const section = name => text.match(new RegExp(`^## ${name}\\s*\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'mi'))?.[1].trim() ?? '';
  const requirements = section('Visual requirements');
  const references = section('Reference assets');
  const relevantIds = new Set([...ids, ...requirements.matchAll(/\bAC-[A-Za-z0-9-]+\b/g)].map(value => typeof value === 'string' ? value : value[0]));
  const acceptanceCriteria = [...section('Acceptance criteria').matchAll(/^- (AC-[A-Za-z0-9-]+):([\s\S]*?)(?=^- AC-|$(?![\s\S]))/gm)]
    .filter(match => relevantIds.has(match[1])).map(match => ({ id: match[1], requirement: match[2].trim() }));
  if (!requirements || !acceptanceCriteria.length) throw new Error('Visual review requires accepted visual requirements and AC text');
  const referenceFiles = [...(requirements + '\n' + references).matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)]
    .map(match => match[1].split('#')[0]).filter(file => !/^[a-z]+:/i.test(file))
    .map(file => path.posix.normalize(path.posix.join('spec', file)));
  if (referenceFiles.some(file => !file.startsWith('spec/references/'))) throw new Error('Visual reference links must point inside spec/references/');
  return { requirements, acceptanceCriteria, references, referenceFiles: [...new Set(referenceFiles)] };
}

export async function claudeAuth(root, runner) {
  const result = await runner('claude', ['auth', 'status'], { cwd: root, env: subscriptionEnv() });
  let auth;
  try { auth = JSON.parse(result.stdout); } catch { return { ok: false, reason: 'claude auth status returned no JSON' }; }
  // Deliberately never persist the raw auth result (it may contain email and organization data).
  return { ok: result.ok && auth.loggedIn === true && auth.authMethod === 'claude.ai',
    method: auth.authMethod, subscription: auth.subscriptionType ?? null };
}

export async function review(root, runner, config, dir, kind, context = {}) {
  const beforeHead = await head(root, runner);
  const before = await snapshot(root, runner);
  try { return await reviewSnapshot(root, runner, config, dir, kind, context); }
  finally {
    await assertHead(root, runner, beforeHead);
    if (hash(before) !== hash(await snapshot(root, runner))) throw Object.assign(new Error('Project files changed during read-only review'), { code: 'HARNESS_CHANGED' });
  }
}

async function reviewSnapshot(root, runner, config, dir, kind, context) {
  await mkdir(dir, { recursive: true });
  const auth = await claudeAuth(root, runner);
  await save(path.join(dir, 'authentication.json'), auth);
  if (!auth.ok) throw new Error('Claude subscription login required: run claude auth login in your terminal');
  const help = requireSuccess(await runner('claude', ['--help'], { cwd: root }), 'Claude CLI help').stdout;
  for (const flag of ['--permission-prompts', '--json-schema', '--safe-mode', '--restricted', '--tools', '--strict-mcp-config', '--no-session-persistence']) {
    if (!help.includes(flag)) throw new Error(`Claude CLI lacks required safety flag ${flag}; update Claude Code`);
  }
  const snapshotDir = path.join(dir, 'snapshot');
  await mkdir(snapshotDir, { recursive: true });
  const files = kind === 'visual' ? [] : (await gitFiles(root, runner)).filter(file => {
    if (kind === 'harness') return /^(?:cli\.mjs$|lib\/|test\/|docs\/|template\/|prompts\/|schemas\/|config\.json$|log-allowlist\.json$|AGENTS\.md$|CLAUDE\.md$|README\.md$|package(?:-lock)?\.json$|\.github\/|\.gitignore$)/.test(file);
    if (kind === 'plan') return file.startsWith('spec/');
    return /^(src\/|spec\/|tests\/e2e\/|(?:build|settings)\.gradle$|gradle\.properties$)/.test(file);
  }).filter(file => !/\.local\.|\.png$|\.jar$|\.nbt$|\.ogg$|\.zip$/.test(file));
  let total = 0;
  const copied = [];
  for (const file of files) {
    const source = path.join(root, file);
    let stat;
    try { stat = await lstat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) throw new Error(`Review input must be a regular file: ${file}`);
    total += stat.size;
    if (total > 800_000) throw new Error('Review snapshot exceeds 800 KB; narrow the feature scope before reviewing');
    await mkdir(path.dirname(path.join(snapshotDir, file)), { recursive: true });
    await copyFile(source, path.join(snapshotDir, file));
    copied.push(file);
  }
  if (kind === 'code' || kind === 'plan') {
    const policy = 'docs/ai/CODE_QUALITY.md';
    await mkdir(path.dirname(path.join(snapshotDir, policy)), { recursive: true });
    await copyFile(path.join(harnessRoot, policy), path.join(snapshotDir, policy));
    copied.push(policy);
  }
  let acceptedVisualSpec;
  if (kind === 'visual') {
    acceptedVisualSpec = visualSpecification(await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8'),
      (context.screenshots ?? []).flatMap(shot => shot.acceptanceCriteria), context.model);
    for (const file of acceptedVisualSpec.referenceFiles) {
      if (!(await realpath(path.join(root, file))).startsWith(path.join(await realpath(root), 'spec/references') + path.sep)) throw new Error(`Visual reference escapes spec/references: ${file}`);
      const info = await lstat(path.join(root, file));
      if (!info.isFile() || info.size > 10_000_000) throw new Error(`Invalid visual reference: ${file}`);
      await mkdir(path.dirname(path.join(snapshotDir, file)), { recursive: true });
      await copyFile(path.join(root, file), path.join(snapshotDir, file));
      copied.push(file);
    }
  }
  const images = [];
  for (const [index, shot] of (context.screenshots ?? []).entries()) {
    const name = `screenshot-${index + 1}.png`;
    await copyFile(shot.file, path.join(snapshotDir, name));
    images.push({ ...shot, file: name });
  }
  const manifest = { kind, files: copied, ...context, screenshots: images, acceptedVisualSpec };
  await writeFile(path.join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const schema = JSON.parse(await readFile(path.join(harnessRoot, 'schemas/review.schema.json'), 'utf8'));
  const prompt = await readFile(path.join(harnessRoot, `prompts/${kind}-review.txt`), 'utf8');
  await save(path.join(dir, 'prompt.txt'), prompt);
  const args = claudeArgs(config.models.reviewer, schema);
  await save(path.join(dir, 'command.json'), { executable: 'claude', args, cwd: snapshotDir, startedAt: new Date().toISOString() });
  const result = await runner('claude', args, { cwd: snapshotDir, input: prompt, env: subscriptionEnv(), timeoutMs: 1_200_000 });
  await save(path.join(dir, 'process.json'), result);
  requireSuccess(result, 'Claude Opus review');
  const finding = parseReview(result.stdout);
  await save(path.join(dir, 'review.json'), finding);
  return finding;
}

export function codexPermissions(readOnly = false) {
  const paths = readOnly ? ['.'] : ['.', ...modPaths, 'build', '.gradle'];
  const access = paths.map(file => `${JSON.stringify(file)} = ${JSON.stringify(file === '.' ? 'read' : 'write')}`).join(', ');
  return ['-c', 'default_permissions="mod-development"', '-c',
    `permissions = { mod-development = { filesystem = { ":root" = "read", ":tmpdir" = "write", ":slash_tmp" = "write", "~/.gradle" = "write", ":workspace_roots" = { ${access} } }, network = { enabled = false } } }`];
}

export function implementationPrompt(spec, task, cli = '.harness/cli.mjs') {
  const instructions = `Work under this project's AGENTS.md and the common policy at ${path.join(harnessRoot, 'docs/ai/AGENT_POLICY.md')}. Editable project paths: ${modPaths.join(', ')}. All spec/** and harness files are read-only; report a blocker if they need changes. Never launch Minecraft or MC Pilot. Never run git commit, push, reset, rebase, checkout, stash, merge, or change Git metadata/index. Only the harness creates checkpoints. Preserve user changes. After each edit, run node ${JSON.stringify(cli)} validate --agent-fast (static/resource checks, Java classes, unit tests). Fix failures and rerun inside this Codex session. Exit successfully only after that command passes for the final files. Do not run GameTest, review, E2E, or harness self-tests.`;
  if (task.milestone && task.repair) return `${instructions}\n\nRepair the current candidate; do not restart the whole task or implement future milestones.\nMilestone: ${task.milestone.id}\nACs: ${JSON.stringify(task.milestone.acceptanceCriteria)}\nExcluded scope: ${JSON.stringify(task.milestone.excludedScope)}\nReason: ${task.task}\nFindings/errors: ${JSON.stringify(task.findings ?? task.failures ?? [])}\nEvidence: ${task.evidence ?? 'current attempt artifacts'}\nChanged files: ${JSON.stringify(task.changedFiles ?? [])}\nRead only the relevant PROJECT.md excerpts when a finding needs clarification.`;
  if (task.milestone) return `${instructions}\n\nImplement only this complete vertical slice. Do not implement future milestones, excludedScope, speculative interfaces or extension points. PROJECT.md is authoritative over generated context. Read related spec excerpts only as needed. Prior completed work is in Git, not a conversation transcript.\n${JSON.stringify(task)}`;
  if (!task.repair) return `${instructions}\n\nSpecification:\n${spec}\n\nCurrent task:\n${JSON.stringify(task)}`;
  const ids = [...new Set(JSON.stringify(task).match(/\bAC-[A-Za-z0-9-]+\b/g) ?? [])];
  const criteria = spec.split('\n').filter(line => ids.some(id => line.startsWith(`- ${id}:`)));
  return `${instructions}\n\nRepair the current candidate using this evidence. Inspect changed files and only the relevant PROJECT.md excerpts if needed.\nReason: ${task.task}\nFindings/errors: ${JSON.stringify(task.findings ?? task.failures ?? [])}\nChanged files: ${JSON.stringify(task.changedFiles ?? [])}\nRelated acceptance criteria: ${criteria.length ? criteria.join('\n') : 'No AC ID identified in the finding; inspect relevant criteria only if needed.'}`;
}

export async function implement(root, runner, config, dir, task) {
  const spec = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
  if (!task.repair && !task.milestone && spec.length > 30_000) throw new Error('PROJECT.md exceeds 30 KB; split relevant features into spec/features');
  const prompt = implementationPrompt(spec, task, path.join(harnessRoot, 'cli.mjs'));
  await save(path.join(dir, 'task.json'), task);
  const before = await snapshot(root, runner);
  const beforeHead = await head(root, runner);
  const fastDir = await mkdtemp(path.join(os.tmpdir(), 'mcmod-agent-fast-'));
  const args = ['--no-daemon', 'exec', '--model', config.models.implementer, '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--strict-config', ...codexPermissions(),
    '-c', 'approval_policy="never"', '--cd', root, '--output-last-message', path.join(dir, 'implementation-summary.txt'), '-'];
  await save(path.join(dir, 'command.json'), { executable: 'codex', args });
  try {
    const result = await runner('codex', args, { cwd: root, input: prompt, env: { ...subscriptionEnv(), HARNESS_AGENT_FAST_DIR: fastDir,
      ...(task.projectModelFile ? { HARNESS_PROJECT_MODEL_PATH: task.projectModelFile } : {}),
      ...(task.criteria ? { HARNESS_VERIFY_CRITERIA: JSON.stringify(task.criteria) } : {}) }, timeoutMs: 1_800_000 });
    await save(path.join(dir, 'process.json'), result);
    requireSuccess(result, 'Codex Sol implementation');
    let validation;
    try { validation = JSON.parse(await readFile(path.join(fastDir, 'validation.json'), 'utf8')); }
    catch { throw new Error('Codex did not complete validate --agent-fast in this session'); }
    if (validation.ok !== true || validation.static?.ok !== true || validation.gradle?.ok !== true || validation.gradle.stage !== 'compile') {
      throw new Error('Codex fast validation did not pass; inspect its validation output');
    }
    const current = await snapshot(root, runner);
    if (JSON.stringify(validation.validatedFiles) !== JSON.stringify(current)) throw new Error('Files changed after Codex fast validation; rerun within the implementation session');
    await save(path.join(dir, 'validation.json'), validation);
  } finally {
    try {
      for (const file of ['validation.json', 'gradle.log', 'failure.json']) {
        try { await save(path.join(dir, 'agent-fast', file), await readFile(path.join(fastDir, file), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await assertHarnessUnchanged(root, runner, before);
      await assertHead(root, runner, beforeHead);
    } finally { await rm(fastDir, { recursive: true, force: true }); }
  }
}

export async function compileProject(root, runner, config, dir, previous) {
  await mkdir(dir, { recursive: true });
  const specText = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
  const before = await snapshot(root, runner), beforeHead = await head(root, runner);
  const output = path.join(dir, 'generated-model.json');
  const args = ['--no-daemon', 'exec', '--model', config.models.implementer, '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
    ...codexPermissions(true), '-c', 'approval_policy="never"', '--cd', root, '--output-schema', path.join(harnessRoot, 'schemas/project-model.schema.json'), '--output-last-message', output, '-'];
  const prompt = `Compile spec/PROJECT.md into one derived project model. Do not edit files, run builds, launch Minecraft, or operate Git. PROJECT.md is the sole product authority. Extract user-visible features, requirements, acceptance criteria, constraints, non-goals, and verification. Every source.quote must be an exact substring of its named PROJECT.md section. Never invent product behavior. Assign each requirement to a feature or global scope and each AC to a requirement. Features represent coherent observable capabilities, not technical layers. Assign at least one suitable verification to every AC: scenario IDs for e2e/persistence/multiplayer, scenario/screenshot IDs for visual, and concrete planned source/resource paths for unit/gametest/static. References must name only sources present in PROJECT.md; never fabricate external retrieval. Put only material product ambiguity in openQuestions with why, alternatives, and the PROJECT.md edit needed. Preserve IDs for unchanged meaning, retire removed IDs, and allocate new IDs above the previous maximum. Copy projectSourceHash exactly. Return schema JSON only.\n${JSON.stringify({ projectSourceHash: projectHash(specText), project: specText, previous })}`;
  await save(path.join(dir, 'command.json'), { executable: 'codex', args });
  try {
    const result = await runner('codex', args, { cwd: root, input: prompt, env: subscriptionEnv(), timeoutMs: 1_800_000 });
    await save(path.join(dir, 'process.json'), result);
    requireSuccess(result, 'Codex specification compilation');
    return validateProjectModel(JSON.parse(await readFile(output, 'utf8')), specText, previous);
  } finally {
    await assertHead(root, runner, beforeHead);
    if (hash(before) !== hash(await snapshot(root, runner))) throw Object.assign(new Error('Project files changed during read-only specification compilation'), { code: 'HARNESS_CHANGED' });
  }
}

export async function planProject(root, runner, config, dir, context, previousPlan, completed) {
  await mkdir(dir, { recursive: true });
  const before = await snapshot(root, runner), beforeHead = await head(root, runner);
  const output = path.join(dir, 'generated-plan.json');
  const args = ['--no-daemon', 'exec', '--model', config.models.implementer, '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
    ...codexPermissions(true), '-c', 'approval_policy="never"', '--cd', root, '--output-schema', path.join(harnessRoot, 'schemas/work-plan.schema.json'), '--output-last-message', output, '-'];
  const prompt = `Produce a Work Plan only. Do not edit files, run builds, launch Minecraft, or modify Git. Follow ${harnessRoot}/docs/ai/CODE_QUALITY.md. PROJECT.md is the sole product authority; context.model is derived and subordinate. Split context.criteria into independently verifiable, buildable, commit-worthy vertical slices. Do not split by infrastructure or file count, and add no speculative future abstractions. Assign each AC exactly once, preserve required verification, state excludedScope, and use only earlier dependencies. Use consecutive M01, M02 IDs; small projects need one milestone. Verification arrays must contain exact Evidence references from context.rows: unit from unit, gameTest from gametest, e2e from e2e/multiplayer/persistence, visual from visual. Use empty arrays when no rows match. Static evidence is checked automatically and must not go in unit. The harness runs static validation, build/unit, and final regression. Keep completed milestone definitions JSON-identical and in order. Copy projectId/baseCommit/specHash/modelHash exactly from context. Return schema JSON only.\n${JSON.stringify({ context, previousPlan, completed })}`;
  await save(path.join(dir, 'command.json'), { executable: 'codex', args });
  try {
    const result = await runner('codex', args, { cwd: root, input: prompt, env: subscriptionEnv(), timeoutMs: 1_800_000 });
    await save(path.join(dir, 'process.json'), result);
    requireSuccess(result, 'Codex Work Plan');
    return JSON.parse(await readFile(output, 'utf8'));
  } finally {
    await assertHead(root, runner, beforeHead);
    if (hash(before) !== hash(await snapshot(root, runner))) throw Object.assign(new Error('Project files changed during read-only planning'), { code: 'HARNESS_CHANGED' });
  }
}
