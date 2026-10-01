import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseSpec } from './validate.mjs';

export const projectHash = text => createHash('sha256').update(text).digest('hex');

function sections(text) {
  const result = new Map();
  let name = 'Project', body = '';
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      result.set(name, (result.get(name) ?? '') + body);
      name = heading[2].trim(); body = '';
    } else body += line + '\n';
  }
  result.set(name, (result.get(name) ?? '') + body);
  return result;
}

function source(value, sectionMap) {
  if (!value || typeof value.section !== 'string' || typeof value.quote !== 'string' || !value.quote.trim() ||
      !sectionMap.get(value.section)?.includes(value.quote)) throw new Error('Derived item lacks an exact PROJECT.md source quote');
}

function unique(items, prefix, all, sectionMap) {
  if (!Array.isArray(items) || items.length > 300) throw new Error(`Invalid ${prefix} collection`);
  for (const item of items) {
    if (!item || typeof item !== 'object' || !new RegExp(`^${prefix}-\\d{3,}$`).test(item.id) || all.has(item.id)) throw new Error(`Duplicate or invalid ${prefix} ID`);
    all.add(item.id); source(item.source, sectionMap);
  }
}

export function validateProjectModel(model, text, previous) {
  const spec = parseSpec(text);
  if (!model || model.version !== 1 || model.projectSourceHash !== projectHash(text)) throw new Error('Project model has a stale PROJECT.md hash');
  const headings = sections(text), ids = new Set();
  if (!Array.isArray(model.openQuestions)) throw new Error('Invalid open questions');
  for (const question of model.openQuestions) { if (!question.question?.trim() || !question.why?.trim() || !question.projectEdit?.trim() || !question.alternatives?.length) throw new Error('Invalid open question'); source(question.source, headings); }
  if (model.openQuestions.length) throw Object.assign(new Error(`NEEDS_PROJECT_CLARIFICATION: ${model.openQuestions.map(q => `${q.source.section}: ${q.question} Why: ${q.why} Alternatives: ${q.alternatives.join(' / ')} Add to PROJECT.md: ${q.projectEdit}`).join('; ')}`), { code: 'NEEDS_PROJECT_CLARIFICATION', questions: model.openQuestions });
  for (const [key, prefix] of [['features', 'FEAT'], ['requirements', 'REQ'], ['acceptanceCriteria', 'AC']]) unique(model[key], prefix, ids, headings);
  if (!model.features.length || !model.requirements.length || !model.acceptanceCriteria.length) throw new Error('Project model needs features, requirements, and ACs');
  const features = new Set(model.features.map(item => item.id)), requirements = new Set(model.requirements.map(item => item.id));
  for (const feature of model.features) if (!feature.title?.trim() || !feature.purpose?.trim()) throw new Error('Feature title/purpose is required');
  for (const item of [...model.features, ...model.requirements, ...model.acceptanceCriteria]) {
    if (/^(Non-goals|非対象|対象外)$/i.test(item.source.section)) throw new Error(`Non-goal cannot become a requirement: ${item.id}`);
  }
  for (const requirement of model.requirements) {
    if (!requirement.text?.trim() || (requirement.featureId !== 'global' && !features.has(requirement.featureId))) throw new Error('Requirement has no feature or global scope');
  }
  const methods = new Set(['static', 'unit', 'gametest', 'e2e', 'visual', 'persistence', 'multiplayer']);
  for (const criterion of model.acceptanceCriteria) {
    if (!requirements.has(criterion.requirementId) || !criterion.text?.trim() || !Array.isArray(criterion.verification) || !criterion.verification.length) throw new Error('AC lacks requirement, text, or verification');
    for (const row of criterion.verification) if (!methods.has(row.method) || typeof row.evidence !== 'string' || !row.evidence.trim()) throw new Error('Invalid generated verification assignment');
  }
  for (const key of ['constraints', 'nonGoals', 'visualRequirements', 'persistenceRequirements', 'multiplayerRequirements']) {
    if (!Array.isArray(model[key])) throw new Error(`Invalid ${key}`);
    for (const item of model[key]) { if (!item.text?.trim()) throw new Error(`Empty ${key} entry`); source(item.source, headings); }
  }
  if (!Array.isArray(model.references)) throw new Error('Invalid references');
  for (const item of model.references) if (!item.summary?.trim() || !item.location?.trim() || !text.includes(item.location) || !Array.isArray(item.featureIds) || item.featureIds.some(id => !features.has(id))) throw new Error('Reference metadata must point to a PROJECT.md reference');
  if (!Array.isArray(model.dependencies) || !Array.isArray(model.retiredIds)) throw new Error('Invalid project model relationships');
  const edges = new Map([...features].map(id => [id, []]));
  for (const edge of model.dependencies) {
    if (!features.has(edge.from) || !features.has(edge.to) || edge.from === edge.to) throw new Error('Invalid feature dependency');
    edges.get(edge.from).push(edge.to);
  }
  const visited = new Set(), active = new Set();
  function visit(id) { if (active.has(id)) throw new Error('Cyclic feature dependencies'); if (visited.has(id)) return; active.add(id); for (const next of edges.get(id)) visit(next); active.delete(id); visited.add(id); }
  for (const id of features) visit(id);
  if (previous) {
    const old = new Map([...previous.features, ...previous.requirements, ...previous.acceptanceCriteria].map(item => [item.id, item]));
    for (const prefix of ['FEAT', 'REQ', 'AC']) {
      const maximum = Math.max(0, ...[...old.keys(), ...previous.retiredIds].filter(id => id.startsWith(prefix + '-')).map(id => Number(id.split('-')[1])));
      for (const id of [...ids].filter(id => id.startsWith(prefix + '-') && !old.has(id))) if (Number(id.split('-')[1]) <= maximum) throw new Error(`New ${prefix} ID must exceed previous maximum: ${id}`);
    }
    for (const item of [...model.features, ...model.requirements, ...model.acceptanceCriteria]) {
      const prior = old.get(item.id);
      if (prior && prior.source.section !== item.source.section && (prior.text ?? prior.title) !== (item.text ?? item.title)) throw new Error(`Reused ID with unrelated source: ${item.id}`);
    }
    const removed = [...old.keys()].filter(id => !ids.has(id));
    if ([...removed, ...previous.retiredIds].some(id => !model.retiredIds.includes(id)) || model.retiredIds.some(id => ids.has(id))) throw new Error('Removed IDs must be retired and cannot be reassigned');
    for (const prior of old.values()) {
      const collection = prior.id.startsWith('FEAT-') ? model.features : prior.id.startsWith('REQ-') ? model.requirements : model.acceptanceCriteria;
      const same = collection.filter(item => item.source.section === prior.source.section && item.source.quote === prior.source.quote);
      if (same.length && !same.some(item => item.id === prior.id)) throw new Error(`Unchanged source must preserve ID: ${prior.id}`);
    }
  }
  if (spec.modId && model.modId !== spec.modId) throw new Error('Project model Mod ID differs from PROJECT.md');
  return model;
}

