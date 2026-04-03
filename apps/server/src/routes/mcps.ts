import type { FastifyInstance } from 'fastify';
import type { McpRegistryService } from '../services/mcp-registry.js';
import type { HealthCheckService } from '../services/health-check.js';
import type { RuntimePoolService } from '../services/runtime-pool.js';
import type { McpAggregator } from '../services/aggregator/index.js';

export function registerMcpRoutes(app: FastifyInstance, registry: McpRegistryService, healthCheck: HealthCheckService, runtimePool: RuntimePoolService, aggregator: McpAggregator) {
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
          body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-hub-local-test', version: '0.1.0' } } }),
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
          body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-hub-local-test', version: '0.1.0' } } }),
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
