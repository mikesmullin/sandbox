/**
 * Minimal glob → RegExp (no rg/fd). `*` / `?` do not cross `/`; `**` does.
 */

function escapeRegex(s) {
  return s.replace(/[.+^${}()|\\]/g, '\\$&');
}

export function globToRegExp(glob, { trailingStarDir = false } = {}) {
  const s = String(glob || '').replace(/\\/g, '/');
  let i = 0;
  let out = '^';
  while (i < s.length) {
    const c = s[i];
    if (c === '*' && s[i + 1] === '*') {
      if (s[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
      continue;
    }
    if (c === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c === '[') {
      const end = s.indexOf(']', i + 1);
      if (end < 0) {
        out += '\\[';
        i += 1;
        continue;
      }
      out += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '/') {
      out += '/';
      i += 1;
      continue;
    }
    out += escapeRegex(c);
    i += 1;
  }
  if (trailingStarDir) out += '(?:/.*)?';
  out += '$';
  return new RegExp(out);
}

/**
 * Match a glob against a posix relative path.
 * Patterns without `/` match the basename (and also `** /pattern` against the full path).
 */
export function globMatch(glob, posixPath) {
  const g = String(glob || '').replace(/\\/g, '/');
  const p = String(posixPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!g) return false;
  if (g.includes('/')) {
    let effective = g;
    if (!g.startsWith('/') && !g.startsWith('**/') && g !== '**' && !g.startsWith('./')) {
      // path-containing patterns match anywhere under the search root
      if (!g.startsWith('**/')) effective = `**/${g.replace(/^\.\//, '')}`;
    }
    return globToRegExp(effective.replace(/^\.\//, '')).test(p);
  }
  const base = p.split('/').pop() || '';
  return globToRegExp(g).test(base);
}
