/**
 * Exact unique non-overlapping edits (Pi applyEditsToNormalizedContent, no fuzzy).
 */

export function detectLineEnding(content) {
  const crlfIdx = content.indexOf('\r\n');
  const lfIdx = content.indexOf('\n');
  if (lfIdx === -1) return '\n';
  if (crlfIdx === -1) return '\n';
  return crlfIdx < lfIdx ? '\r\n' : '\n';
}

export function normalizeToLF(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text, ending) {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

export function splitBom(raw) {
  if (raw && raw.charCodeAt(0) === 0xfeff) {
    return { bom: '\uFEFF', text: raw.slice(1) };
  }
  return { bom: '', text: raw };
}

function countOccurrences(content, oldText) {
  if (!oldText) return 0;
  return content.split(oldText).length - 1;
}

function applyReplacements(content, replacements) {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    result =
      result.substring(0, r.matchIndex) +
      r.newText +
      result.substring(r.matchIndex + r.matchLength);
  }
  return result;
}

function getNotFoundError(path, editIndex, totalEdits) {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}

function getDuplicateError(path, editIndex, totalEdits, occurrences) {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

function getEmptyOldTextError(path, editIndex, totalEdits) {
  if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path, totalEdits) {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply edits against LF-normalized original content (not incremental).
 * @param {string} normalizedContent
 * @param {{ oldText: string, newText: string }[]} edits
 * @param {string} path
 */
export function applyEditsToNormalizedContent(normalizedContent, edits, path) {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  const matchedEdits = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const index = normalizedContent.indexOf(edit.oldText);
    if (index === -1) throw getNotFoundError(path, i, normalizedEdits.length);
    const occurrences = countOccurrences(normalizedContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
    }
    matchedEdits.push({
      editIndex: i,
      matchIndex: index,
      matchLength: edit.oldText.length,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  const newContent = applyReplacements(normalizedContent, matchedEdits);
  if (normalizedContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }
  return { baseContent: normalizedContent, newContent };
}

function splitLines(content) {
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Display-oriented diff with line numbers (single changed span + context).
 * Good enough for the model-visible edit feedback.
 */
export function generateDiffString(oldContent, newContent, contextLines = 4) {
  const a = splitLines(oldContent);
  const b = splitLines(newContent);
  const maxLineNum = Math.max(a.length, b.length, 1);
  const width = String(maxLineNum).length;

  let startA = 0;
  let startB = 0;
  while (startA < a.length && startB < b.length && a[startA] === b[startB]) {
    startA++;
    startB++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= startA && endB >= startB && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const ctxStartA = Math.max(0, startA - contextLines);
  const ctxEndA = Math.min(a.length - 1, endA + contextLines);

  const out = [];
  const pad = (n) => String(n).padStart(width, ' ');

  for (let i = ctxStartA; i < startA; i++) {
    out.push(` ${pad(i + 1)} ${a[i]}`);
  }
  for (let i = startA; i <= endA && i < a.length && startA <= endA; i++) {
    out.push(`-${pad(i + 1)} ${a[i]}`);
  }
  for (let i = startB; i <= endB && i < b.length && startB <= endB; i++) {
    out.push(`+${pad(i + 1)} ${b[i]}`);
  }
  const afterA = Math.max(startA, endA + 1);
  for (let i = afterA; i <= ctxEndA && i < a.length; i++) {
    out.push(` ${pad(i + 1)} ${a[i]}`);
  }

  const firstChangedLine = startB < b.length ? startB + 1 : undefined;
  return { diff: out.join('\n'), firstChangedLine };
}

/** Standard unified patch (single hunk covering the changed span). */
export function generateUnifiedPatch(path, oldContent, newContent, contextLines = 4) {
  const a = splitLines(oldContent);
  const b = splitLines(newContent);
  let startA = 0;
  let startB = 0;
  while (startA < a.length && startB < b.length && a[startA] === b[startB]) {
    startA++;
    startB++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= startA && endB >= startB && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const hunkStartA = Math.max(0, startA - contextLines);
  const hunkEndA = Math.min(a.length - 1, endA + contextLines);
  const hunkStartB = Math.max(0, startB - contextLines);
  const hunkEndB = Math.min(b.length - 1, endB + contextLines);
  const oldCount = a.length === 0 ? 0 : hunkEndA - hunkStartA + 1;
  const newCount = b.length === 0 ? 0 : hunkEndB - hunkStartB + 1;

  const lines = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${hunkStartA + 1},${oldCount} +${hunkStartB + 1},${newCount} @@`,
  ];

  let ia = hunkStartA;
  let ib = hunkStartB;
  while (ia <= hunkEndA || ib <= hunkEndB) {
    if (ia < startA && ia <= hunkEndA) {
      lines.push(` ${a[ia]}`);
      ia++;
      ib++;
      continue;
    }
    if (ia >= startA && ia <= endA && ia < a.length) {
      lines.push(`-${a[ia]}`);
      ia++;
      continue;
    }
    if (ib >= startB && ib <= endB && ib < b.length) {
      lines.push(`+${b[ib]}`);
      ib++;
      continue;
    }
    if (ia <= hunkEndA && ia < a.length) {
      lines.push(` ${a[ia]}`);
      ia++;
      ib++;
      continue;
    }
    if (ib <= hunkEndB && ib < b.length) {
      lines.push(`+${b[ib]}`);
      ib++;
      continue;
    }
    break;
  }

  return lines.join('\n') + '\n';
}

function isSingleEdit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.oldText === 'string' && typeof value.newText === 'string';
}

/** Accept `edits[]` or legacy `{ oldText, newText }`. */
export function prepareEdits(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
  }
  const args = { ...input };
  if (typeof args.edits === 'string') {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isSingleEdit(parsed)) args.edits = [parsed];
    } catch {
      /* leave as-is */
    }
  } else if (isSingleEdit(args.edits)) {
    args.edits = [args.edits];
  }

  const edits = Array.isArray(args.edits) ? [...args.edits] : [];
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
    edits.push({ oldText: args.oldText, newText: args.newText });
  }
  if (!edits.length) {
    throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
  }
  for (const e of edits) {
    if (!isSingleEdit(e)) {
      throw new Error('Edit tool input is invalid. each edit needs oldText and newText.');
    }
  }
  return { path: args.path, edits };
}
