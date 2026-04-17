import type { McpRegistryService } from './mcp-registry.js';
import type { WorkspaceService } from './workspace.js';
import type { RuntimePoolService } from './runtime-pool.js';
import type { McpAggregator } from './aggregator/index.js';
import { and, eq } from 'drizzle-orm';
import { schema, type HubDatabase } from '../db/index.js';

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ak = Object.keys(a as Record<string, unknown>).sort();
  const bk = Object.keys(b as Record<string, unknown>).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (!deepEqual((a as any)[ak[i]], (b as any)[bk[i]])) return false;
  }
  return true;
}

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

export interface HubConfigToolSetting {
  mcpSlug: string;
  toolName: string;
  exposed: boolean;
  pinned: boolean;
}

export interface HubConfig {
  version: number;
  mcps: HubConfigMcp[];
  workspaces: HubConfigWorkspace[];
  bindings: HubConfigBinding[];
  toolSettings?: HubConfigToolSetting[];
}

export class ConfigIOService {
  constructor(
    private registry: McpRegistryService,
    private workspaceService: WorkspaceService,
    private runtimePool: RuntimePoolService,
    private aggregator: McpAggregator,
    private db: HubDatabase,
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

    // Collect tool settings (exposed/pinned)
    const toolSettingsRows = await this.db.select().from(schema.exposedTools);
    const mcpIdToSlugMap = new Map(mcps.map(m => [m.id, m.slug]));
    const toolSettings: HubConfigToolSetting[] = [];
    for (const row of toolSettingsRows) {
      const mcpSlug = mcpIdToSlugMap.get(row.mcpId);
      if (mcpSlug) {
        toolSettings.push({
          mcpSlug,
          toolName: row.toolName,
          exposed: row.exposed ?? false,
          pinned: row.pinned ?? false,
        });
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
      toolSettings,
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

    // 8. Restore tool settings (exposed/pinned)
    if (config.toolSettings) {
      for (const ts of config.toolSettings) {
        const mcpId = mcpSlugToId.get(ts.mcpSlug);
        if (!mcpId) {
          errors.push(`Tool setting references unknown MCP slug: "${ts.mcpSlug}"`);
          continue;
        }
        try {
          this.db.insert(schema.exposedTools).values({
            mcpId,
            toolName: ts.toolName,
            exposed: ts.exposed ?? false,
            pinned: ts.pinned ?? false,
          }).run();
          created++;
        } catch (e: any) {
          errors.push(`Failed to restore tool setting ${ts.mcpSlug}/${ts.toolName}: ${e.message}`);
        }
      }
    }

    return { created, errors };
  }

  async mergeConfig(config: HubConfig): Promise<{
    created: number;
    updated: number;
    skipped: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    // 1. Stop sessions and runtime so subsequent calls can re-spin with the merged config.
    const sessions = this.aggregator.getSessionStore().all();
    for (const session of sessions) {
      try {
        await this.aggregator.destroySession(session.sessionId);
      } catch (e: any) {
        errors.push(`Failed to destroy session ${session.sessionId}: ${e.message}`);
      }
    }
    try {
      await this.runtimePool.stopAll();
    } catch (e: any) {
      errors.push(`Failed to stop runtime pool: ${e.message}`);
    }

    // 2. Build indices over existing data.
    const existingMcps = await this.registry.list();
    const mcpSlugToId = new Map<string, number>();
    const mcpBySlug = new Map<string, typeof existingMcps[number]>();
    for (const m of existingMcps) {
      mcpSlugToId.set(m.slug, m.id);
      mcpBySlug.set(m.slug, m);
    }

    const existingWorkspaces = await this.workspaceService.list();
    const wsSlugToId = new Map<string, number>();
    const wsBySlug = new Map<string, typeof existingWorkspaces[number]>();
    const wsByRootPath = new Map<string, typeof existingWorkspaces[number]>();
    for (const w of existingWorkspaces) {
      wsSlugToId.set(w.slug, w.id);
      wsBySlug.set(w.slug, w);
      if (w.rootPath) wsByRootPath.set(w.rootPath, w);
    }

    // 3. Merge MCPs by slug.
    for (const mcpData of config.mcps || []) {
      try {
        const existing = mcpBySlug.get(mcpData.slug);
        if (!existing) {
          const mcp = await this.registry.create({
            name: mcpData.name,
            slug: mcpData.slug,
            displayName: mcpData.displayName,
            transportKind: mcpData.transportKind as any,
            instanceMode: mcpData.instanceMode as any,
            configJson: mcpData.configJson as any,
          });
          mcpSlugToId.set(mcp.slug, mcp.id);
          mcpBySlug.set(mcp.slug, mcp);
          created++;
        } else {
          const updates: Record<string, unknown> = {};
          if (existing.name !== mcpData.name) updates.name = mcpData.name;
          if (existing.displayName !== mcpData.displayName) updates.displayName = mcpData.displayName;
          if (existing.instanceMode !== mcpData.instanceMode) updates.instanceMode = mcpData.instanceMode;
          if (!deepEqual(existing.configJson, mcpData.configJson)) updates.configJson = mcpData.configJson;
          // transportKind change is not supported by registry.update; report it.
          if (existing.transportKind !== mcpData.transportKind) {
            errors.push(`MCP "${mcpData.slug}" transportKind change ("${existing.transportKind}" -> "${mcpData.transportKind}") is not supported via merge; skipping.`);
          }
          if (Object.keys(updates).length > 0) {
            await this.registry.update(existing.id, updates as any);
            updated++;
          } else {
            skipped++;
          }
        }
      } catch (e: any) {
        errors.push(`Failed to merge MCP "${mcpData.slug}": ${e.message}`);
      }
    }

    // 4. Merge workspaces by slug OR rootPath.
    for (const wsData of config.workspaces || []) {
      try {
        const bySlug = wsBySlug.get(wsData.slug);
        const byRoot = wsData.rootPath ? wsByRootPath.get(wsData.rootPath) : undefined;

        let target = bySlug ?? byRoot;
        if (bySlug && byRoot && bySlug.id !== byRoot.id) {
          errors.push(`Workspace "${wsData.slug}" matches existing slug (id=${bySlug.id}) and another existing rootPath (id=${byRoot.id}); using slug match and leaving the rootPath-matched record untouched.`);
          target = bySlug;
        }

        if (!target) {
          const ws = await this.workspaceService.create({
            name: wsData.name,
            slug: wsData.slug,
            rootPath: wsData.rootPath,
            description: wsData.description,
          });
          wsSlugToId.set(ws.slug, ws.id);
          wsBySlug.set(ws.slug, ws);
          if (ws.rootPath) wsByRootPath.set(ws.rootPath, ws);
          created++;
        } else {
          const updates: Record<string, unknown> = {};
          if (target.name !== wsData.name) updates.name = wsData.name;
          if (target.slug !== wsData.slug) updates.slug = wsData.slug;
          if (target.rootPath !== wsData.rootPath) updates.rootPath = wsData.rootPath;
          if ((target.description ?? '') !== (wsData.description ?? '')) updates.description = wsData.description;
          if (Object.keys(updates).length > 0) {
            const updatedWs = await this.workspaceService.update(target.id, updates as any);
            // Refresh indices for any slug/rootPath rename.
            if (target.slug !== updatedWs.slug) {
              wsBySlug.delete(target.slug);
              wsSlugToId.delete(target.slug);
            }
            if (target.rootPath && target.rootPath !== updatedWs.rootPath) {
              wsByRootPath.delete(target.rootPath);
            }
            wsSlugToId.set(updatedWs.slug, updatedWs.id);
            wsBySlug.set(updatedWs.slug, updatedWs);
            if (updatedWs.rootPath) wsByRootPath.set(updatedWs.rootPath, updatedWs);
            updated++;
          } else {
            wsSlugToId.set(target.slug, target.id);
            skipped++;
          }
        }
      } catch (e: any) {
        errors.push(`Failed to merge workspace "${wsData.slug}": ${e.message}`);
      }
    }

    // 5. Merge bindings.
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
        const existingBindings = await this.workspaceService.getBindings(wsId);
        const current = existingBindings.find(b => b.mcpId === mcpId);
        if (!current) {
          await this.workspaceService.setBinding(wsId, {
            mcpId,
            enabled: bindingData.enabled,
            instanceModeOverride: bindingData.instanceModeOverride as any,
          });
          created++;
        } else {
          const enabledDiff = current.enabled !== bindingData.enabled;
          const overrideDiff = (current.instanceModeOverride ?? null) !== (bindingData.instanceModeOverride ?? null);
          if (enabledDiff || overrideDiff) {
            await this.workspaceService.setBinding(wsId, {
              mcpId,
              enabled: bindingData.enabled,
              instanceModeOverride: bindingData.instanceModeOverride as any,
            });
            updated++;
          } else {
            skipped++;
          }
        }
      } catch (e: any) {
        errors.push(`Failed to merge binding ${bindingData.workspaceSlug}/${bindingData.mcpSlug}: ${e.message}`);
      }
    }

    // 6. Merge tool settings (exposed_tools).
    if (config.toolSettings) {
      for (const ts of config.toolSettings) {
        const mcpId = mcpSlugToId.get(ts.mcpSlug);
        if (!mcpId) {
          errors.push(`Tool setting references unknown MCP slug: "${ts.mcpSlug}"`);
          continue;
        }
        try {
          const existingRows = await this.db.select().from(schema.exposedTools).where(and(
            eq(schema.exposedTools.mcpId, mcpId),
            eq(schema.exposedTools.toolName, ts.toolName),
          ));
          const existingRow = existingRows[0];
          if (!existingRow) {
            this.db.insert(schema.exposedTools).values({
              mcpId,
              toolName: ts.toolName,
              exposed: ts.exposed ?? false,
              pinned: ts.pinned ?? false,
            }).run();
            created++;
          } else {
            const exposedDiff = (existingRow.exposed ?? false) !== (ts.exposed ?? false);
            const pinnedDiff = (existingRow.pinned ?? false) !== (ts.pinned ?? false);
            if (exposedDiff || pinnedDiff) {
              this.db.update(schema.exposedTools).set({
                exposed: ts.exposed ?? false,
                pinned: ts.pinned ?? false,
              }).where(eq(schema.exposedTools.id, existingRow.id)).run();
              updated++;
            } else {
              skipped++;
            }
          }
        } catch (e: any) {
          errors.push(`Failed to merge tool setting ${ts.mcpSlug}/${ts.toolName}: ${e.message}`);
        }
      }
    }

    return { created, updated, skipped, errors };
  }
}
