// The same bounded state machine drives real runs and injected dry-run/test actions.
export async function developWorkflow(actions, budgets) {
  const state = { status: 'running', codeAttempts: 0, codeReviews: 0, boots: 0, sessions: 0, visualReviews: 0, events: [] };
  const step = async (name, fn) => {
    state.events.push(name);
    await actions.record(state);
    try { return await fn(); }
    finally { await actions.guard?.(); }
  };
  async function candidate(task) {
    while (state.codeAttempts < budgets.codeReviews) {
      state.codeAttempts++;
      await step('implementation', () => actions.implement(task));
      try { await step('static-compile-test', () => actions.verify()); }
      catch (error) {
        if (error.code === 'HARNESS_CHANGED') throw error;
        task = { task: 'Fix deterministic verification failures', failures: [error.message.slice(-8000)] };
        continue;
      }
      state.codeReviews++;
      const review = await step('code-review', () => actions.review());
      const blocked = review.findings.filter(finding => finding.category === 'protected-input' && finding.severity === 'blocker');
      if (blocked.length) throw new Error(`Harness maintenance or user decision required: ${blocked.map(finding => `${finding.file}: ${finding.required_change}`).join('; ')}`);
      if (review.verdict === 'pass') {
        try {
          await step('build', () => actions.build());
          await step('gametest', () => actions.gameTest());
          return;
        } catch (error) {
          if (error.code === 'HARNESS_CHANGED') throw error;
          task = { task: 'Fix build or GameTest failures', failures: [error.message.slice(-8000)] };
          continue;
        }
      }
      task = { task: 'Correct review findings', findings: review.findings };
    }
    throw new Error('Code review/fix budget exhausted; inspect the latest findings or test failures');
  }
  async function boot() {
    if (state.boots + state.players > budgets.gameBoots) throw Object.assign(new Error('Game boot budget exhausted; inspect runtime/visual evidence'), { code: 'BOOT_BUDGET' });
    state.boots += state.players;
    state.sessions++;
    await step('minecraft-start', () => actions.start());
  }
  try {
    await step('specification', () => actions.specification());
    await candidate({ task: 'Implement the accepted specification and relevant deterministic/E2E coverage' });
    let changes = await actions.classify();
    if (changes.e2e) {
      // Scenario/precondition validation happens before spending a boot.
      state.players = await step('e2e-preflight', () => actions.preflight());
      if (!Number.isSafeInteger(state.players) || state.players < 1) throw new Error('E2E preflight must return a positive client count');
      await boot();
      let accepted = false;
      for (let cycle = 0; cycle < budgets.visualReviews; cycle++) {
        let correction, result;
        try {
          result = await step('e2e-batch', () => actions.e2e(cycle));
          if (result.requiresRestart) {
            await step('minecraft-stop', () => actions.stop());
            await boot();
            const persisted = await step('e2e-persistence', () => actions.e2ePersistence(cycle));
            result.screenshots.push(...persisted.screenshots);
          }
        } catch (error) {
          if (['BOOT_BUDGET', 'CLEANUP_FAILED', 'HARNESS_CHANGED'].includes(error.code)) throw error;
          result = undefined;
          correction = { task: 'Correct runtime verification failures', failures: [error.message.slice(-8000)] };
        }
        if (result) {
          if (result.screenshots.length) {
            state.visualReviews++;
            const visual = await step('visual-review', () => actions.visual(result));
            if (visual.verdict === 'pass') { accepted = true; break; }
            correction = { task: 'Correct visual findings', findings: visual.findings };
          } else { accepted = true; break; }
        }
        if (cycle + 1 === budgets.visualReviews) { state.lastFailure = correction; break; }
        await actions.markCorrection();
        await candidate(correction);
        changes = await actions.classifyCorrection();
        if (changes.restart) {
          await step('minecraft-stop', () => actions.stop());
          await boot();
        } else if (changes.reload.length) {
          await step('resource-reload', () => actions.reload(changes.reload));
        }
      }
      if (!accepted) throw new Error('Runtime/visual fix budget exhausted; inspect E2E and visual evidence');
    }
    state.status = 'pass';
  } catch (error) {
    state.status = 'failed'; state.error = error.message;
  } finally {
    // Also cleans partially started sessions; adapter stops only processes it owns.
    try { await actions.stop(); state.sessionStopped = true; }
    catch (error) { state.status = 'failed'; state.sessionStopped = false; state.cleanupError = error.message; }
    try { await actions.guard?.(); }
    catch (error) { state.status = 'failed'; state.integrityError = error.message; }
    await actions.record(state);
  }
  return state;
}

export function dryRunActions(record) {
  let reviews = 0, visuals = 0;
  const pass = { verdict: 'pass', findings: [], summary: 'simulated pass' };
  const correction = { verdict: 'changes_required', findings: [{ severity: 'major', category: 'simulation', file: 'fixture', location: 'fixture', problem: 'simulated problem', required_change: 'simulated correction', reason: 'exercise transition' }], summary: 'simulated correction' };
  return {
    record, specification: async () => {}, implement: async () => {}, verify: async () => {},
    review: async () => ++reviews === 1 ? correction : pass,
    build: async () => {}, gameTest: async () => ({ status: 'not-applicable' }),
    classify: async () => ({ e2e: true }), preflight: async () => 1, start: async () => {}, stop: async () => {},
    e2e: async () => ({ screenshots: [{ file: 'simulated.png' }] }),
    visual: async () => ++visuals === 1 ? correction : pass,
    markCorrection: async () => {}, classifyCorrection: async () => ({ restart: false, reload: ['resources'] }), reload: async () => {}
  };
}
