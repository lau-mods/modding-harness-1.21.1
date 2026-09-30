import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requiredFiles } from '../lib/validate.mjs';
import { run, requireSuccess } from '../lib/process.mjs';

export const properties = 'minecraft_version=1.21.1\nneo_version=21.1.252\nmod_id=test_input\nmod_version=1\n';
export async function projectFixture(root) {
  for (const file of requiredFiles) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'fixture\n');
  }
  await writeFile(path.join(root, 'spec/PROJECT.md'), 'Status: draft\n');
  await writeFile(path.join(root, 'gradle.properties'), properties);
  await writeFile(path.join(root, '.gitignore'), '.harness-artifacts/\n');
  requireSuccess(await run('git', ['init', root]), 'fixture git init');
}
