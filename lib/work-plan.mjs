import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseSpec } from './validate.mjs';
import { coverageRows } from './coverage.mjs';
import { walk } from './repository.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const section = (text, name) => text.match(new RegExp(`^## ${name}\\s*\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'mi'))?.[1].trim() ?? '';

export async function taskContext(root, taskFile) {
  if (!/^spec\/tasks\/[\w.-]+\.md$/.test(taskFile)) throw new Error('Task must be a Markdown file directly inside spec/tasks/');
  const files = {};
  for (const file of await walk(path.join(root, 'spec'))) files[file] = hash(await readFile(path.join(root, 'spec', file)));
  const specText = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
  const spec = parseSpec(specText);
  const taskText = await readFile(path.join(root, taskFile), 'utf8');
  for (const name of ['Goal', 'Included Acceptance Criteria', 'Constraints', 'Non-goals']) {
    if (!section(taskText, name)) throw new Error(`Task section missing or empty: ${name}`);
  }
  const taskId = path.basename(taskFile, '.md');
  const criteria = [...section(taskText, 'Included Acceptance Criteria').matchAll(/^- (AC-[A-Za-z0-9-]+)\s*$/gm)].map(match => match[1]);
  if (!criteria.length || new Set(criteria).size !== criteria.length || criteria.some(id => !spec.criteria.includes(id))) throw new Error('Task must include unique existing PROJECT Acceptance Criteria as - AC-ID lines');
  const rows = coverageRows(specText);
  if (spec.criteria.some(id => !rows.some(row => row.ac === id)) || rows.some(row => !spec.criteria.includes(row.ac))) throw new Error('PROJECT Verification must cover every AC and contain no unknown AC');
  if (rows.some(row => !['static', 'unit', 'gametest', 'e2e', 'visual', 'persistence', 'multiplayer'].includes(row.method))) throw new Error('Unsupported Verification method');
  return { taskFile, taskId, taskText, taskHash: hash(taskText), specText, specHash: hash(files), criteria, allCriteria: spec.criteria, rows };
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
  keys(plan, ['version', 'taskId', 'baseCommit', 'specHash', 'taskHash', 'milestones'], 'plan');
  if (plan.version !== 1 || plan.taskId !== context.taskId || plan.baseCommit !== context.baseCommit || plan.specHash !== context.specHash || plan.taskHash !== context.taskHash) throw new Error('Plan identity/base/spec/task mismatch');
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
  return { version: 1, taskId: context.taskId, baseCommit: context.baseCommit, specHash: context.specHash, taskHash: context.taskHash,
    milestones: [{ id: 'M01', title: context.taskId, goal: section(context.taskText, 'Goal'), acceptanceCriteria: context.criteria,
      dependsOn: [], excludedScope: [section(context.taskText, 'Non-goals')],
      verification: { unit: evidence(['unit']), gameTest: evidence(['gametest']), e2e: evidence(['e2e', 'multiplayer', 'persistence']), visual: evidence(['visual']), fullRegression: false },
      commitMessage: `feat: complete ${context.taskId}` }] };
}

export function milestoneContext(context, milestone) {
  const criteria = section(context.specText, 'Acceptance criteria').split(/\n(?=- AC-)/).filter(text => milestone.acceptanceCriteria.some(id => text.startsWith(`- ${id}:`))).join('\n');
  return { id: milestone.id, goal: milestone.goal, acceptanceCriteria: milestone.acceptanceCriteria, excludedScope: milestone.excludedScope,
    relevantSpec: `${criteria}\n\nCompatibility:\n${section(context.specText, 'Compatibility')}\n\nProject non-goals:\n${section(context.specText, 'Non-goals')}`,
    constraints: section(context.taskText, 'Constraints'), nonGoals: section(context.taskText, 'Non-goals') };
}
