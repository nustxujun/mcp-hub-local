import type { FastifyInstance } from 'fastify';
import type { WorkspaceService } from '../services/workspace.js';
import type { McpRegistryService } from '../services/mcp-registry.js';
import type { ConfigSyncService } from '../services/config-sync.js';
import type { McpAggregator } from '../services/aggregator/index.js';
import type { ClientType } from '@mcp-hub-local/shared';
import { DEFAULT_PORT } from '@mcp-hub-local/shared';
import type { SettingsService } from '../services/settings.js';
import { getProfile } from '@mcp-hub-local/client-profiles';
import type { McpEndpointInfo } from '@mcp-hub-local/client-profiles';

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  workspaceService: WorkspaceService,
  registry: McpRegistryService,
  configSync: ConfigSyncService,
  settingsService: SettingsService,
  aggregator: McpAggregator,
) {
  app.get('/api/workspaces', async () => {
    return workspaceService.list();
  });

  app.get('/api/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ws = await workspaceService.getById(parseInt(id));
    if (!ws) return reply.status(404).send({ error: 'Workspace not found' });
    return ws;
  });

  app.post('/api/workspaces', async (request, reply) => {
    try {
      const ws = await workspaceService.create(request.body as any);
      return reply.status(201).send(ws);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.patch('/api/workspaces/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const ws = await workspaceService.update(parseInt(id), request.body as any);
      return ws;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.delete('/api/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await workspaceService.delete(parseInt(id));
    return reply.status(204).send();
  });

  // ── Bindings ──

  app.get('/api/workspaces/:id/bindings', async (request, reply) => {
    const { id } = request.params as { id: string };
    return workspaceService.getBindings(parseInt(id));
  });

  app.put('/api/workspaces/:id/bindings', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const workspaceId = parseInt(id);
      const binding = await workspaceService.setBinding(workspaceId, request.body as any);

      configSync.syncWorkspace(workspaceId).catch(() => {});
      aggregator.refreshWorkspaceBindings(workspaceId).catch(() => {});
      return binding;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.delete('/api/workspaces/:id/bindings/:mcpId', async (request, reply) => {
    const { id, mcpId } = request.params as { id: string; mcpId: string };
    const workspaceId = parseInt(id);
    await workspaceService.removeBinding(workspaceId, parseInt(mcpId));
    configSync.syncWorkspace(workspaceId).catch(() => {});
    aggregator.refreshWorkspaceBindings(workspaceId).catch(() => {});
    return reply.status(204).send();
  });

  // ── Client configs ──

  app.get('/api/workspaces/:id/client-configs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = parseInt(id);
    const ws = await workspaceService.getById(workspaceId);
    if (!ws) return reply.status(404).send({ error: 'Workspace not found' });

    const portValue = await settingsService.get<number>('port');
    const port = portValue || DEFAULT_PORT;
    const endpoints = await buildEndpoints(workspaceId, ws.slug, port, workspaceService, registry);

    const result: Record<string, unknown> = {};
    for (const ct of ['cursor', 'claude', 'codex', 'gemini'] as ClientType[]) {
      const profile = getProfile(ct);
      result[ct] = profile.generateMcpConfig(endpoints);
    }
    return result;
  });

  app.get('/api/workspaces/:id/client-configs/:clientType', async (request, reply) => {
    const { id, clientType } = request.params as { id: string; clientType: ClientType };
    const workspaceId = parseInt(id);
    const ws = await workspaceService.getById(workspaceId);
    if (!ws) return reply.status(404).send({ error: 'Workspace not found' });

    const portValue = await settingsService.get<number>('port');
    const port = portValue || DEFAULT_PORT;
    const endpoints = await buildEndpoints(workspaceId, ws.slug, port, workspaceService, registry);

    try {
      const profile = getProfile(clientType);
      return profile.generateMcpConfig(endpoints);
    } catch {
      return reply.status(400).send({ error: `Unknown client type: ${clientType}` });
    }
  });

  // ── Manual sync ──

  app.post('/api/workspaces/:id/sync', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await configSync.syncWorkspace(parseInt(id));
    return result;
  });
}

async function buildEndpoints(
  workspaceId: number,
  workspaceSlug: string,
  port: number,
  workspaceService: WorkspaceService,
  registry: McpRegistryService,
): Promise<McpEndpointInfo[]> {
  const bindings = await workspaceService.getBindings(workspaceId);
  const enabled = bindings.filter(b => b.enabled);

  if (enabled.length === 0) return [];

  return [{
    name: 'mcp-hub-local',
    slug: workspaceSlug,
    url: `http://localhost:${port}/w/${workspaceSlug}`,
  }];
}
