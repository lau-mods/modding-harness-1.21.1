import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// No shell interprets prompts, paths, JSON, or scenario arguments.
export function executable(command, args, env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { command, args };
  if (command === 'codex') {
    for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
      const script = path.join(dir, 'node_modules/@openai/codex/bin/codex.js');
      if (existsSync(script)) return { command: process.execPath, args: [script, ...args] };
    }
  }
  if (/\.(cmd|bat)$/i.test(command)) throw new Error('Use a native executable or Node entry point, not a shell shim');
  return { command, args };
}

export function subscriptionEnv(env = process.env) {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (/^(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_)/.test(key)) delete result[key];
  }
  return result;
}

export function redact(text) {
  return String(text).replace(/\b(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+)/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}

export async function run(command, args = [], { cwd, input = '', env = process.env, timeoutMs = 120_000, maxBytes = 4_000_000, signal, onOutput, stopInput } = {}) {
  const actual = executable(command, args, env);
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(actual.command, actual.args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure = null, finished = false, stopTimer;
    function kill() {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Process already exited. */ }
      }
    }
    function stop(reason) {
      if (failure) return;
      failure = reason;
      if (stopInput && child.stdin.writable) {
        child.stdin.end(stopInput);
        stopTimer = setTimeout(kill, 10_000);
      } else kill();
    }
    const interrupt = () => stop('interrupted');
    signal?.addEventListener('abort', interrupt, { once: true });
    if (signal?.aborted) interrupt();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    function finish(code, exitSignal) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      signal?.removeEventListener('abort', interrupt);
      resolve({ ok: code === 0 && !failure, code, signal: exitSignal, failure, stdout, stderr, durationMs: Date.now() - started });
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    for (const [stream, kind] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.on('data', text => {
        onOutput?.(text);
        size += Buffer.byteLength(text);
        if (size > maxBytes) return stop('output limit');
        if (kind === 'stdout') stdout += text;
        else stderr += text;
      });
    }
    child.on('error', error => { failure = error.code ?? error.message; finish(null, null); });
    child.on('close', finish);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error.message); });
    if (stopInput) child.stdin.write(input);
    else child.stdin.end(input);
  });
}

export function requireSuccess(result, label) {
  if (!result.ok) throw new Error(`${label}: ${result.failure ?? `exit ${result.code}, signal ${result.signal}`}\n${redact((result.stderr || result.stdout).slice(-6000))}`);
  return result;
}

export function gradleCommand(root, tasks, platform = process.platform, env = process.env) {
  const args = [...tasks, ...(env.CI ? ['--no-daemon'] : []), '--console=plain'];
  if (platform === 'win32') {
    const java = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', 'java.exe') : 'java';
    return { command: java, args: ['-classpath', path.join(root, 'gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain', ...args] };
  }
  return { command: path.join(root, 'gradlew'), args };
}
