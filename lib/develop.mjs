import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { gradleCommand, requireSuccess } from './process.mjs';
import { save, snapshot, workingChanges, changedSince, classify, assertHarnessUnchanged } from './repository.mjs';
import { validate, parseSpec, gameTest } from './validate.mjs';
import { doctor } from './doctor.mjs';
import { review, implement } from './agents.mjs';
import { createSession } from './mc-pilot.mjs';
import { acceptanceCoverage, coverageRows, selectScenarios } from './coverage.mjs';
import { modelRows, validateProjectModel } from './project-model.mjs';
import { developWorkflow } from './workflow.mjs';
import { head, assertHead, candidateFingerprint, assertCandidate } from './checkpoint-git.mjs';

export async function runDevelopment(root, run, config, dir, options = {}, services = {}) {
  const integration = { doctor, implement, review, validate, gameTest, createSession, ...services };
  const initial = await snapshot(root, run);
  const initialHead = await head(root, run);
  const initialChanges = await workingChanges(root, run);
  const specificationAtStart = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
  await save(path.join(dir, 'initial-state.json'), { initial, initialChanges, specificationAtStart });
  let attempt = 0, candidateDir = path.join(dir, 'regression'), changed = [], correctionBase, session, scenarios, verified, reviewedFiles;
  const assertPolicyUnchanged = async () => {
    await assertHead(root, run, initialHead);
    const current = await assertHarnessUnchanged(root, run, initial);
    if (verified) assertCandidate(verified, await candidateFingerprint(root, run, { requireJar: true }));
    if (options.interrupted?.()) throw Object.assign(new Error('Development interrupted'), { code: 'INTERRUPTED' });
    return current;
  };
  const requiredRows = (options.model ? modelRows(options.model) : coverageRows(specificationAtStart)).filter(row => !options.milestone || options.milestone.acceptanceCriteria.includes(row.ac));
  const fullRegression = options.regression || options.milestone?.verification.fullRegression;
  async function coverage() {
    const result = await acceptanceCoverage(root, candidateDir, { criteria: options.criteria, model: options.model });
    scenarios = selectScenarios(result.scenarios, requiredRows, changed, { fullRegression, runtimeChanged: classify(changed).e2e, verification: options.milestone?.verification, criteria: options.criteria });
  }
  function classification() {
    const result = classify(changed);
    result.e2e ||= !!scenarios?.length || requiredRows.some(row => ['e2e', 'visual', 'persistence', 'multiplayer'].includes(row.method));
    result.visual ||= requiredRows.some(row => row.method === 'visual') || !!options.milestone?.verification.visual.length;
    result.gameTest ||= config.gameTest === 'required' || !!options.regression || requiredRows.some(row => row.method === 'gametest') || !!options.milestone?.verification.gameTest.length;
    return result;
  }
  const actions = {
    initialTask: options.repair
      ? { repair: true, task: 'Repair the current milestone candidate', milestone: options.context, criteria: options.criteria,
          findings: [`${options.repair.stage}: ${options.repair.summary}`], evidence: options.repair.evidence }
      : { task: 'Implement the current accepted vertical slice', milestone: options.context, criteria: options.criteria },
    guard: assertPolicyUnchanged,
    async record(state) { await save(path.join(dir, 'summary.json'), state); await options.onRecord?.(state); },
    async specification() {
      const text = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
      const spec = parseSpec(text);
      if (options.model) validateProjectModel(options.model, text);
      const rows = options.model ? modelRows(options.model) : coverageRows(text);
      const missing = (options.model ? options.model.acceptanceCriteria.map(item => item.id) : spec.criteria).filter(id => !rows.some(row => row.ac === id));
      if (missing.length) throw new Error(`Specification needs Verification assignments for ${missing.join(', ')}; see .harness/docs/ai/SPEC_WRITING.md`);
      const environment = await integration.doctor(root, run);
      await save(path.join(dir, 'doctor.json'), environment);
      const mandatory = environment.checks.filter(check => !/MC Pilot|E2E runtime/.test(check.name));
      if (mandatory.some(check => !check.ok)) throw new Error('Required development environment unavailable; see doctor.json');
    },
    async implement(task) {
      verified = undefined;
      candidateDir = path.join(dir, `candidate-${++attempt}`);
      await integration.implement(root, run, config, candidateDir, { ...task, milestone: options.context, criteria: options.criteria, projectModelFile: options.projectModelFile, ...(task.repair ? { changedFiles: changed } : {}) });
      const current = await assertPolicyUnchanged();
      changed = [...new Set([...initialChanges, ...changedSince(initial, current)])];
      await save(path.join(candidateDir, 'changed-files.json'), { files: changed, classification: classify(changed) });
      const diff = requireSuccess(await run('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'src', 'spec', 'tests', 'build.gradle', 'settings.gradle', 'gradle.properties'], { cwd: root }), 'git diff');
      await writeFile(path.join(candidateDir, 'diff.patch'), diff.stdout);
    },
    verify: () => integration.validate(root, run, path.join(candidateDir, 'harness-verification'), { stage: options.regression ? 'compile' : 'static', requireReady: true, criteria: options.criteria, model: options.model }),
    async review() {
      const diff = await readFile(path.join(candidateDir, 'diff.patch'), 'utf8');
      const currentSpec = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
      const untracked = requireSuccess(await run('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root }), 'git untracked files');
      const { validatedFiles, ...validation } = JSON.parse(await readFile(path.join(candidateDir, 'validation.json'), 'utf8'));
      const decision = await integration.review(root, run, config, path.join(candidateDir, 'code-review'), 'code', {
        milestone: options.context, milestoneBase: initialHead,
        specificationBeforeEdit: currentSpec === specificationAtStart ? undefined : specificationAtStart,
        changedFiles: changed, validation,
        changedFilesAbsentFromDiff: untracked.stdout.split('\0').filter(file => changed.includes(file) && /^(src\/|spec\/|tests\/e2e\/|(?:build|settings)\.gradle$|gradle\.properties$)/.test(file)), diffTruncated: diff.length > 60_000,
        diff: diff.slice(0, 60_000) + (diff.length > 60_000 ? '\n[DIFF TRUNCATED: read affected snapshot source files for the remaining changes]' : '')
      });
      if (decision.verdict === 'pass') reviewedFiles = await snapshot(root, run);
      return decision;
    },
    async build() {
      const cmd = gradleCommand(root, ['build']); const result = await run(cmd.command, cmd.args, { cwd: root, timeoutMs: 900_000 });
      await save(path.join(candidateDir, 'build.log'), result.stdout + result.stderr); requireSuccess(result, 'Gradle build');
      if (reviewedFiles && changedSince(reviewedFiles, await snapshot(root, run)).length) throw new Error('Build changed reviewed source; revalidation and review required');
      if (options.checkpoint) {
        verified = await candidateFingerprint(root, run, { requireJar: true });
        await save(path.join(candidateDir, 'candidate-fingerprint.json'), verified);
      }
      await coverage();
    },
    async gameTest() {
      if (classification().gameTest) return integration.gameTest(root, run, candidateDir,
        requiredRows.some(row => row.method === 'gametest') || options.milestone?.verification.gameTest.length ? 'required' : config.gameTest);
      const result = { status: 'not-applicable', reason: 'Change classification does not require world/server verification' };
      await save(path.join(candidateDir, 'gametest.json'), result); return result;
    },
    classify: async () => classification(),
    async preflight() {
      if (!scenarios.length) throw new Error('Runtime changes require acceptance-linked *.scenario.mjs coverage');
      if (classification().visual && !scenarios.some(scenario => scenario.visual)) throw new Error('Visual changes require a scenario with visual criteria and screenshots');
      const playerCount = Math.max(...scenarios.map(s => s.players ?? 1));
      const requiredBoots = playerCount * (scenarios.some(s => s.phase === 'after-restart') ? 2 : 1);
      if (requiredBoots > config.budgets.gameBoots) throw new Error(`Scenarios require at least ${requiredBoots} client boots; gameBoots is ${config.budgets.gameBoots}`);
      session = await integration.createSession(root, run, path.join(dir, 'runtime'), { playerCount });
      return session.playerCount;
    },
    start: () => session.start(), stop: async () => { if (session) await session.stop(); },
    async e2e(cycle) {
      const result = await session.batch(scenarios.filter(s => s.phase !== 'after-restart'), cycle);
      return { ...result, requiresRestart: scenarios.some(s => s.phase === 'after-restart') };
    },
    e2ePersistence: cycle => session.batch(scenarios.filter(s => s.phase === 'after-restart'), `${cycle}-persisted`),
    visual: result => integration.review(root, run, config, path.join(candidateDir, 'visual-review'), 'visual', { screenshots: result.screenshots, model: options.model }),
    async markCorrection() { verified = undefined; correctionBase = await snapshot(root, run); },
    async classifyCorrection() {
      const current = await assertPolicyUnchanged();
      const files = changedSince(correctionBase, current);
      const correction = classify(files);
      if (files.some(file => !current[file])) correction.restart = true;
      try { await session.ready(); } catch { correction.restart = true; }
      await coverage();
      if (!scenarios.length || (classification().visual && !scenarios.some(scenario => scenario.visual))) throw new Error('Required E2E/visual coverage was removed during correction');
      if (scenarios.some(s => (s.players ?? 1) > session.playerCount)) throw new Error('Correction requires more clients; prepare the runtime and start a new development run');
      return correction;
    },
    reload: kinds => session.reload(kinds)
  };
  const result = await developWorkflow(actions, config.budgets, { regression: !!options.regression });
  return { ...result, candidate: verified };
}
