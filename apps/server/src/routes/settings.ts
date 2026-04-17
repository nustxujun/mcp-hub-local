import type { FastifyInstance } from 'fastify';
import type { SettingsService } from '../services/settings.js';
import type { ConfigSyncService } from '../services/config-sync.js';
import type { ConfigIOService, HubConfig } from '../services/config-io.js';
import type { ClientType, SyncClientsSettings } from '@mcp-hub-local/shared';
import path from 'node:path';

export function registerSettingsRoutes(
  app: FastifyInstance,
  settingsService: SettingsService,
  configSync: ConfigSyncService,
  configIO: ConfigIOService,
) {
  app.get('/api/settings/info', async () => {
    const dataDir = path.join(process.cwd(), 'data');
    return { dataDir };
  });

  app.get('/api/settings', async () => {
    return settingsService.getAll();
  });

  app.patch('/api/settings', async (request) => {
    const updates = request.body as Record<string, unknown>;

    const oldSyncClients = await settingsService.get<SyncClientsSettings>('syncClients');
    const oldClients = new Set(oldSyncClients?.clients || []);

    await settingsService.patchMultiple(updates);

    if (updates.syncClients) {
      const newClients = (updates.syncClients as SyncClientsSettings).clients || [];
      const addedClients = newClients.filter((c: ClientType) => !oldClients.has(c));
      if (addedClients.length > 0) {
        configSync.syncAllWorkspaces().catch(() => {});
      }
    }

    return settingsService.getAll();
  });

  // ── Config Export / Import ──

  app.get('/api/config/export', async () => {
    return configIO.exportConfig();
  });

  app.post('/api/config/import', async (request, reply) => {
    const body = request.body as HubConfig;
    if (!body || !body.version) {
      return reply.status(400).send({ error: 'Invalid config format: missing version field' });
    }
    const query = request.query as { mode?: string } | undefined;
    const mode = query?.mode === 'merge' ? 'merge' : 'replace';
    if (mode === 'merge') {
      return configIO.mergeConfig(body);
    }
    return configIO.importConfig(body);
  });
}
