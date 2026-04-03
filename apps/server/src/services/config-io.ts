import type { McpRegistryService } from './mcp-registry.js';
import type { WorkspaceService } from './workspace.js';
import type { RuntimePoolService } from './runtime-pool.js';
import type { McpAggregator } from './aggregator/index.js';

export interface HubConfigMcp {
  name: string;
  slug: string;
  displayName: string;
  transportKind: string;
  instanceMode: string;
  configJson: unknown;
}

export interface HubConfigWorkspace {
  name: string;
  slug: string;
  rootPath: string;
  description: string;
}

export interface HubConfigBinding {
  workspaceSlug: string;
  mcpSlug: string;
  enabled: boolean;
  instanceModeOverride: string | null;
}

export interface HubConfig {
  version: number;
  mcps: HubConfigMcp[];
  workspaces: HubConfigWorkspace[];
  bindings: HubConfigBinding[];
}

export class ConfigIOService {
  constructor(
    private registry: McpRegistryService,
    private workspaceService: WorkspaceService,
    private runtimePool: RuntimePoolService,
    private aggregator: McpAggregator,
  ) {}

  async exportConfig(): Promise<HubConfig> {
    const mcps = await this.registry.list();
    const workspaces = await this.workspaceService.list();

    // Collect all bindings across workspaces
    const bindings: HubConfigBinding[] = [];
    const mcpIdToSlug = new Map(mcps.map(m => [m.id, m.slug]));
    const wsIdToSlug = new Map(workspaces.map(w => [w.id, w.slug]));

    for (const ws of workspaces) {
      const wsBindings = await this.workspaceService.getBindings(ws.id);
      for (const b of wsBindings) {
        const mcpSlug = mcpIdToSlug.get(b.mcpId);
        const workspaceSlug = wsIdToSlug.get(b.workspaceId);
        if (mcpSlug && workspaceSlug) {
          bindings.push({
            workspaceSlug,
            mcpSlug,
            enabled: b.enabled,
            instanceModeOverride: b.instanceModeOverride ?? null,
          });
        }
      }
    }

    return {
      version: 1,
      mcps: mcps.map(m => ({
        name: m.name,
        slug: m.slug,
        displayName: m.displayName,
        transportKind: m.transportKind,
        instanceMode: m.instanceMode,
        configJson: m.configJson,
      })),
      workspaces: workspaces.map(w => ({
        name: w.name,
        slug: w.slug,
        rootPath: w.rootPath,
        description: w.description,
      })),
      bindings,
    };
  }

  async importConfig(config: HubConfig): Promise<{ created: number; errors: string[] }> {
    const errors: string[] = [];
    let created = 0;

    // 1. Destroy all active sessions (safe no-op if none exist)
    const sessions = this.aggregator.getSessionStore().all();
    for (const session of sessions) {
      try {
        await this.aggregator.destroySession(session.sessionId);
      } catch (e: any) {
        errors.push(`Failed to destroy session ${session.sessionId}: ${e.message}`);
      }
    }

    // 2. Stop all runtime instances
    try {
      await this.runtimePool.stopAll();
    } catch (e: any) {
      errors.push(`Failed to stop runtime pool: ${e.message}`);
    }

    // 3. Delete all existing workspaces (cascade deletes bindings)
    const existingWorkspaces = await this.workspaceService.list();
    for (const ws of existingWorkspaces) {
      try {
        await this.workspaceService.delete(ws.id);
      } catch (e: any) {
        errors.push(`Failed to delete workspace ${ws.slug}: ${e.message}`);
      }
    }

    // 4. Delete all existing MCPs (cascade deletes runtime instances)
    const existingMcps = await this.registry.list();
    for (const mcp of existingMcps) {
      try {
        await this.registry.delete(mcp.id);
      } catch (e: any) {
        errors.push(`Failed to delete MCP ${mcp.slug}: ${e.message}`);
      }
    }

    // 5. Create MCPs
    const mcpSlugToId = new Map<string, number>();
    for (const mcpData of config.mcps || []) {
      try {
        const mcp = await this.registry.create({
          name: mcpData.name,
          slug: mcpData.slug,
          displayName: mcpData.displayName,
          transportKind: mcpData.transportKind as any,
          instanceMode: mcpData.instanceMode as any,
          configJson: mcpData.configJson as any,
        });
        mcpSlugToId.set(mcp.slug, mcp.id);
        created++;
      } catch (e: any) {
        errors.push(`Failed to create MCP "${mcpData.slug}": ${e.message}`);
      }
    }

    // 6. Create Workspaces
    const wsSlugToId = new Map<string, number>();
    for (const wsData of config.workspaces || []) {
      try {
        const ws = await this.workspaceService.create({
          name: wsData.name,
          slug: wsData.slug,
          rootPath: wsData.rootPath,
          description: wsData.description,
        });
        wsSlugToId.set(ws.slug, ws.id);
        created++;
      } catch (e: any) {
        errors.push(`Failed to create workspace "${wsData.slug}": ${e.message}`);
      }
    }

    // 7. Create Bindings (resolve slugs to new IDs)
    for (const bindingData of config.bindings || []) {
      const wsId = wsSlugToId.get(bindingData.workspaceSlug);
      const mcpId = mcpSlugToId.get(bindingData.mcpSlug);
      if (!wsId) {
        errors.push(`Binding references unknown workspace slug: "${bindingData.workspaceSlug}"`);
        continue;
      }
      if (!mcpId) {
        errors.push(`Binding references unknown MCP slug: "${bindingData.mcpSlug}"`);
        continue;
      }
      try {
        await this.workspaceService.setBinding(wsId, {
          mcpId,
          enabled: bindingData.enabled,
          instanceModeOverride: bindingData.instanceModeOverride as any,
        });
        created++;
      } catch (e: any) {
        errors.push(`Failed to create binding ${bindingData.workspaceSlug}/${bindingData.mcpSlug}: ${e.message}`);
      }
    }

    return { created, errors };
  }
}
