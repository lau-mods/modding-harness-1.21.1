import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { harnessRoot } from './paths.mjs';
import { snapshot, save, workingChanges } from './repository.mjs';
import { hash, projectContext, validatePlan, singleMilestonePlan, milestoneContext } from './work-plan.mjs';
import { projectHash, validateProjectModel, simulatedProjectModel } from './project-model.mjs';
import { atomicJson, checkpointGit, candidateFingerprint, assertCandidate, head, assertHead } from './checkpoint-git.mjs';
import { planProject, compileProject, review } from './agents.mjs';
import { runDevelopment } from './develop.mjs';
import { developWorkflow, dryRunActions } from './workflow.mjs';

export async function resumeDirectory(root) {
  const latest = JSON.parse(await readFile(path.join(root, '.harness-artifacts/checkpoints/latest.json'), 'utf8'));
  if (!/^[\w.-]+$/.test(latest.runId)) throw new Error('Invalid checkpoint run id');
  return path.join(root, '.harness-artifacts/checkpoints', latest.runId);
}

export async function checkpointDevelopment(root, runner, config, dir, options = {}, services = {}) {
  await mkdir(dir, { recursive: true });
  const git = checkpointGit(root, runner, dir);
  const stateFile = path.join(dir, 'state.json');
  const runtime = { head: await head(harnessRoot, runner), files: hash(await snapshot(harnessRoot, runner)) };
  const planGenerator = services.plan ?? ((context, previous, completed, destination) => planProject(root, runner, config, destination, context, previous, completed));
  const planReviewer = services.reviewPlan ?? ((context, plan, completed, destination) => review(root, runner, config, destination, 'plan', { projectModel: context.model, plan, completed }));
  const compiler = services.compile ?? ((destination, previous) => compileProject(root, runner, config, destination, previous));
  const execute = services.develop ?? ((destination, settings) => runDevelopment(root, runner, config, destination, settings));
  let state, context, plan, writableState = false;
  const persist = async () => {
    state.worktree = await candidateFingerprint(root, runner);
    await atomicJson(stateFile, state);
  };
  const completedDefinitions = () => plan?.milestones.filter(m => state.milestones[m.id]?.status === 'committed') ?? [];
  const checkInterrupted = () => { if (options.interrupted?.()) throw new Error('Interrupted; resume requires the saved repository state'); };
  async function priorModel() {
    try {
      const latest = await resumeDirectory(root);
      if (latest === dir) return undefined;
      const priorState = JSON.parse(await readFile(path.join(latest, 'state.json'), 'utf8'));
      if (!priorState.modelHash) return undefined;
      const model = JSON.parse(await readFile(path.join(latest, 'project-model.json'), 'utf8'));
      if (hash(model) !== priorState.modelHash) throw new Error('Previous project model hash mismatch');
      return { model, state: priorState };
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async function compileModel(previous) {
    const destination = path.join(dir, 'specification');
    const text = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
    const model = options.dryRun ? simulatedProjectModel(text) : await compiler(destination, previous?.model);
    validateProjectModel(model, text, options.dryRun ? undefined : previous?.model);
    await atomicJson(path.join(dir, 'project-model.json'), model);
    state.modelHash = hash(model);
    state.specHash = projectHash(text);
    context = projectContext(text, model, state.baseCommit);
    if (previous?.state && previous.model.projectSourceHash !== model.projectSourceHash) {
      const old = new Map(previous.model.acceptanceCriteria.map(item => [item.id, item]));
      const done = new Set(Object.entries(previous.state.milestones).filter(([, value]) => value.status === 'committed').flatMap(([id]) => previous.state.completedCriteria?.[id] ?? []));
      const changed = model.acceptanceCriteria.filter(item => !done.has(item.id) || old.get(item.id)?.text !== item.text || old.get(item.id)?.source.quote !== item.source.quote).map(item => item.id);
      if (changed.length) context.criteria = changed;
    }
    await persist();
  }
  async function acceptPlan(previous) {
    const completed = completedDefinitions();
    state.planAttempt = (state.planAttempt ?? 0) + 1;
    state.replanning = !!previous;
    await persist();
    const destination = path.join(dir, `plan-${state.planAttempt}`);
    let proposal;
    if (options.dryRun) proposal = singleMilestonePlan(context);
    else proposal = await planGenerator(context, previous, completed, destination);
    await assertHead(root, runner, state.expectedHead);
    assertCandidate(state.worktree, await candidateFingerprint(root, runner));
    validatePlan(proposal, context, completed);
    await atomicJson(path.join(destination, 'plan.json'), proposal);
    const decision = options.dryRun ? { verdict: 'pass', findings: [], summary: 'Simulated plan review; not independent evidence' }
      : await planReviewer(context, proposal, completed, path.join(destination, 'review'));
    await atomicJson(path.join(destination, 'review-result.json'), decision);
    await assertHead(root, runner, state.expectedHead);
    assertCandidate(state.worktree, await candidateFingerprint(root, runner));
    if (decision.verdict !== 'pass') throw new Error(`Plan review requires changes; inspect ${destination}`);
    plan = proposal;
    state.planRevision++;
    state.planHash = hash(plan);
    state.planFile = `plan-${state.planAttempt}/plan.json`;
    state.replanning = false;
    await persist();
  }
  async function finishCommit(milestone, pending) {
    if (await git.head() === pending.candidate.head) {
      await assertHead(root, runner, state.expectedHead);
      state.expectedHead = await git.commit(pending.candidate, pending.tree, pending.message);
    } else state.expectedHead = await git.confirm(pending.candidate, pending.tree, pending.message);
    state.milestones[milestone.id] = { ...state.milestones[milestone.id], status: 'committed', commit: state.expectedHead };
    state.completedCriteria = { ...state.completedCriteria, [milestone.id]: milestone.acceptanceCriteria };
    delete state.pending;
    await persist();
  }
  try {
    if (options.resume) {
      state = JSON.parse(await readFile(stateFile, 'utf8'));
      if (state.simulated) throw new Error('A simulated run cannot be resumed as a real run');
      if (hash(state.runtime) !== hash(runtime)) throw new Error('Harness revision/worktree changed since checkpoint run');
      const text = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
      if (projectHash(text) !== state.specHash) throw new Error('PROJECT.md hash changed; stale resume refused. Start develop again to recompile and replan');
      const model = JSON.parse(await readFile(path.join(dir, 'project-model.json'), 'utf8'));
      if (hash(model) !== state.modelHash) throw new Error('Project model hash mismatch');
      validateProjectModel(model, text);
      context = projectContext(text, model, state.baseCommit);
      context.criteria = state.plannedCriteria ?? context.criteria;
      if (context.specHash !== state.specHash || context.modelHash !== state.modelHash) throw new Error('PROJECT/model hash changed; resume refused');
      if (state.planFile) {
        if (!/^plan-\d+\/plan.json$/.test(state.planFile)) throw new Error('Invalid plan artifact path');
        plan = JSON.parse(await readFile(path.join(dir, state.planFile), 'utf8'));
        if (hash(plan) !== state.planHash) throw new Error('Work Plan hash mismatch');
        validatePlan(plan, context);
      }
      const completed = completedDefinitions();
      if (completed.some((m, index) => plan.milestones[index].id !== m.id)) throw new Error('Completed milestones must be a contiguous prefix');
      await git.verifyChain(state.baseCommit, completed.map(m => state.milestones[m.id].commit), state.expectedHead);
      if (state.pending) {
        if (options.replan) throw new Error('Resolve pending verified commit with --resume before replan');
        const milestone = plan.milestones.find(m => m.id === state.currentMilestone);
        if (!milestone || state.pending.candidate.head !== state.expectedHead) throw new Error('Invalid pending checkpoint');
        await finishCommit(milestone, state.pending);
      } else {
        await assertHead(root, runner, state.expectedHead);
        assertCandidate(state.worktree, await candidateFingerprint(root, runner));
      }
      if (state.status === 'complete') {
        if (options.replan) throw new Error('Run already complete; start a new PROJECT.md run');
        return state;
      }
    } else {
      const changes = await workingChanges(root, runner);
      if (changes.some(file => file !== 'spec/PROJECT.md')) throw new Error(`PROJECT development requires only PROJECT.md to be uncommitted: ${changes.join(', ')}`);
      const baseCommit = await git.head();
      state = { version: 1, runId: path.basename(dir), baseCommit,
        expectedHead: baseCommit, specHash: null, modelHash: null, runtime, planHash: null, planRevision: 0,
        status: 'planning', currentMilestone: null, milestones: {}, simulated: !!options.dryRun };
      await persist();
      const previous = await priorModel();
      await compileModel(previous);
      state.projectId = context.projectId;
      state.plannedCriteria = context.criteria;
      await persist();
      if (!options.dryRun) await atomicJson(path.join(root, '.harness-artifacts/checkpoints/latest.json'), { runId: state.runId });
    }
    writableState = true;
    checkInterrupted();
    if (options.replan) {
      if (completedDefinitions().length === plan?.milestones.length) throw new Error('No remaining milestones; update PROJECT.md for corrective work');
    }
    if (!plan || options.replan || state.replanning) await acceptPlan(plan);
    if (options.stopAfter && !plan.milestones.some(m => m.id === options.stopAfter)) throw new Error('Unknown --stop-after milestone');
    if (options.planOnly) {
      state.status = 'planned'; await persist(); return state;
    }
    for (const milestone of plan.milestones) {
      if (state.milestones[milestone.id]?.status === 'committed') {
        if (options.stopAfter === milestone.id) { state.status = 'stopped'; await persist(); return state; }
        continue;
      }
      checkInterrupted();
      await assertHead(root, runner, state.expectedHead);
      const previousAttempt = state.milestones[milestone.id];
      const repair = previousAttempt ? { stage: state.failureStage ?? 'milestone', summary: (previousAttempt.result?.error ?? state.error ?? 'Interrupted attempt').slice(0, 1200), evidence: previousAttempt.evidence } : undefined;
      const attempt = (previousAttempt?.attempt ?? 0) + 1;
      const destination = path.join(dir, milestone.id, `attempt-${attempt}`);
      state.currentMilestone = milestone.id;
      state.status = 'running';
      state.milestones[milestone.id] = { status: 'implementing', attempt, baseCommit: state.expectedHead, evidence: destination };
      await persist();
      const completed = completedDefinitions().flatMap(m => m.acceptanceCriteria);
      const criteria = context.allCriteria.filter(ac => !context.criteria.includes(ac) || completed.includes(ac) || milestone.acceptanceCriteria.includes(ac));
      const result = options.dryRun
        ? await developWorkflow(dryRunActions(value => atomicJson(path.join(destination, 'summary.json'), { ...value, simulated: true })), config.budgets)
        : await execute(destination, { checkpoint: true, milestone, context: milestoneContext(context, milestone), criteria,
          model: context.model, projectModelFile: path.join(dir, 'project-model.json'), repair,
          interrupted: options.interrupted,
          onRecord: async progress => { state.failureStage = progress.events.at(-1); state.milestones[milestone.id].progress = progress; await persist(); } });
      await atomicJson(path.join(destination, 'verification-result.json'), result);
      state.milestones[milestone.id].result = { status: result.status, error: result.error };
      if (result.status !== 'pass') throw new Error(result.error ?? result.cleanupError ?? result.integrityError ?? 'Milestone verification failed');
      checkInterrupted();
      if (options.dryRun) {
        state.milestones[milestone.id].status = 'simulated-commit';
        await persist();
      } else {
        if (!result.candidate) throw new Error('Missing verified candidate fingerprint');
        await assertHead(root, runner, state.expectedHead);
        state.failureStage = 'commit-gate';
        const tree = await git.stage(result.candidate, true);
        const message = `${milestone.commitMessage}\n\nHarness-Run: ${state.runId}\nHarness-Milestone: ${milestone.id}\nAcceptance-Criteria: ${milestone.acceptanceCriteria.join(', ')}\nHarness-Verification: passed`;
        state.pending = { candidate: result.candidate, tree, message };
        state.milestones[milestone.id].status = 'committing';
        await persist(); // Commit intent is durable before Git can advance HEAD.
        await finishCommit(milestone, state.pending);
      }
      if (options.stopAfter === milestone.id) { state.status = 'stopped'; await persist(); return state; }
    }
    checkInterrupted();
    state.status = 'final-regression'; state.currentMilestone = null; state.failureStage = 'final-regression';
    state.regressionAttempt = (state.regressionAttempt ?? 0) + 1;
    await persist();
    const destination = path.join(dir, `final-regression-${state.regressionAttempt}`);
    const result = options.dryRun ? { status: 'pass', simulated: true }
      : await execute(destination, { checkpoint: true, regression: true, criteria: context.allCriteria, model: context.model,
        projectModelFile: path.join(dir, 'project-model.json'), interrupted: options.interrupted,
        onRecord: async progress => { state.regression = progress; await persist(); } });
    await atomicJson(path.join(destination, 'verification-result.json'), result);
    state.regression = { status: result.status, error: result.error, evidence: destination };
    if (result.status !== 'pass') throw new Error(`Final regression failed: ${result.error ?? result.cleanupError ?? result.integrityError ?? 'verification failed'}`);
    checkInterrupted();
    await assertHead(root, runner, state.expectedHead);
    if (!options.dryRun) { assertCandidate(result.candidate, await candidateFingerprint(root, runner, { requireJar: true })); await git.clean(); }
    state.status = 'complete'; delete state.failureStage; delete state.error;
    await persist();
    return state;
  } catch (error) {
    // A failed resume check must not bless the unexpected worktree as a new baseline.
    const failure = { status: error.code === 'NEEDS_PROJECT_CLARIFICATION' ? 'NEEDS_PROJECT_CLARIFICATION' : 'failed', error: error.message,
      ...(error.questions ? { questions: error.questions } : {}),
      completedMilestones: plan?.milestones.filter(m => state?.milestones[m.id]?.status === 'committed').map(m => ({ id: m.id, commit: state.milestones[m.id].commit })) ?? [],
      currentMilestone: state?.currentMilestone, failureStage: state?.failureStage ?? 'plan/resume', evidence: dir,
      recommendedAction: 'Inspect evidence and uncommitted diff. Resume only the exact saved state. For final regression source fixes, start a new explicit fix task from the existing checkpoint; never reset completed commits.' };
    const failureId = `failure-${Date.now()}`;
    try {
      await save(path.join(dir, `${failureId}.patch`), await git.diff(state?.expectedHead ?? 'HEAD'));
      const untracked = await runner('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root });
      if (!untracked.ok) throw new Error('Cannot list untracked files');
      failure.untrackedFiles = untracked.stdout.split('\0').filter(file => file && !file.startsWith('.harness-artifacts/'));
      failure.diff = `${failureId}.patch`;
    }
    catch (diffError) { failure.diffError = diffError.message; }
    if (state && writableState) {
      state.status = failure.status; state.error = error.message;
      // HEAD/spec/harness baselines stay immutable, even when a stage violated policy.
      try { await persist(); }
      catch (persistenceError) {
        failure.statePersistenceError = persistenceError.message;
        // Keep the previous safe worktree baseline when a fresh fingerprint cannot be taken.
        await atomicJson(stateFile, state);
      }
    }
    await atomicJson(path.join(dir, `${failureId}.json`), failure);
    return { ...failure, simulated: !!options.dryRun };
  }
}
