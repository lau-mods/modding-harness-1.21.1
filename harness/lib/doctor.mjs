import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { requiredFiles } from './validate.mjs';
import { subscriptionEnv, gradleCommand } from './process.mjs';
import { claudeAuth } from './agents.mjs';
import { discover, runtimeVersions } from './mc-pilot.mjs';

export async function doctor(root, runner) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('Node.js >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.version);
  const java = await runner(process.env.HARNESS_JAVA || 'java', ['-version'], { cwd: root });
  add('Java 21', java.ok && /version "21\./.test(java.stdout + java.stderr), (java.stderr || java.stdout).split('\n')[0]);
  const git = await runner('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  add('Git repository', git.ok && path.resolve(git.stdout.trim()) === path.resolve(root), git.ok ? git.stdout.trim() : git.failure);
  for (const file of requiredFiles) {
    try { await access(path.join(root, file)); } catch { add(file, false, 'missing'); }
  }
  add('Required repository files', !checks.some(check => requiredFiles.includes(check.name)), 'See missing file entries');
  const wrapper = gradleCommand(root, ['--version']);
  const gradle = await runner(wrapper.command, wrapper.args, { cwd: root, timeoutMs: 120_000 });
  add('Gradle wrapper', gradle.ok, gradle.stdout.match(/Gradle [\d.]+/)?.[0] ?? gradle.failure ?? 'wrapper unavailable');
  const codex = await runner('codex', ['--version'], { cwd: root });
  add('Codex CLI', codex.ok, codex.stdout.trim() || codex.failure);
  const codexHelp = await runner('codex', ['exec', '--help'], { cwd: root });
  const codexGlobalHelp = await runner('codex', ['--help'], { cwd: root });
  add('Codex isolated configuration', codexGlobalHelp.stdout.includes('--no-daemon') && ['--ignore-user-config', '--ignore-rules', '--strict-config'].every(flag => codexHelp.stdout.includes(flag)), 'no-daemon and named filesystem permissions required; unsupported profiles fail closed');
  const login = await runner('codex', ['login', 'status'], { cwd: root, env: subscriptionEnv() });
  add('Codex subscription authentication', login.ok && /ChatGPT/i.test(login.stdout + login.stderr), login.ok ? 'ChatGPT subscription required' : 'Run codex login');
  const claude = await runner('claude', ['--version'], { cwd: root });
  add('Claude Code CLI', claude.ok, claude.stdout.trim() || claude.failure);
  const auth = await claudeAuth(root, runner);
  add('Claude subscription authentication', auth.ok, auth.ok ? `${auth.method} (${auth.subscription ?? 'subscription'})` : 'Run claude auth login; sandbox/keychain restrictions can also hide an existing login');
  const help = await runner('claude', ['--help'], { cwd: root });
  add('Claude read-only structured interface', ['--safe-mode', '--restricted', '--permission-prompts', '--json-schema', '--tools'].every(flag => help.stdout.includes(flag)), 'safe-mode, restricted snapshot reads, tool restriction, dontAsk, no prompts, JSON schema required');
  try {
    const pilot = await discover(root, runner);
    const loader = pilot.clients.results.find(version => version.version === '1.21.1').loaders.find(item => item.loader === 'neoforge');
    add('MC Pilot CLI / NeoForge 1.21.1', true, `loader ${loader.loaderVersion}; server install is external (no NeoForge server create)`);
    const props = await readFile(path.join(root, 'gradle.properties'), 'utf8');
    const neo = props.match(/^neo_version=(.+)$/m)[1].trim();
    add('MC Pilot stock loader / exact target', true, `stock=${loader.loaderVersion}, MDK=${neo}; setup-runtime installs the exact target without booting stock`);
  } catch (error) { add('MC Pilot', false, error.message); }
  try {
    await access(path.join(root, '.harness-artifacts/e2e-runtime.json'));
    const versions = await runtimeVersions(root);
    const eula = await readFile(path.join(root, '.harness-artifacts/server/eula.txt'), 'utf8');
    add('E2E runtime configuration', /^eula=true\s*$/m.test(eula), `${versions.minecraft} / ${versions.neoForge}; EULA must be accepted; full preflight runs before boot`);
  } catch (error) { add('E2E runtime configuration', false, `Run setup-runtime: ${error.message}`); }
  return { ok: checks.every(check => check.ok), checks };
}
