#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile, mkdir, readdir, open, unlink } from 'node:fs/promises';
import { run, gradleCommand, requireSuccess } from './lib/process.mjs';
import { loadConfig, save, snapshot, workingChanges, changedSince, classify } from './lib/repository.mjs';
import { validate, parseSpec, gameTest } from './lib/validate.mjs';
import { doctor } from './lib/doctor.mjs';
import { review, implement } from './lib/agents.mjs';
import { createSession, loadScenarios } from './lib/mc-pilot.mjs';
import { developWorkflow, dryRunActions } from './lib/workflow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...flags] = process.argv.slice(2);
const allowed = { doctor: [], validate: ['--static', '--build'], 'review-harness': [], develop: ['--dry-run'] };
if (!Object.hasOwn(allowed, command) || flags.some(flag => !allowed[command].includes(flag)) || (flags.includes('--static') && flags.includes('--build'))) {
  console.error('Usage: node harness/cli.mjs doctor | validate [--static|--build] | review-harness | develop [--dry-run]');
  process.exitCode = 2;
} else {
  const id = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
  const dir = path.join(root, '.harness-artifacts', command === 'review-harness' ? 'harness-review' : command, id);
  await mkdir(dir, { recursive: true });
  let lock;
  const lockPath = path.join(root, '.harness-artifacts/develop.lock');
  try {
    const config = await loadConfig(root);
    if (command === 'doctor') {
      const result = await doctor(root, run); await save(path.join(dir, 'doctor.json'), result);
      for (const check of result.checks) console.log(`${check.ok ? 'OK' : 'MISSING'} ${check.name}: ${check.detail}`);
      process.exitCode = result.ok ? 0 : 1;
    } else if (command === 'validate') {
      await validate(root, run, dir, { stage: flags.includes('--static') ? 'static' : flags.includes('--build') ? 'build' : 'compile' });
      console.log('Validation passed');
    } else if (command === 'review-harness') {
      const validation = await validate(root, run, path.join(dir, 'verification'), { stage: 'static' });
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
      await save(path.join(dir, 'initial-state.json'), { initial, initialChanges });
      let spec, attempt = 0, candidateDir, changed = [], correctionBase, session, scenarios;
      const assertPolicyUnchanged = async () => {
        const current = await snapshot(root, run);
        const protectedChanges = changedSince(initial, current).filter(file => /^(?:harness\/|AGENTS\.md$|CLAUDE\.md$|docs\/ai\/|spec\/PROJECT\.md$)/.test(file));
        if (protectedChanges.length) throw new Error(`Implementation changed protected harness/spec policy: ${protectedChanges.join(', ')}`);
        return current;
      };
      const actions = {
        record: state => save(path.join(dir, 'summary.json'), state),
        async specification() {
          spec = parseSpec(await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8'));
          const environment = await doctor(root, run);
          await save(path.join(dir, 'doctor.json'), environment);
          const mandatory = environment.checks.filter(check => !/MC Pilot|E2E runtime/.test(check.name));
          if (mandatory.some(check => !check.ok)) throw new Error('Required development environment unavailable; see doctor.json');
        },
        async implement(task) {
          candidateDir = path.join(dir, `candidate-${++attempt}`);
          await implement(root, run, config, candidateDir, task);
          const current = await assertPolicyUnchanged();
          changed = [...new Set([...initialChanges, ...changedSince(initial, current)])];
          await save(path.join(candidateDir, 'changed-files.json'), { files: changed, classification: classify(changed) });
          const diff = requireSuccess(await run('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'src', 'spec', 'tests', 'build.gradle', 'gradle.properties'], { cwd: root }), 'git diff');
          await writeFile(path.join(candidateDir, 'diff.patch'), diff.stdout);
        },
        verify: () => validate(root, run, candidateDir, { requireReady: true }),
        async review() {
          const diff = await readFile(path.join(candidateDir, 'diff.patch'), 'utf8');
          const untracked = requireSuccess(await run('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root }), 'git untracked files');
          return review(root, run, config, path.join(candidateDir, 'code-review'), 'code', {
            changedFiles: changed, validation: JSON.parse(await readFile(path.join(candidateDir, 'validation.json'), 'utf8')),
            changedFilesAbsentFromDiff: untracked.stdout.split('\0').filter(file => changed.includes(file) && /^(src\/|spec\/|tests\/e2e\/|build\.gradle$|gradle\.properties$)/.test(file)), diffTruncated: diff.length > 60_000,
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
          scenarios = await loadScenarios(root, spec.criteria);
          if (!scenarios.length) throw new Error('Runtime changes require acceptance-linked *.scenario.mjs coverage');
          if (classify(changed).visual && !scenarios.some(scenario => scenario.visual)) throw new Error('Visual changes require a scenario with visual criteria and screenshots');
          session = await createSession(root, run, path.join(dir, 'runtime'));
        },
        start: () => session.start(), stop: async () => { if (session) await session.stop(); },
        e2e: cycle => session.batch(scenarios, cycle),
        visual: result => review(root, run, config, path.join(candidateDir, 'visual-review'), 'visual', { screenshots: result.screenshots }),
        async markCorrection() { correctionBase = await snapshot(root, run); },
        async classifyCorrection() {
          const current = await assertPolicyUnchanged();
          const files = changedSince(correctionBase, current);
          const classification = classify(files);
          if (files.some(file => !current[file])) classification.restart = true;
          try { await session.ready(); } catch { classification.restart = true; }
          scenarios = await loadScenarios(root, spec.criteria);
          if (!scenarios.length || (classify(changed).visual && !scenarios.some(scenario => scenario.visual))) throw new Error('Required E2E/visual coverage was removed during correction');
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
