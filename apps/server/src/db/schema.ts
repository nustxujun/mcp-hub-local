import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull().unique(),
  rootPath: text('root_path').notNull().unique(),
  description: text('description').notNull().default(''),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const mcpDefinitions = sqliteTable('mcp_definitions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull().default(''),
  transportKind: text('transport_kind').notNull(), // 'stdio' | 'streamable-http'
  instanceMode: text('instance_mode').notNull().default('per-workspace'), // 'singleton' | 'per-workspace' | 'per-session' | 'per-session'
  configJson: text('config_json').notNull(), // JSON string
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

export const workspaceMcpBindings = sqliteTable('workspace_mcp_bindings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  mcpId: integer('mcp_id').notNull().references(() => mcpDefinitions.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  instanceModeOverride: text('instance_mode_override'), // nullable
});

export const runtimeInstances = sqliteTable('runtime_instances', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  mcpId: integer('mcp_id').notNull().references(() => mcpDefinitions.id, { onDelete: 'cascade' }),
  workspaceId: integer('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  instanceMode: text('instance_mode').notNull(),
  pid: integer('pid'),
  status: text('status').notNull().default('starting'), // 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
  startedAt: text('started_at').notNull().$defaultFn(() => new Date().toISOString()),
  endedAt: text('ended_at'),
});

export const logs = sqliteTable('logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').notNull().$defaultFn(() => new Date().toISOString()),
  level: text('level').notNull().default('info'),
  category: text('category').notNull().default('general'),
  workspaceId: integer('workspace_id'),
  runtimeInstanceId: integer('runtime_instance_id'),
  mcpId: integer('mcp_id'),
  sessionId: text('session_id'),
  message: text('message').notNull(),
  payloadPreview: text('payload_preview'),
  payloadTruncated: integer('payload_truncated', { mode: 'boolean' }).notNull().default(false),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});

export const toolCalls = sqliteTable('tool_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').notNull().$defaultFn(() => new Date().toISOString()),
  sessionId: text('session_id'),
  workspaceId: integer('workspace_id'),
  mcpId: integer('mcp_id'),
  mcpSlug: text('mcp_slug').notNull(),
  toolName: text('tool_name').notNull(),
  success: integer('success', { mode: 'boolean' }).notNull(),
  durationMs: integer('duration_ms').notNull(),
  requestSize: integer('request_size').notNull(),
  responseSize: integer('response_size').notNull(),
  error: text('error'),
  requestBody: text('request_body'),
  responseBody: text('response_body'),
});
