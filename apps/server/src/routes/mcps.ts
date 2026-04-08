import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema, type HubDatabase } from '../db/index.js';
import type { McpRegistryService } from '../services/mcp-registry.js';
import type { HealthCheckService } from '../services/health-check.js';
import type { RuntimePoolService } from '../services/runtime-pool.js';
import type { McpAggregator } from '../services/aggregator/index.js';

export function registerMcpRoutes(app: FastifyInstance, registry: McpRegistryService, healthCheck: HealthCheckService, runtimePool: RuntimePoolService, aggregator: McpAggregator, db: HubDatabase) {
  app.get('/api/mcps', async () => {
    return registry.list();
  });

  // Return cached health status (instant, no network calls)
  app.get('/api/mcps/health', async () => {
    return healthCheck.getStatus();
  });

  // Force a live check (existing endpoint)
  app.get('/api/mcps/batch-test', async () => {
    const allMcps = await registry.list();
    const remoteMcps = allMcps.filter(m => m.transportKind === 'streamable-http');

    const results: Record<number, { ok: boolean; status?: number; error?: string }> = {};

    await Promise.all(remoteMcps.map(async (mcp) => {
      try {
        const config = mcp.configJson as { url: string; headers?: Record<string, string> };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...(config.headers || {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-hub-local-test', version: '0.1.0' } } }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        results[mcp.id] = { ok: response.ok, status: response.status };
      } catch (err: any) {
        results[mcp.id] = { ok: false, error: err.message };
      }
    }));

    for (const mcp of allMcps) {
      if (mcp.transportKind === 'stdio') {
        results[mcp.id] = { ok: true, status: -1 };
      }
    }

    return results;
  });

  app.post('/api/mcps', async (request, reply) => {
    try {
      const mcp = await registry.create(request.body as any);
      return reply.status(201).send(mcp);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.patch('/api/mcps/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const mcpId = parseInt(id);
      const mcp = await registry.update(mcpId, request.body as any);

      // Propagate config change: stop old instances, restart affected sessions
      // Await to ensure old instances are cleaned up before returning
      await aggregator.onMcpConfigChanged(mcpId);

      // For stdio MCPs, re-start the singleton so the updated config takes effect immediately
      if (mcp.transportKind === 'stdio') {
        try {
          await runtimePool.startAndInitialize(mcp);
        } catch {
          // Non-fatal: instance will be started on next session connect
        }
      }

      return mcp;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.delete('/api/mcps/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mcpId = parseInt(id);
    // Propagate before deleting — stop instances and refresh sessions
    await aggregator.onMcpConfigChanged(mcpId);
    await registry.delete(mcpId);
    return reply.status(204).send();
  });

  app.post('/api/mcps/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mcp = await registry.getById(parseInt(id));
    if (!mcp) {
      return reply.status(404).send({ error: 'MCP not found' });
    }

    if (mcp.transportKind === 'streamable-http') {
      try {
        const config = mcp.configJson as { url: string; headers?: Record<string, string> };
        const response = await fetch(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...(config.headers || {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-hub-local-test', version: '0.1.0' } } }),
        });
        const body = await response.text();
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        return { ok: response.ok, status: response.status, body: parsed };
      } catch (err: any) {
        return reply.status(200).send({ ok: false, error: err.message });
      }
    }

    return { ok: true, message: 'Stdio MCP — launch test not yet implemented' };
  });

  app.post('/api/mcps/:id/start', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mcp = await registry.getById(parseInt(id));
    if (!mcp) {
      return reply.status(404).send({ error: 'MCP not found' });
    }
    if (mcp.transportKind !== 'stdio') {
      return reply.status(400).send({ error: 'Only stdio MCPs can be started' });
    }
    try {
      const handle = await runtimePool.startAndInitialize(mcp);
      return { ok: true, instanceId: handle.instanceId };
    } catch (err: any) {
      return reply.status(500).send({ ok: false, error: err.message });
    }
  });

  app.post('/api/mcps/:id/restart', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mcp = await registry.getById(parseInt(id));
    if (!mcp) {
      return reply.status(404).send({ error: 'MCP not found' });
    }
    if (mcp.transportKind !== 'stdio') {
      return reply.status(400).send({ error: 'Only local MCPs can be restarted' });
    }
    await aggregator.restartMcpInstances(mcp.id);
    return { ok: true };
  });

  // ── Tool Exposure ──

  // Get tools list from a running MCP instance (local or remote)
  app.get('/api/mcps/:id/tools', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mcp = await registry.getById(parseInt(id));
    if (!mcp) {
      return reply.status(404).send({ error: 'MCP not found' });
    }

    if (mcp.transportKind === 'streamable-http') {
      // Remote MCP: initialize a temporary session, then send tools/list
      const config = mcp.configJson as { url: string; headers?: Record<string, string> };
      const commonHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(config.headers || {}),
      };
      try {
        // Step 1: initialize to get session id
        const initRes = await fetch(config.url, {
          method: 'POST',
          headers: commonHeaders,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-hub-local-tools', version: '0.1.0' } } }),
        });
        if (!initRes.ok) {
          return { tools: [], message: `Remote MCP returned ${initRes.status}` };
        }
        const sessionId = initRes.headers.get('mcp-session-id');

        // Step 2: send initialized notification
        await fetch(config.url, {
          method: 'POST',
          headers: { ...commonHeaders, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        });

        // Step 3: tools/list
        const toolsRes = await fetch(config.url, {
          method: 'POST',
          headers: { ...commonHeaders, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2, params: {} }),
        });
        const toolsBody = await toolsRes.json() as any;
        return { tools: toolsBody?.result?.tools || [] };
      } catch (err: any) {
        return { tools: [], message: `Failed to connect: ${err.message}` };
      }
    }

    // Local (stdio) MCP: use running handle
    const handles = runtimePool.listHandles();
    const handle = handles.find(h => h.mcpId === mcp.id);
    if (!handle) {
      return { tools: [], message: 'MCP is not running. Start it first to discover tools.' };
    }

    try {
      const reqId = Date.now() + Math.floor(Math.random() * 100000);
      const response = await runtimePool.sendJsonRpc(handle, {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: reqId,
        params: {},
      }, 10000) as any;

      return { tools: response?.result?.tools || [] };
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to list tools: ${err.message}` });
    }
  });

  // Get tool settings for an MCP (exposed + pinned)
  app.get('/api/mcps/:id/exposed-tools', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mcpId = parseInt(id);
    const rows = await db.select().from(schema.exposedTools).where(eq(schema.exposedTools.mcpId, mcpId));
    return rows.map(r => ({ toolName: r.toolName, exposed: r.exposed, pinned: r.pinned }));
  });

  // Set tool settings for an MCP (full replace)
  app.put('/api/mcps/:id/exposed-tools', async (request, reply) => {
    const { id } = request.params as { id: string };
    const mcpId = parseInt(id);
    const { tools } = request.body as { tools: Array<{ toolName: string; exposed?: boolean; pinned?: boolean }> };

    if (!Array.isArray(tools)) {
      return reply.status(400).send({ error: 'tools must be an array of { toolName, exposed?, pinned? }' });
    }

    // Delete existing and insert new
    db.delete(schema.exposedTools).where(eq(schema.exposedTools.mcpId, mcpId)).run();
    for (const t of tools) {
      if (!t.exposed && !t.pinned) continue; // skip tools with no settings
      db.insert(schema.exposedTools).values({ mcpId, toolName: t.toolName, exposed: t.exposed ?? false, pinned: t.pinned ?? false }).run();
    }

    // Invalidate cached tools in all active sessions so changes take effect
    aggregator.invalidateAllToolCaches();

    return { ok: true, tools };
  });

  // ── Runtime Instances ──

  app.get('/api/runtime-instances', async () => {
    return runtimePool.listInstances();
  });

  app.delete('/api/runtime-instances/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await runtimePool.deleteInstance(parseInt(id));
    if (!ok) return reply.status(400).send({ error: 'Only error instances can be deleted' });
    return reply.status(204).send();
  });
}
