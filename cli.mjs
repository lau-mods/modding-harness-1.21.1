#!/usr/bin/env node
import { harnessRoot } from './lib/paths.mjs';
import { createProject } from './lib/create.mjs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { readFile, mkdir, readdir, open, unlink } from 'node:fs/promises';
import { run } from './lib/process.mjs';
import { loadConfig, save } from './lib/repository.mjs';
import { validate, harnessValidation, harnessTests } from './lib/validate.mjs';
import { doctor } from './lib/doctor.mjs';
import { review } from './lib/agents.mjs';
import { setupRuntime } from './lib/mc-pilot.mjs';
import { developWorkflow, dryRunActions } from './lib/workflow.mjs';
import { runDevelopment } from './lib/develop.mjs';
import { checkpointDevelopment, resumeDirectory } from './lib/checkpoints.mjs';

let command, flags, root, options, target, argumentError;
try {
  const parsed = parseArgs({ allowPositionals: true, tokens: true, options: {
    project: { type: 'string' }, 'harness-ref': { type: 'string' }, 'harness-url': { type: 'string' },
    static: { type: 'boolean' }, build: { type: 'boolean' }, 'agent-fast': { type: 'boolean' },
    'dry-run': { type: 'boolean' }, 'accept-eula': { type: 'boolean' }, players: { type: 'string' },
    task: { type: 'string' }, resume: { type: 'boolean' }, replan: { type: 'boolean' }, 'plan-only': { type: 'boolean' }, 'stop-after': { type: 'string' }
  } });
  [command, target] = parsed.positionals;
  options = parsed.values;
  const allowed = { doctor: ['project'], validate: ['project', 'static', 'build', 'agent-fast'],
    'review-harness': [], develop: ['project', 'dry-run', 'task', 'resume', 'replan', 'plan-only', 'stop-after'], 'setup-runtime': ['project', 'accept-eula', 'players'],
    create: ['harness-ref', 'harness-url'] };
  if (!Object.hasOwn(allowed, command) || Object.keys(options).some(key => !allowed[command].includes(key)) ||
      parsed.positionals.length !== (command === 'create' ? 2 : 1) ||
      (command === 'validate' && parsed.tokens.filter(token => token.kind === 'option' && ['static', 'build', 'agent-fast'].includes(token.name)).length > 1) ||
      parsed.tokens.filter(token => token.kind === 'option' && token.name === 'players').length > 1 ||
      (options.players !== undefined && (!/^[1-9]\d*$/.test(options.players) || !Number.isSafeInteger(Number(options.players))))) throw new Error('Invalid arguments');
  flags = Object.keys(options).filter(key => options[key] === true).map(key => '--' + key);
  if ((options.resume && (options.task || options['dry-run'])) || (options.replan && !options.resume) ||
      ((options['plan-only'] || options['stop-after']) && !options.task && !options.resume)) throw new Error('Checkpoint options require --task or --resume; --replan requires --resume');
  root = command === 'review-harness' ? harnessRoot : path.resolve(options.project || process.cwd());
} catch (error) { argumentError = error; }
if (argumentError) {
  console.error(`${argumentError.message}\nUsage: node .harness/cli.mjs doctor | validate [--static|--build|--agent-fast] | develop [--task spec/tasks/TASK.md [--plan-only|--dry-run] [--stop-after M01] | --resume [--replan]] | setup-runtime [--accept-eula] [--players=N] [--project PATH]\n       node cli.mjs review-harness | create TARGET [--harness-ref TAG_OR_SHA] [--harness-url URL]`);
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
  const checkpoint = command === 'develop' && (options.task || options.resume);
  let dir = command === 'validate' && flags.includes('--agent-fast') && process.env.HARNESS_AGENT_FAST_DIR
    ? path.resolve(process.env.HARNESS_AGENT_FAST_DIR)
    : path.join(root, '.harness-artifacts', checkpoint ? 'checkpoints' : command === 'review-harness' ? 'harness-review' : command, id);
  await mkdir(dir, { recursive: true });
  let lock;
  const lockPath = path.join(root, '.harness-artifacts/develop.lock');
  try {
    if (options.resume) dir = await resumeDirectory(root);
    const config = await loadConfig();
    if (command === 'setup-runtime') {
      lock = await open(lockPath, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid, dir }));
      console.log(await setupRuntime(root, run, dir, { acceptEula: flags.includes('--accept-eula'), playerCount }));
    } else if (command === 'doctor') {
      const result = await doctor(root, run); await save(path.join(dir, 'doctor.json'), result);
      for (const check of result.checks) console.log(`${check.ok ? 'OK' : 'MISSING'} ${check.name}: ${check.detail}`);
      process.exitCode = result.ok ? 0 : 1;
    } else if (command === 'validate') {
      await validate(root, run, dir, { stage: flags.includes('--static') ? 'static' : flags.includes('--build') ? 'build' : 'compile', requireReady: flags.includes('--agent-fast'), agentFast: flags.includes('--agent-fast'),
        criteria: flags.includes('--agent-fast') && process.env.HARNESS_VERIFY_CRITERIA ? JSON.parse(process.env.HARNESS_VERIFY_CRITERIA) : undefined });
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
    } else if (checkpoint) {
      lock = await open(lockPath, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid, dir }));
      let interrupted = false;
      const interrupt = () => { interrupted = true; };
      process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
      try {
        const result = await checkpointDevelopment(root, run, config, dir, { task: options.task, resume: options.resume, replan: options.replan,
          planOnly: options['plan-only'], dryRun: options['dry-run'], stopAfter: options['stop-after'], interrupted: () => interrupted });
        console.log(JSON.stringify({ status: result.status, simulated: result.simulated, taskId: result.taskId, currentMilestone: result.currentMilestone,
          completedMilestones: result.completedMilestones ?? Object.entries(result.milestones ?? {}).filter(([, value]) => value.status === 'committed').map(([id, value]) => ({ id, commit: value.commit })),
          failureStage: result.failureStage, error: result.error, recommendedAction: result.recommendedAction, evidence: dir }, null, 2));
        process.exitCode = ['complete', 'planned', 'stopped'].includes(result.status) ? 0 : 1;
      } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
    } else if (flags.includes('--dry-run')) {
      const result = await developWorkflow(dryRunActions(state => save(path.join(dir, 'summary.json'), { ...state, simulated: true })), config.budgets);
      console.log(JSON.stringify({ ...result, simulated: true }, null, 2)); process.exitCode = result.status === 'pass' ? 0 : 1;
    } else {
      // Lock is exclusive; never steal it automatically after a crash.
      lock = await open(lockPath, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid, dir }));
      const result = await runDevelopment(root, run, config, dir);
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
