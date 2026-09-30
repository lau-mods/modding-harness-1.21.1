#!/usr/bin/env node
import { harnessRoot } from './lib/paths.mjs';
import { createProject } from './lib/create.mjs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { readFile, writeFile, mkdir, readdir, open, unlink } from 'node:fs/promises';
import { run, gradleCommand, requireSuccess } from './lib/process.mjs';
import { loadConfig, save, snapshot, workingChanges, changedSince, classify, assertHarnessUnchanged } from './lib/repository.mjs';
import { validate, parseSpec, gameTest, harnessValidation, harnessTests } from './lib/validate.mjs';
import { doctor } from './lib/doctor.mjs';
import { review, implement } from './lib/agents.mjs';
import { createSession, setupRuntime } from './lib/mc-pilot.mjs';
import { acceptanceCoverage, coverageRows } from './lib/coverage.mjs';
import { developWorkflow, dryRunActions } from './lib/workflow.mjs';

let command, flags, root, options, target, argumentError;
try {
  const parsed = parseArgs({ allowPositionals: true, tokens: true, options: {
    project: { type: 'string' }, 'harness-ref': { type: 'string' }, 'harness-url': { type: 'string' },
    static: { type: 'boolean' }, build: { type: 'boolean' }, 'agent-fast': { type: 'boolean' },
    'dry-run': { type: 'boolean' }, 'accept-eula': { type: 'boolean' }, players: { type: 'string' }
  } });
  [command, target] = parsed.positionals;
  options = parsed.values;
  const allowed = { doctor: ['project'], validate: ['project', 'static', 'build', 'agent-fast'],
    'review-harness': [], develop: ['project', 'dry-run'], 'setup-runtime': ['project', 'accept-eula', 'players'],
    create: ['harness-ref', 'harness-url'] };
  if (!Object.hasOwn(allowed, command) || Object.keys(options).some(key => !allowed[command].includes(key)) ||
      parsed.positionals.length !== (command === 'create' ? 2 : 1) ||
      (command === 'validate' && parsed.tokens.filter(token => token.kind === 'option' && ['static', 'build', 'agent-fast'].includes(token.name)).length > 1) ||
      parsed.tokens.filter(token => token.kind === 'option' && token.name === 'players').length > 1 ||
      (options.players !== undefined && (!/^[1-9]\d*$/.test(options.players) || !Number.isSafeInteger(Number(options.players))))) throw new Error('Invalid arguments');
  flags = Object.keys(options).filter(key => options[key] === true).map(key => '--' + key);
  root = command === 'review-harness' ? harnessRoot : path.resolve(options.project || process.cwd());
} catch (error) { argumentError = error; }
if (argumentError) {
  console.error(`${argumentError.message}\nUsage: node .harness/cli.mjs doctor | validate [--static|--build|--agent-fast] | develop [--dry-run] | setup-runtime [--accept-eula] [--players=N] [--project PATH]\n       node cli.mjs review-harness | create TARGET [--harness-ref TAG_OR_SHA] [--harness-url URL]`);
  process.exitCode = 2;
} else if (command === 'create') {
  try {
    const result = await createProject(target, { harnessRef: options['harness-ref'], harnessUrl: options['harness-url'] });
    console.log(JSON.stringify(result, null, 2));
    console.log('Created project + .harness submodule. Run npm --prefix .harness ci --ignore-scripts in the target, then doctor. Review and commit the initial project before develop.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  const playerCount = Number(options.players || 1);
  const id = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
  const dir = command === 'validate' && flags.includes('--agent-fast') && process.env.HARNESS_AGENT_FAST_DIR
    ? path.resolve(process.env.HARNESS_AGENT_FAST_DIR)
    : path.join(root, '.harness-artifacts', command === 'review-harness' ? 'harness-review' : command, id);
  await mkdir(dir, { recursive: true });
  let lock;
  const lockPath = path.join(root, '.harness-artifacts/develop.lock');
  try {
    const config = await loadConfig();
    if (command === 'setup-runtime') {
      lock = await open(lockPath, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid, dir }));
      console.log(await setupRuntime(root, run, dir, { acceptEula: flags.includes('--accept-eula'), playerCount }));
    } else if (command === 'doctor') {
      const result = await doctor(root, run); await save(path.join(dir, 'doctor.json'), result);
      for (const check of result.checks) console.log(`${check.ok ? 'OK' : 'MISSING'} ${check.name}: ${check.detail}`);
      process.exitCode = result.ok ? 0 : 1;
    } else if (command === 'validate') {
      await validate(root, run, dir, { stage: flags.includes('--static') ? 'static' : flags.includes('--build') ? 'build' : 'compile', requireReady: flags.includes('--agent-fast'), agentFast: flags.includes('--agent-fast') });
      console.log('Validation passed');
    } else if (command === 'review-harness') {
      const validation = await harnessValidation();
      if (!validation.ok) throw new Error(validation.errors.join('\n'));
      await harnessTests(run, path.join(dir, 'verification'));
      let previousFindings = [];
      for (const previous of (await readdir(path.dirname(dir))).filter(name => name !== id).sort().reverse()) {
        try { previousFindings = JSON.parse(await readFile(path.join(path.dirname(dir), previous, 'review.json'), 'utf8')).findings; break; }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      }
      const result = await review(root, run, config, dir, 'harness', { validation, previousFindings });
      console.log(JSON.stringify(result, null, 2)); process.exitCode = result.verdict === 'pass' ? 0 : 1;
    } else if (flags.includes('--dry-run')) {
      const result = await developWorkflow(dryRunActions(state => save(path.join(dir, 'summary.json'), { ...state, simulated: true })), config.budgets);
      console.log(JSON.stringify({ ...result, simulated: true }, null, 2)); process.exitCode = result.status === 'pass' ? 0 : 1;
    } else {
      // Lock is exclusive; never steal it automatically after a crash.
      lock = await open(lockPath, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid, dir }));
      const initial = await snapshot(root, run);
      const initialChanges = await workingChanges(root, run);
      const specificationAtStart = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
      await save(path.join(dir, 'initial-state.json'), { initial, initialChanges, specificationAtStart });
      let attempt = 0, candidateDir, changed = [], correctionBase, session, scenarios;
      const assertPolicyUnchanged = () => assertHarnessUnchanged(root, run, initial);
      const actions = {
        guard: assertPolicyUnchanged,
        record: state => save(path.join(dir, 'summary.json'), state),
        async specification() {
          const text = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
          const spec = parseSpec(text);
          const rows = coverageRows(text);
          const missing = spec.criteria.filter(id => !rows.some(row => row.ac === id));
          if (missing.length) throw new Error(`Specification needs Verification assignments for ${missing.join(', ')}; see .harness/docs/ai/SPEC_WRITING.md`);
          const environment = await doctor(root, run);
          await save(path.join(dir, 'doctor.json'), environment);
          const mandatory = environment.checks.filter(check => !/MC Pilot|E2E runtime/.test(check.name));
          if (mandatory.some(check => !check.ok)) throw new Error('Required development environment unavailable; see doctor.json');
        },
        async implement(task) {
          candidateDir = path.join(dir, `candidate-${++attempt}`);
          await implement(root, run, config, candidateDir, task.repair ? { ...task, changedFiles: changed } : task);
          const current = await assertPolicyUnchanged();
          changed = [...new Set([...initialChanges, ...changedSince(initial, current)])];
          await save(path.join(candidateDir, 'changed-files.json'), { files: changed, classification: classify(changed) });
          const diff = requireSuccess(await run('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'src', 'spec', 'tests', 'build.gradle', 'settings.gradle', 'gradle.properties'], { cwd: root }), 'git diff');
          await writeFile(path.join(candidateDir, 'diff.patch'), diff.stdout);
        },
        verify: () => validate(root, run, path.join(candidateDir, 'harness-verification'), { stage: 'static', requireReady: true }),
        async review() {
          const diff = await readFile(path.join(candidateDir, 'diff.patch'), 'utf8');
          const currentSpec = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
          const untracked = requireSuccess(await run('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root }), 'git untracked files');
          const { validatedFiles, ...validation } = JSON.parse(await readFile(path.join(candidateDir, 'validation.json'), 'utf8'));
          return review(root, run, config, path.join(candidateDir, 'code-review'), 'code', {
            specificationBeforeEdit: currentSpec === specificationAtStart ? undefined : specificationAtStart,
            changedFiles: changed, validation,
            changedFilesAbsentFromDiff: untracked.stdout.split('\0').filter(file => changed.includes(file) && /^(src\/|spec\/|tests\/e2e\/|(?:build|settings)\.gradle$|gradle\.properties$)/.test(file)), diffTruncated: diff.length > 60_000,
            diff: diff.slice(0, 60_000) + (diff.length > 60_000 ? '\n[DIFF TRUNCATED: read affected snapshot source files for the remaining changes]' : '')
          });
        },
        async build() {
          const cmd = gradleCommand(root, ['build']); const result = await run(cmd.command, cmd.args, { cwd: root, timeoutMs: 900_000 });
          await save(path.join(candidateDir, 'build.log'), result.stdout + result.stderr); requireSuccess(result, 'Gradle build');
        },
        async gameTest() {
          if (classify(changed).gameTest) return gameTest(root, run, candidateDir, config.gameTest);
          const result = { status: 'not-applicable', reason: 'Change classification does not require world/server verification' };
          await save(path.join(candidateDir, 'gametest.json'), result); return result;
        },
        classify: async () => classify(changed),
        async preflight() {
          scenarios = (await acceptanceCoverage(root, candidateDir)).scenarios;
          if (!scenarios.length) throw new Error('Runtime changes require acceptance-linked *.scenario.mjs coverage');
          if (classify(changed).visual && !scenarios.some(scenario => scenario.visual)) throw new Error('Visual changes require a scenario with visual criteria and screenshots');
          const playerCount = Math.max(...scenarios.map(s => s.players ?? 1));
          const requiredBoots = playerCount * (scenarios.some(s => s.phase === 'after-restart') ? 2 : 1);
          if (requiredBoots > config.budgets.gameBoots) throw new Error(`Scenarios require at least ${requiredBoots} client boots; gameBoots is ${config.budgets.gameBoots}`);
          session = await createSession(root, run, path.join(dir, 'runtime'), { playerCount });
          return session.playerCount;
        },
        start: () => session.start(), stop: async () => { if (session) await session.stop(); },
        async e2e(cycle) {
          const result = await session.batch(scenarios.filter(s => s.phase !== 'after-restart'), cycle);
          return { ...result, requiresRestart: scenarios.some(s => s.phase === 'after-restart') };
        },
        e2ePersistence: cycle => session.batch(scenarios.filter(s => s.phase === 'after-restart'), `${cycle}-persisted`),
        visual: result => review(root, run, config, path.join(candidateDir, 'visual-review'), 'visual', { screenshots: result.screenshots }),
        async markCorrection() { correctionBase = await snapshot(root, run); },
        async classifyCorrection() {
          const current = await assertPolicyUnchanged();
          const files = changedSince(correctionBase, current);
          const classification = classify(files);
          if (files.some(file => !current[file])) classification.restart = true;
          try { await session.ready(); } catch { classification.restart = true; }
          scenarios = (await acceptanceCoverage(root, candidateDir)).scenarios;
          if (!scenarios.length || (classify(changed).visual && !scenarios.some(scenario => scenario.visual))) throw new Error('Required E2E/visual coverage was removed during correction');
          if (scenarios.some(s => (s.players ?? 1) > session.playerCount)) throw new Error('Correction requires more clients; prepare the runtime and start a new development run');
          return classification;
        },
        reload: kinds => session.reload(kinds)
      };
      const result = await developWorkflow(actions, config.budgets);
      console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'pass' ? 0 : 1;
    }
  } catch (error) {
    await save(path.join(dir, 'failure.json'), { error: error.message });
    console.error(error.message); process.exitCode = 1;
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath); }
    console.log(`Artifacts: ${path.relative(root, dir)}`);
  }
}
