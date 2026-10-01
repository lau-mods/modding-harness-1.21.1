import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseSpec } from './validate.mjs';
import { loadScenarios } from './mc-pilot.mjs';
import { save } from './repository.mjs';

export function selectScenarios(scenarios, rows, changed, { fullRegression = false, runtimeChanged = false, verification, criteria } = {}) {
  const required = new Set(rows.filter(row => ['e2e', 'visual', 'multiplayer', 'persistence'].includes(row.method)).map(row => row.evidence.split('/')[0]));
  for (const id of [...(verification?.e2e ?? []), ...(verification?.visual ?? [])]) required.add(id.split('/')[0]);
  return scenarios.filter(scenario => required.has(scenario.id) || scenario.alwaysRun ||
    ((!criteria || scenario.acceptanceCriteria.every(id => criteria.includes(id))) &&
      (fullRegression || changed.includes(`tests/e2e/scenarios/${scenario.sourceFile}`) ||
       (scenario.affectedPaths ? scenario.affectedPaths.some(prefix => changed.some(file => file === prefix || file.startsWith(prefix.replace(/\/$/, '') + '/'))) : runtimeChanged))));
}

export function coverageRows(text) {
  const section = text.match(/^## Verification\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/mi)?.[1] ?? '';
  return section.split(/\r?\n/).filter(line => /^\|\s*AC-/.test(line)).map(line => {
    const columns = line.split('|').slice(1, -1).map(value => value.trim());
    if (columns.length !== 3 || columns.some(value => !value)) throw new Error('Verification rows require AC | Method | Evidence');
    return { ac: columns[0], method: columns[1], evidence: columns[2] };
  });
}

// This checks assignments before a boot. It never claims a test has executed.
export async function acceptanceCoverage(root, dir, { criteria, reviewed = true } = {}) {
  const text = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
  const spec = parseSpec(text);
  const required = criteria ?? spec.criteria;
  if (required.some(id => !spec.criteria.includes(id))) throw new Error('Coverage scope contains unknown AC');
  // Static/agent validation must never execute an unreviewed scenario module.
  const scenarios = reviewed ? await loadScenarios(root, spec.criteria) : [];
  const allRows = coverageRows(text);
  const errors = allRows.filter(row => !spec.criteria.includes(row.ac)).map(row => `Unknown criterion ${row.ac}`);
  const rows = allRows.filter(row => required.includes(row.ac));
  for (const row of rows) {
    if (!spec.criteria.includes(row.ac)) errors.push(`Unknown criterion ${row.ac}`);
    if (['e2e', 'visual', 'multiplayer', 'persistence'].includes(row.method)) {
      const [id, point, ...extra] = row.evidence.split('/');
      if (!reviewed) {
        if (!/^[a-z0-9-]+$/.test(id) || extra.length || (row.method === 'visual' ? !/^[a-z0-9-]+$/.test(point ?? '') : point !== undefined)) errors.push(`${row.ac}: invalid scenario reference ${row.evidence}`);
        continue;
      }
      const scenario = scenarios.find(value => value.id === id && value.acceptanceCriteria.includes(row.ac));
      if (!scenario || extra.length || (row.method !== 'visual' && point)) errors.push(`${row.ac}: invalid scenario reference ${row.evidence}`);
      else if (row.method === 'visual' && (!scenario.visual || !scenario.screenshots.some(shot => shot.id === point))) errors.push(`${row.ac}: visual evidence must name a screenshot point`);
      else if (row.method === 'persistence' && scenario.phase !== 'after-restart') errors.push(`${row.ac}: persistence requires an after-restart scenario`);
      else if (row.method === 'multiplayer' && (!scenario.verification?.includes('multiplayer') || (scenario.players ?? 1) < 2)) errors.push(`${row.ac}: multiplayer evidence requires at least two players and explicit multiplayer verification`);
    } else if (['unit', 'gametest', 'static'].includes(row.method)) {
      const file = row.evidence;
      if (!/^src\//.test(file) || file.includes('..') || file.includes('\\') || path.isAbsolute(file)) { errors.push(`${row.ac}: invalid evidence path`); continue; }
      try {
        const source = await readFile(path.join(root, file), 'utf8');
        if (row.method === 'unit' && (!file.startsWith('src/test/') || !/@(?:[\w.]+\.)?Test\b/.test(source))) errors.push(`${row.ac}: unit evidence must name a test source`);
        if (row.method === 'gametest' && (!file.startsWith('src/main/java/') || !/@(?:[\w.]+\.)?GameTest(?:Generator)?\b/.test(source))) errors.push(`${row.ac}: GameTest evidence must name a registered test source`);
        if (row.method === 'static' && !/^src\/(main|generated)\/resources\//.test(file)) errors.push(`${row.ac}: static evidence must name a resource validated by validate`);
      } catch (error) { errors.push(`${row.ac}: evidence cannot be read: ${file} (${error.code})`); }
    } else errors.push(`${row.ac}: unsupported verification method ${row.method}`);
  }
  const missing = required.filter(id => !rows.some(row => row.ac === id));
  errors.push(...missing.map(id => `${id}: no verification assigned`));
  const result = { status: errors.length ? 'failed' : reviewed ? 'assigned' : 'references-pending-review', required: required.length,
    assigned: required.length - missing.length, percent: errors.length ? null : 100, rows, errors, executed: false };
  await save(path.join(dir, 'acceptance-coverage.json'), result);
  if (errors.length) throw new Error(`Acceptance coverage failed before Minecraft boot:\n${errors.join('\n')}`);
  return { ...result, scenarios };
}
