import { eq } from 'drizzle-orm';
import { schema, type HubDatabase } from '../db/index.js';
import { nameToSlug, isValidSlug } from '@mcp-hub-local/shared';
import { validateTransportConfig } from '@mcp-hub-local/config-kit';
import type { CreateMcpInput, UpdateMcpInput, McpDefinition } from '@mcp-hub-local/shared';

export class McpRegistryService {
  constructor(private db: HubDatabase) {}

  async list(): Promise<McpDefinition[]> {
    const rows = await this.db.select().from(schema.mcpDefinitions);
    return rows.map(this.toDto);
  }

  async getById(id: number): Promise<McpDefinition | null> {
    const rows = await this.db.select().from(schema.mcpDefinitions).where(eq(schema.mcpDefinitions.id, id));
    return rows[0] ? this.toDto(rows[0]) : null;
  }

  async getBySlug(slug: string): Promise<McpDefinition | null> {
    const rows = await this.db.select().from(schema.mcpDefinitions).where(eq(schema.mcpDefinitions.slug, slug));
    return rows[0] ? this.toDto(rows[0]) : null;
  }

  async create(input: CreateMcpInput): Promise<McpDefinition> {
    const slug = input.slug || nameToSlug(input.name);
    if (!isValidSlug(slug)) {
      throw new Error(`Invalid slug: "${slug}". Only lowercase letters, numbers, and hyphens allowed.`);
    }

    const validation = validateTransportConfig(input.transportKind, input.configJson);
    if (!validation.valid) {
      throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
    }

    const effectiveInstanceMode = input.transportKind === 'streamable-http'
      ? 'singleton'
      : (input.instanceMode || 'per-workspace');

    const now = new Date().toISOString();
    const result = await this.db.insert(schema.mcpDefinitions).values({
      name: input.name,
      slug,
      displayName: input.displayName || input.name,
      transportKind: input.transportKind,
      instanceMode: effectiveInstanceMode,
      configJson: JSON.stringify(input.configJson),
      createdAt: now,
      updatedAt: now,
    }).returning();

    return this.toDto(result[0]);
  }

  async update(id: number, input: UpdateMcpInput): Promise<McpDefinition> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`MCP not found: ${id}`);

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };

    if (input.name !== undefined) updates.name = input.name;
    if (input.slug !== undefined) {
      if (!isValidSlug(input.slug)) {
        throw new Error(`Invalid slug: "${input.slug}"`);
      }
      updates.slug = input.slug;
    }
    if (input.displayName !== undefined) updates.displayName = input.displayName;
    if (input.instanceMode !== undefined) {
      if (existing.transportKind === 'streamable-http' && input.instanceMode !== 'singleton') {
        throw new Error('Remote streamable-http MCPs are always singleton');
      }
      updates.instanceMode = input.instanceMode;
    }
    if (input.configJson !== undefined) {
      const validation = validateTransportConfig(existing.transportKind, input.configJson);
      if (!validation.valid) {
        throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
      }
      updates.configJson = JSON.stringify(input.configJson);
    }

    await this.db.update(schema.mcpDefinitions).set(updates).where(eq(schema.mcpDefinitions.id, id));
    return (await this.getById(id))!;
  }

  async delete(id: number): Promise<void> {
    await this.db.delete(schema.runtimeInstances).where(eq(schema.runtimeInstances.mcpId, id));
    await this.db.delete(schema.workspaceMcpBindings).where(eq(schema.workspaceMcpBindings.mcpId, id));
    await this.db.delete(schema.mcpDefinitions).where(eq(schema.mcpDefinitions.id, id));
  }

  private toDto(row: typeof schema.mcpDefinitions.$inferSelect): McpDefinition {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      displayName: row.displayName,
      transportKind: row.transportKind as McpDefinition['transportKind'],
      instanceMode: row.instanceMode as McpDefinition['instanceMode'],
      configJson: JSON.parse(row.configJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
