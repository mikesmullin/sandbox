/**
 * .gitignore matching + git-aware walk (hidden files included, nested .git stops
 * parent ignore rules). No `rg` / `fd`.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { globToRegExp, globMatch } from './glob.mjs';
import { toPosix, relPosix } from './paths.mjs';

export function parseGitignore(text) {
  const rules = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw;
    if (!line.trim()) continue;
    if (line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    // unescaped trailing spaces are ignored
    line = line.replace(/\\ /g, '\u0000').replace(/ +$/, '').replace(/\u0000/g, ' ');
    if (!line) continue;
    let dirOnly = false;
    if (line.endsWith('/') && !line.endsWith('\\/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    rules.push({ pattern: line, negated, dirOnly });
  }
  return rules;
}

function matchGitignorePattern(pattern, relPath, isDir) {
  const path = String(relPath || '').replace(/^\.\//, '');
  if (!path) return false;
  let pat = String(pattern || '').replace(/\\/g, '/');
  if (!pat) return false;

  const anchored = pat.startsWith('/') || pat.slice(1, -1).includes('/') || (pat.includes('/') && !pat.startsWith('**/'));
  if (pat.startsWith('/')) pat = pat.slice(1);

  const re = globToRegExp(pat);
  if (anchored) {
    if (re.test(path)) return true;
    // directory pattern `foo` also ignores `foo/bar` when we didn't skip the dir
    if (isDir && globToRegExp(pat, { trailingStarDir: false }).test(path)) return true;
    return false;
  }
  // unanchored: match any path segment / basename (and full path for *.ext)
  const parts = path.split('/');
  if (re.test(parts[parts.length - 1])) return true;
  // `build` should match directory `build` at any depth
  for (let i = 0; i < parts.length; i++) {
    if (re.test(parts[i])) return true;
  }
  return false;
}

/**
 * Last matching rule wins. `relFromBase` is posix relative to the gitignore file's directory.
 */
export function isIgnoredByRules(relFromBase, isDir, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (matchGitignorePattern(rule.pattern, relFromBase, isDir)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

async function loadGitignore(dirAbs) {
  try {
    const text = await readFile(join(dirAbs, '.gitignore'), 'utf8');
    return parseGitignore(text);
  } catch {
    return [];
  }
}

function hasGitDir(dirAbs) {
  return existsSync(join(dirAbs, '.git'));
}

/**
 * Walk up from `startAbs` (inclusive) looking for `.git`. Stop at `stopAbs` parent.
 * @returns {string|null} git root absolute path
 */
export function findGitRoot(startAbs, stopAbs) {
  let cur = startAbs;
  const stop = stopAbs || cur;
  while (true) {
    if (hasGitDir(cur)) return cur;
    if (cur === stop) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    // don't walk above stop
    const rel = relPosix(stop, parent);
    if (rel.startsWith('..')) break;
    cur = parent;
  }
  if (hasGitDir(stop)) return stop;
  return null;
}

/**
 * Ignore stack entry: rules apply to paths relative to `baseAbs`.
 * @typedef {{ baseAbs: string, rules: ReturnType<typeof parseGitignore> }} IgnoreLayer
 */

function isIgnoredStacked(absPath, isDir, layers) {
  for (const layer of layers) {
    const rel = toPosix(relPosix(layer.baseAbs, absPath));
    if (!rel || rel.startsWith('..')) continue;
    if (isIgnoredByRules(rel, isDir, layer.rules)) return true;
  }
  return false;
}

async function ancestorLayers(searchAbs, jailAbs) {
  const gitRoot = findGitRoot(searchAbs, jailAbs);
  const top = gitRoot || jailAbs || searchAbs;
  const dirs = [];
  let cur = searchAbs;
  while (true) {
    dirs.push(cur);
    if (cur === top) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    const rel = relPosix(top, parent);
    if (rel.startsWith('..')) break;
    cur = parent;
  }
  dirs.reverse();
  const layers = [];
  for (const d of dirs) {
    const rules = await loadGitignore(d);
    if (rules.length) layers.push({ baseAbs: d, rules });
  }
  return { gitRoot, layers };
}

/**
 * Walk files under `searchAbs` (must already be jail-resolved).
 * Includes hidden files; skips `.git` directories; honors `.gitignore`.
 * Nested `.git` resets parent ignore rules (git-aware search).
 *
 * @param {string} searchAbs
 * @param {string|null} jailAbs
 * @param {{
 *   onFile?: (abs: string, rel: string) => (void|boolean|Promise<void|boolean>),
 *   shouldStop?: () => boolean,
 * }} [opts]
 *   onFile rel is posix relative to searchAbs. Return false to stop.
 */
export async function walkFiles(searchAbs, jailAbs, opts = {}) {
  const { onFile, shouldStop } = opts;
  const { layers: rootLayers } = await ancestorLayers(searchAbs, jailAbs || searchAbs);

  async function walkDir(dirAbs, layers) {
    if (shouldStop?.()) return;
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }

    // Nested git repo: reset ignore stack to this repo's gitignore only.
    let localLayers = layers;
    if (dirAbs !== searchAbs && hasGitDir(dirAbs)) {
      const rules = await loadGitignore(dirAbs);
      localLayers = rules.length ? [{ baseAbs: dirAbs, rules }] : [];
    } else {
      const rules = await loadGitignore(dirAbs);
      if (rules.length) localLayers = [...layers, { baseAbs: dirAbs, rules }];
    }

    for (const ent of entries) {
      if (shouldStop?.()) return;
      if (ent.name === '.git') continue;
      const abs = join(dirAbs, ent.name);
      const isSym = ent.isSymbolicLink();
      let isDir = ent.isDirectory();
      if (isSym) {
        // don't follow dir symlinks (rg default)
        try {
          const s = await stat(abs);
          if (s.isDirectory()) continue;
          isDir = false;
        } catch {
          continue;
        }
      }
      if (isIgnoredStacked(abs, isDir, localLayers)) continue;
      if (isDir) {
        await walkDir(abs, localLayers);
        continue;
      }
      const rel = toPosix(relPosix(searchAbs, abs)) || basename(abs);
      const keep = await onFile?.(abs, rel);
      if (keep === false) return;
    }
  }

  const st = await stat(searchAbs);
  if (st.isFile()) {
    const rel = basename(searchAbs);
    await onFile?.(searchAbs, rel);
    return;
  }
  if (!st.isDirectory()) return;
  await walkDir(searchAbs, rootLayers);
}

export { globMatch };
