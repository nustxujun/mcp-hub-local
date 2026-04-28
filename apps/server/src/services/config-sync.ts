import type { ClientType } from '@mcp-hub-local/shared';
import { DEFAULT_PORT } from '@mcp-hub-local/shared';
import type { WorkspaceService } from './workspace.js';
import type { McpRegistryService } from './mcp-registry.js';
import type { SettingsService } from './settings.js';
import type { LogService } from './log.js';
import { getProfile } from '@mcp-hub-local/client-profiles';
import type { McpEndpointInfo, RuleSyncContext } from '@mcp-hub-local/client-profiles';

export class ConfigSyncService {
  constructor(
    private workspaceService: WorkspaceService,
    private registry: McpRegistryService,
    private settingsService: SettingsService,
    private logService: LogService,
  ) {}

  async syncWorkspace(workspaceId: number): Promise<{ synced: ClientType[]; errors: string[] }> {
    const syncClientsData = await this.settingsService.get<{ clients: ClientType[] }>('syncClients');
    const clients = syncClientsData?.clients || [];
    if (clients.length === 0) {
      return { synced: [], errors: [] };
    }

    const workspace = await this.workspaceService.getById(workspaceId);
    if (!workspace) {
      return { synced: [], errors: [`Workspace ${workspaceId} not found`] };
    }

    const bindings = await this.workspaceService.getBindings(workspaceId);
    const enabledBindings = bindings.filter(b => b.enabled);

    const portValue = await this.settingsService.get<number>('port');
    const port = portValue || DEFAULT_PORT;

    const hubEndpointUrl = `http://localhost:${port}/w/${workspace.slug}`;

    const endpoints: McpEndpointInfo[] = enabledBindings.length > 0
      ? [{
          name: 'mcp-hub-local',
          slug: workspace.slug,
          url: hubEndpointUrl,
        }]
      : [];

    const enabledMcps = await Promise.all(
      enabledBindings.map(b => this.registry.getById(b.mcpId)),
    );
    const mcpNames = enabledMcps
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .map(m => m.displayName || m.name);

    const ruleCtx: RuleSyncContext = {
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
      hubEndpointUrl,
      mcpNames,
    };

    const synced: ClientType[] = [];
    const errors: string[] = [];

    for (const clientType of clients) {
      let profile;
      try {
        profile = getProfile(clientType);
      } catch (err) {
        const msg = `Failed to load profile for ${clientType}: ${err}`;
        errors.push(msg);
        await this.logService.append({
          level: 'error',
          category: 'config-sync',
          workspaceId,
          message: msg,
        });
        continue;
      }

      let configOk = false;
      try {
        const configPath = profile.getConfigPath(workspace.rootPath);
        const mcpConfig = profile.generateMcpConfig(endpoints);
        await profile.writeManagedConfig(configPath, mcpConfig);
        configOk = true;

        await this.logService.append({
          level: 'info',
          category: 'config-sync',
          workspaceId,
          message: `Synced ${clientType} config to ${configPath}`,
        });
      } catch (err) {
        const msg = `Failed to sync ${clientType} config: ${err}`;
        errors.push(msg);
        await this.logService.append({
          level: 'error',
          category: 'config-sync',
          workspaceId,
          message: msg,
        });
      }

      let ruleOk = false;
      try {
        const rulePath = profile.getRulePath(workspace.rootPath);
        await profile.writeManagedRule(rulePath, ruleCtx);
        ruleOk = true;

        await this.logService.append({
          level: 'info',
          category: 'config-sync',
          workspaceId,
          message: `Synced ${clientType} rule to ${rulePath}`,
        });
      } catch (err) {
        const msg = `Failed to sync ${clientType} rule: ${err}`;
        errors.push(msg);
        await this.logService.append({
          level: 'error',
          category: 'config-sync',
          workspaceId,
          message: msg,
        });
      }

      if (configOk && ruleOk) {
        synced.push(clientType);
      }
    }

    return { synced, errors };
  }

  async syncAllWorkspaces(): Promise<void> {
    const workspaces = await this.workspaceService.list();
    for (const ws of workspaces) {
      await this.syncWorkspace(ws.id);
    }
  }
}
