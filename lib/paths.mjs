import { fileURLToPath } from 'node:url';

// Runtime resources always belong to this checkout, independent of invocation cwd.
export const harnessRoot = fileURLToPath(new URL('../', import.meta.url));
