import { readFile, writeFile, mkdir, copyFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { save, gitFiles, modPaths, snapshot, assertHarnessUnchanged } from './repository.mjs';
import { subscriptionEnv, requireSuccess } from './process.mjs';

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

export function visualSpecification(text, ids) {
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
    if (kind === 'harness') return /^(?:harness\/|docs\/ai\/|spec\/|tests\/e2e\/|AGENTS\.md$|CLAUDE\.md$|README\.md$|package\.json$|build\.gradle$|settings\.gradle$|gradle\.properties$|\.gitignore$)/.test(file);
    return /^(src\/|spec\/|tests\/e2e\/|docs\/ai\/CODE_QUALITY\.md$|(?:build|settings)\.gradle$|gradle\.properties$)/.test(file);
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
  let acceptedVisualSpec;
  if (kind === 'visual') {
    acceptedVisualSpec = visualSpecification(await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8'),
      (context.screenshots ?? []).flatMap(shot => shot.acceptanceCriteria));
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
  const schema = JSON.parse(await readFile(path.join(root, 'harness/schemas/review.schema.json'), 'utf8'));
  const prompt = await readFile(path.join(root, `harness/prompts/${kind === 'harness' ? 'harness-review' : kind === 'visual' ? 'visual-review' : 'code-review'}.txt`), 'utf8');
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

export function codexPermissions() {
  const paths = ['.', ...modPaths, 'build', '.gradle'];
  const access = paths.map(file => `${JSON.stringify(file)} = ${JSON.stringify(file === '.' ? 'read' : 'write')}`).join(', ');
  return ['-c', 'default_permissions="mod-development"', '-c',
    `permissions = { mod-development = { filesystem = { ":root" = "read", ":tmpdir" = "write", ":slash_tmp" = "write", "~/.gradle" = "write", ":workspace_roots" = { ${access} } }, network = { enabled = false } } }`];
}

export async function implement(root, runner, config, dir, task) {
  const spec = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
  if (spec.length > 30_000) throw new Error('PROJECT.md exceeds 30 KB; split relevant features into spec/features');
  const prompt = `Implement the current task in this repository. Follow AGENTS.md. Editable project paths: ${modPaths.join(', ')}. All harness files are read-only; stop and report a blocker if they need changes. Never launch Minecraft or MC Pilot; the harness owns lifecycle. Do not commit. Preserve existing user changes. Read only relevant linked feature specs.\n\nSpecification:\n${spec}\n\nCurrent task (structured evidence only):\n${JSON.stringify(task)}`;
  await save(path.join(dir, 'task.json'), task);
  const before = await snapshot(root, runner);
  const args = ['--no-daemon', 'exec', '--model', config.models.implementer, '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--strict-config', ...codexPermissions(),
    '-c', 'approval_policy="never"', '--cd', root, '--output-last-message', path.join(dir, 'implementation-summary.txt'), '-'];
  await save(path.join(dir, 'command.json'), { executable: 'codex', args });
  try {
    const result = await runner('codex', args, { cwd: root, input: prompt, env: subscriptionEnv(), timeoutMs: 1_800_000 });
    await save(path.join(dir, 'process.json'), result);
    requireSuccess(result, 'Codex Sol implementation');
  } finally { await assertHarnessUnchanged(root, runner, before); }
}