export function modelRows(model) { return model.acceptanceCriteria.flatMap(item => item.verification.map(row => ({ ac: item.id, ...row }))); }

export function simulatedProjectModel(text) {
  const spec = parseSpec(text);
  const sectionMap = sections(text);
  const section = [...sectionMap.keys()].find(name => /^(Features|Requirements|Functional requirements|要件|要求|機能)$/i.test(name));
  const quote = sectionMap.get(section)?.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
  if (!quote) throw new Error('PROJECT.md has no requirement to simulate');
  const source = { section, quote };
  return { version: 1, projectSourceHash: projectHash(text), modId: spec.modId,
    features: [{ id: 'FEAT-001', title: 'Simulated project capability', purpose: quote, source }],
    requirements: [{ id: 'REQ-001', featureId: 'FEAT-001', text: quote, source }],
    acceptanceCriteria: [{ id: 'AC-001', requirementId: 'REQ-001', text: quote, source, verification: [{ method: 'e2e', evidence: 'dry-run' }] }],
    constraints: [], nonGoals: [], visualRequirements: [], persistenceRequirements: [], multiplayerRequirements: [], references: [], dependencies: [], openQuestions: [], retiredIds: [] };
}

export async function readProjectModel(file, root) {
  if (!file) return undefined;
  const resolved = await realpath(file);
  const artifacts = await realpath(path.join(root, '.harness-artifacts/checkpoints'));
  if (!resolved.startsWith(artifacts + path.sep)) throw new Error('Project model path must be a checkpoint artifact');
  const model = JSON.parse(await readFile(resolved, 'utf8'));
  const text = await readFile(path.join(root, 'spec/PROJECT.md'), 'utf8');
  validateProjectModel(model, text);
  return model;
}
