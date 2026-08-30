/**
 * Session checklist store for mcp-todo.
 *
 * Full-list replace by default; optional merge-by-id.
 * Status: pending | in_progress | completed
 */

export const STATUSES = ['pending', 'in_progress', 'completed'];

const STATUS_ALIASES = {
  pending: 'pending',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  todo: 'pending',
  done: 'completed',
};

const CONTENT_KEYS = ['content', 'description', 'step', 'subject', 'title'];
const ID_KEYS = ['id', 'taskId', 'task_id'];
const ACTIVE_FORM_KEYS = ['activeForm', 'active_form'];
const LIST_KEYS = ['todos', 'plan', 'task_list'];

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] != null && String(obj[k]).trim() !== '') return obj[k];
  }
  return undefined;
}

export function normalizeStatus(raw) {
  if (raw == null || String(raw).trim() === '') return 'pending';
  const key = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const mapped = STATUS_ALIASES[key];
  if (!mapped) {
    throw new Error(
      `invalid status "${raw}" (want pending | in_progress | completed)`,
    );
  }
  return mapped;
}

export function slugId(text, used) {
  let base = String(text || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!base) base = 'item';
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

export function cloneTodo(t) {
  const out = {
    id: t.id,
    content: t.content,
    status: t.status,
  };
  if (t.activeForm) out.activeForm = t.activeForm;
  return out;
}

/**
 * Normalize one incoming item.
 * @param {object} raw
 * @param {{ requireContent?: boolean }} [opts]
 */
export function normalizeItem(raw, opts = {}) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('each todo must be an object');
  }
  const contentRaw = pick(raw, CONTENT_KEYS);
  const content =
    contentRaw == null ? undefined : String(contentRaw).trim();
  if (opts.requireContent && !content) {
    throw new Error('each todo needs content (or description / step / subject / title)');
  }
  const idRaw = pick(raw, ID_KEYS);
  const id = idRaw == null ? undefined : String(idRaw).trim();
  const activeRaw = pick(raw, ACTIVE_FORM_KEYS);
  const item = {
    id: id || undefined,
    content: content || undefined,
    status: Object.prototype.hasOwnProperty.call(raw, 'status')
      ? normalizeStatus(raw.status)
      : undefined,
    activeForm:
      activeRaw == null ? undefined : String(activeRaw).trim() || undefined,
  };
  return item;
}

export function extractList(args) {
  if (!args || typeof args !== 'object') return undefined;
  for (const k of LIST_KEYS) {
    if (Array.isArray(args[k])) return args[k];
  }
  return undefined;
}

export function formatTodos(todos) {
  const list = Array.isArray(todos) ? todos : [];
  if (list.length === 0) return 'No todos';
  const done = list.filter((t) => t.status === 'completed').length;
  const inProg = list.filter((t) => t.status === 'in_progress').length;
  const lines = [
    `Todos (${done}/${list.length} completed):`,
    ...list.map((t) => {
      const form = t.activeForm ? ` (${t.activeForm})` : '';
      return `- [${t.status}] #${t.id} ${t.content}${form}`;
    }),
  ];
  if (inProg > 1) {
    lines.push(
      '',
      `Note: ${inProg} items are in_progress; keep exactly one in_progress.`,
    );
  }
  return lines.join('\n');
}

function assignIds(items, existing = []) {
  const used = new Set(existing.map((t) => t.id));
  return items.map((item) => {
    if (item.id && !used.has(item.id)) {
      used.add(item.id);
      return { ...item, id: item.id };
    }
    const id = slugId(item.content || item.id || 'item', used);
    used.add(id);
    return { ...item, id };
  });
}

/**
 * @param {{ path?: string | null, load?: () => Promise<unknown>, save?: (todos: object[]) => Promise<void> }} [opts]
 */
export function createStore(opts = {}) {
  let todos = [];
  const path = opts.path || null;

  function snapshot() {
    return todos.map(cloneTodo);
  }

  async function persist() {
    if (typeof opts.save === 'function') {
      await opts.save(snapshot());
      return;
    }
    if (!path) return;
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ todos: snapshot() }, null, 2) + '\n', 'utf8');
  }

  async function load() {
    if (typeof opts.load === 'function') {
      const data = await opts.load();
      applyLoaded(data);
      return;
    }
    if (!path) return;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(path, 'utf8');
      applyLoaded(JSON.parse(raw));
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return;
      throw err;
    }
  }

  function applyLoaded(data) {
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.todos)
        ? data.todos
        : null;
    if (!list) return;
    todos = assignIds(
      list.map((raw) => {
        const n = normalizeItem(raw, { requireContent: true });
        return {
          id: n.id,
          content: n.content,
          status: n.status || 'pending',
          activeForm: n.activeForm,
        };
      }),
    );
  }

  function replace(rawList) {
    if (!Array.isArray(rawList)) throw new Error('todos must be an array');
    const incoming = rawList.map((raw) => {
      const n = normalizeItem(raw, { requireContent: true });
      return {
        id: n.id,
        content: n.content,
        status: n.status || 'pending',
        activeForm: n.activeForm,
      };
    });
    todos = assignIds(incoming);
    return snapshot();
  }

  function merge(rawList) {
    if (!Array.isArray(rawList)) throw new Error('todos must be an array');
    const byId = new Map(todos.map((t) => [t.id, cloneTodo(t)]));
    const order = todos.map((t) => t.id);
    const used = new Set(byId.keys());

    for (const raw of rawList) {
      const n = normalizeItem(raw, { requireContent: false });
      let id = n.id;
      if (!id) {
        if (!n.content) {
          throw new Error('merge item needs id or content');
        }
        id = slugId(n.content, used);
      }
      const prev = byId.get(id);
      if (!prev) {
        if (!n.content) {
          throw new Error(`merge: unknown id "${id}" and no content to create`);
        }
        used.add(id);
        byId.set(id, {
          id,
          content: n.content,
          status: n.status || 'pending',
          activeForm: n.activeForm,
        });
        order.push(id);
        continue;
      }
      if (n.content != null) prev.content = n.content;
      if (n.status != null) prev.status = n.status;
      if (n.activeForm != null) prev.activeForm = n.activeForm;
      used.add(id);
    }

    todos = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
    return snapshot();
  }

  return {
    list: snapshot,
    replace,
    merge,
    load,
    persist,
    path,
  };
}

export default {
  STATUSES,
  normalizeStatus,
  normalizeItem,
  extractList,
  formatTodos,
  createStore,
  slugId,
};
