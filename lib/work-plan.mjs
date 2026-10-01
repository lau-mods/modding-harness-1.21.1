import { createHash } from 'node:crypto';
import { modelRows, projectHash } from './project-model.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function projectContext(specText, model, baseCommit) {
  const criteria = model.acceptanceCriteria.map(item => item.id);
  return { projectId: model.modId, modelHash: hash(model), specText, specHash: projectHash(specText),
    criteria, allCriteria: criteria, rows: modelRows(model), model, baseCommit };
}

function keys(value, expected, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label} fields`);
}
function string(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || /[\u0000-\u0008]/.test(value)) throw new Error(`Invalid ${label}`);
}
function strings(value, label) {
  if (!Array.isArray(value) || value.length > 200 || new Set(value).size !== value.length) throw new Error(`Invalid ${label} array`);
  value.forEach(item => string(item, label));
}

export function validatePlan(plan, context, completed = []) {
  keys(plan, ['version', 'projectId', 'baseCommit', 'specHash', 'modelHash', 'milestones'], 'plan');
  if (plan.version !== 1 || plan.projectId !== context.projectId || plan.baseCommit !== context.baseCommit || plan.specHash !== context.specHash || plan.modelHash !== context.modelHash) throw new Error('Plan identity/base/spec/model mismatch');
  if (!Array.isArray(plan.milestones) || !plan.milestones.length || plan.milestones.length > 100) throw new Error('Plan needs 1..100 milestones');
  const ids = new Set(), assigned = new Set();
  for (const [index, milestone] of plan.milestones.entries()) {
    keys(milestone, ['id', 'title', 'goal', 'acceptanceCriteria', 'dependsOn', 'excludedScope', 'verification', 'commitMessage'], 'milestone');
    for (const key of ['id', 'title', 'goal', 'commitMessage']) string(milestone[key], key);
    if (milestone.id !== `M${String(index + 1).padStart(2, '0')}` || ids.has(milestone.id)) throw new Error('Milestone IDs must be consecutive M01, M02, ...');
    for (const key of ['acceptanceCriteria', 'dependsOn', 'excludedScope']) strings(milestone[key], key);
    if (!milestone.acceptanceCriteria.length || !milestone.excludedScope.length) throw new Error('Each milestone needs AC and explicit excludedScope');
    if (milestone.dependsOn.some(id => !ids.has(id))) throw new Error('Dependencies must refer to earlier milestones');
    for (const ac of milestone.acceptanceCriteria) {
      if (!context.criteria.includes(ac) || assigned.has(ac)) throw new Error(`Unknown/duplicate planned AC: ${ac}`);
      assigned.add(ac);
    }
    ids.add(milestone.id);
    if (/[\r\n]/.test(milestone.commitMessage) || milestone.commitMessage.length > 120) throw new Error('Commit subject must be one short line');
    keys(milestone.verification, ['unit', 'gameTest', 'e2e', 'visual', 'fullRegression'], 'verification');
    if (typeof milestone.verification.fullRegression !== 'boolean') throw new Error('fullRegression must be boolean');
    for (const name of ['unit', 'gameTest', 'e2e', 'visual']) strings(milestone.verification[name], name);
    const methodKey = { unit: 'unit', gametest: 'gameTest', e2e: 'e2e', persistence: 'e2e', multiplayer: 'e2e', visual: 'visual' };
    for (const row of context.rows.filter(row => milestone.acceptanceCriteria.includes(row.ac))) {
      const key = methodKey[row.method];
      if (key && !milestone.verification[key].includes(row.evidence)) throw new Error(`${milestone.id} omits required ${row.method}: ${row.evidence}`);
    }
    for (const [method, values] of Object.entries(milestone.verification)) {
      if (method === 'fullRegression') continue;
      if (values.some(value => !context.rows.some(row => methodKey[row.method] === method && row.evidence === value && (assigned.has(row.ac) || !context.criteria.includes(row.ac))))) throw new Error(`Unknown or future ${method} verification reference`);
    }
  }
  if (assigned.size !== context.criteria.length) throw new Error('Plan AC coverage is incomplete');
  completed.forEach((old, index) => {
    if (JSON.stringify(old) !== JSON.stringify(plan.milestones[index])) throw new Error('Completed milestones are immutable, including order');
  });
  return plan;
}

export function singleMilestonePlan(context) {
  const rows = context.rows.filter(row => context.criteria.includes(row.ac));
  const evidence = methods => [...new Set(rows.filter(row => methods.includes(row.method)).map(row => row.evidence))];
  return { version: 1, projectId: context.projectId, baseCommit: context.baseCommit, specHash: context.specHash, modelHash: context.modelHash,
    milestones: [{ id: 'M01', title: context.projectId, goal: 'Implement the accepted PROJECT.md requirements', acceptanceCriteria: context.criteria,
      dependsOn: [], excludedScope: context.model.nonGoals.map(item => item.text).length ? context.model.nonGoals.map(item => item.text) : ['No behavior outside PROJECT.md'],
      verification: { unit: evidence(['unit']), gameTest: evidence(['gametest']), e2e: evidence(['e2e', 'multiplayer', 'persistence']), visual: evidence(['visual']), fullRegression: false },
      commitMessage: `feat: complete ${context.projectId}` }] };
}

export function milestoneContext(context, milestone) {
  const selected = context.model.acceptanceCriteria.filter(item => milestone.acceptanceCriteria.includes(item.id));
  const requirementIds = new Set(selected.map(item => item.requirementId));
  const requirements = context.model.requirements.filter(item => requirementIds.has(item.id));
  const featureIds = new Set(requirements.map(item => item.featureId));
  const features = context.model.features.filter(item => featureIds.has(item.id));
  const excerpts = [...new Set([...features, ...requirements, ...selected].map(item => `${item.source.section}: ${item.source.quote}`))];
  return { id: milestone.id, goal: milestone.goal, acceptanceCriteria: selected.map(item => `${item.id}: ${item.text}`), excludedScope: milestone.excludedScope,
    relevantSpec: excerpts.join('\n\n'), constraints: context.model.constraints.map(item => item.text).join('\n'),
    nonGoals: context.model.nonGoals.map(item => item.text).join('\n'),
    references: context.model.references.filter(item => !item.featureIds.length || item.featureIds.some(id => featureIds.has(id))),
    verification: milestone.verification };
}
