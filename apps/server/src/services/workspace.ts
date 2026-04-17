import { eq, and } from 'drizzle-orm';
import { schema, type HubDatabase } from '../db/index.js';
import { nameToSlug, isValidSlug } from '@mcp-hub-local/shared';
import type { Workspace, CreateWorkspaceInput, UpdateWorkspaceInput, WorkspaceMcpBinding, SetBindingInput } from '@mcp-hub-local/shared';

export class WorkspaceService {
  constructor(private db: HubDatabase) {}

  async list(): Promise<Workspace[]> {
    const rows = await this.db.select().from(schema.workspaces);
    return rows.map(this.toDto);
  }

  async getById(id: number): Promise<Workspace | null> {
    const rows = await this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    return rows[0] ? this.toDto(rows[0]) : null;
  }

  async getBySlug(slug: string): Promise<Workspace | null> {
    const rows = await this.db.select().from(schema.workspaces).where(eq(schema.workspaces.slug, slug));
    return rows[0] ? this.toDto(rows[0]) : null;
  }

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const slug = input.slug || nameToSlug(input.name);
    if (!isValidSlug(slug)) {
      throw new Error(`Invalid slug: "${slug}". Only lowercase letters, numbers, and hyphens allowed.`);
    }

    const now = new Date().toISOString();
    const result = await this.db.insert(schema.workspaces).values({
      name: input.name,
      slug,
      rootPath: input.rootPath,
      description: input.description || '',
      createdAt: now,
      updatedAt: now,
    }).returning();

    return this.toDto(result[0]);
  }

  async update(id: number, input: UpdateWorkspaceInput): Promise<Workspace> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Workspace not found: ${id}`);

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };

    if (input.name !== undefined) updates.name = input.name;
    if (input.slug !== undefined) {
      if (!isValidSlug(input.slug)) {
        throw new Error(`Invalid slug: "${input.slug}"`);
      }
      updates.slug = input.slug;
    }
    if (input.rootPath !== undefined) updates.rootPath = input.rootPath;
    if (input.description !== undefined) updates.description = input.description;

    await this.db.update(schema.workspaces).set(updates).where(eq(schema.workspaces.id, id));
    return (await this.getById(id))!;
  }

  async delete(id: number): Promise<void> {
    await this.db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
  }

  // ── Bindings ──

  async getBindings(workspaceId: number): Promise<WorkspaceMcpBinding[]> {
    const rows = await this.db.select().from(schema.workspaceMcpBindings)
      .where(eq(schema.workspaceMcpBindings.workspaceId, workspaceId));
    return rows.map(this.bindingToDto);
  }

  async setBinding(workspaceId: number, input: SetBindingInput): Promise<WorkspaceMcpBinding> {
    const existing = await this.db.select().from(schema.workspaceMcpBindings)
      .where(and(
        eq(schema.workspaceMcpBindings.workspaceId, workspaceId),
        eq(schema.workspaceMcpBindings.mcpId, input.mcpId),
      ));

    if (existing[0]) {
      const updates: Record<string, unknown> = {};
      if (input.enabled !== undefined) updates.enabled = input.enabled;
      if (input.instanceModeOverride !== undefined) updates.instanceModeOverride = input.instanceModeOverride;

      await this.db.update(schema.workspaceMcpBindings).set(updates)
        .where(eq(schema.workspaceMcpBindings.id, existing[0].id));

      const updated = await this.db.select().from(schema.workspaceMcpBindings)
        .where(eq(schema.workspaceMcpBindings.id, existing[0].id));
      return this.bindingToDto(updated[0]);
    }

    const result = await this.db.insert(schema.workspaceMcpBindings).values({
      workspaceId,
      mcpId: input.mcpId,
      enabled: input.enabled ?? true,
      instanceModeOverride: input.instanceModeOverride ?? null,
    }).returning();

    return this.bindingToDto(result[0]);
  }

  async removeBinding(workspaceId: number, mcpId: number): Promise<void> {
    await this.db.delete(schema.workspaceMcpBindings)
      .where(and(
        eq(schema.workspaceMcpBindings.workspaceId, workspaceId),
        eq(schema.workspaceMcpBindings.mcpId, mcpId),
      ));
  }

  private toDto(row: typeof schema.workspaces.$inferSelect): Workspace {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      rootPath: row.rootPath,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private bindingToDto(row: typeof schema.workspaceMcpBindings.$inferSelect): WorkspaceMcpBinding {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      mcpId: row.mcpId,
      enabled: row.enabled,
      instanceModeOverride: row.instanceModeOverride as WorkspaceMcpBinding['instanceModeOverride'],
    };
  }
}
