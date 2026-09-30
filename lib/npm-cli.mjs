// npm changes cwd to its package directory. Preserve the original CLI invocation
// context for the existing npm scripts, including on Windows (no shell expansion).
if (!process.argv.slice(2).some(arg => arg === '--project' || arg.startsWith('--project='))) {
  process.argv.push('--project', process.env.INIT_CWD || process.cwd());
}
await import('../cli.mjs');
