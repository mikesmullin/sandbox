/**
 * Minimal newline-delimited JSON-RPC MCP host kit (stdio).
 * Enough for tools/list + tools/call; not a full MCP implementation.
 */

export function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * @param {{ name: string, version?: string, tools: Record<string, {
 *   description: string,
 *   inputSchema: object,
 *   handler: (args: object, ctx?: {
 *     notify: (method: string, params: object) => void,
 *     progressToken: unknown,
 *     signal: AbortSignal,
 *   }) => Promise<object> | object
 * }> }} options
 */
export async function runMcpStdioServer(options) {
  const { name, version = '0.0.1', tools } = options;
  const toolList = Object.entries(tools).map(([toolName, def]) => ({
    name: toolName,
    description: def.description || '',
    inputSchema: def.inputSchema || { type: 'object', properties: {} },
  }));

  let buffer = '';
  let closed = false;
  /** @type {Map<string|number, AbortController>} */
  const inFlight = new Map();

  const write = (msg) => {
    if (closed) return;
    process.stdout.write(JSON.stringify(msg) + '\n');
  };

  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) =>
    write({ jsonrpc: '2.0', id, error: { code, message } });

  function abortInFlight(requestId, reason) {
    const why = reason || 'cancelled';
    for (const [id, ac] of inFlight) {
      if (requestId != null && requestId !== '' && String(id) !== String(requestId)) {
        continue;
      }
      if (!ac.signal.aborted) {
        try {
          ac.abort(why);
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // notifications (no id) — Stop sends notifications/cancelled
    if (msg.method && msg.id === undefined) {
      if (
        msg.method === 'notifications/cancelled' ||
        msg.method === 'cancelled'
      ) {
        abortInFlight(msg.params?.requestId, msg.params?.reason);
      }
      return;
    }

    const { id, method, params } = msg;

    try {
      if (method === 'initialize') {
        respond(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        });
        return;
      }

      if (method === 'ping') {
        respond(id, {});
        return;
      }

      if (method === 'tools/list') {
        respond(id, { tools: toolList });
        return;
      }

      if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const def = tools[toolName];
        if (!def) {
          respond(id, textResult(`Unknown tool: ${toolName}`, true));
          return;
        }
        const progressToken = params?._meta?.progressToken;
        const ac = new AbortController();
        inFlight.set(id, ac);
        const ctx = {
          notify: (methodName, nparams) => {
            if (!methodName) return;
            write({ jsonrpc: '2.0', method: methodName, params: nparams || {} });
          },
          progressToken,
          signal: ac.signal,
        };
        try {
          const result = await def.handler(args, ctx);
          if (result && Array.isArray(result.content)) {
            respond(id, result);
          } else if (typeof result === 'string') {
            respond(id, textResult(result));
          } else {
            respond(id, textResult(JSON.stringify(result, null, 2)));
          }
        } catch (err) {
          respond(id, textResult(err?.message || String(err), true));
        } finally {
          inFlight.delete(id);
        }
        return;
      }

      // graceful no-op for optional methods
      if (method === 'resources/list' || method === 'prompts/list') {
        respond(id, method === 'resources/list' ? { resources: [] } : { prompts: [] });
        return;
      }

      respondError(id, -32601, `Method not found: ${method}`);
    } catch (err) {
      respondError(id, -32603, err?.message || String(err));
    }
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        process.stderr.write(`mcp-stdio parse error: ${err.message}\n`);
        continue;
      }
      handleMessage(msg);
    }
  });

  process.stdin.on('end', () => {
    closed = true;
  });

  // Keep alive until stdin closes
  await new Promise((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
  });
}
