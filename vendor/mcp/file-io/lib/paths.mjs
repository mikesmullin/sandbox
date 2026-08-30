import { resolve, relative, isAbsolute, dirname } from 'node:path';

export const ROOT = process.env.MCP_FILE_ROOT
  ? resolve(process.env.MCP_FILE_ROOT)
  : null;

export function resolveSafe(userPath) {
  const raw = String(userPath || '.').trim() || '.';
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(ROOT || process.cwd(), raw);
  if (ROOT) {
    const rel = relative(ROOT, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `That path is outside the allowed sandbox.\n` +
          `  requested: ${raw}\n` +
          `  resolved:  ${abs}\n` +
          `  sandbox:   ${ROOT}\n` +
          `Use a path under the sandbox (relative is fine, e.g. "tmp/poc-test.txt"). ` +
          `Absolute host paths like /tmp/... are not allowed unless they fall under the sandbox directory.`,
      );
    }
  }
  return abs;
}

export function toPosix(p) {
  return String(p || '').split('\\').join('/');
}

export function relPosix(from, to) {
  return toPosix(relative(from, to));
}

export { dirname, resolve, relative, isAbsolute };
