// ── Transport ──

export type TransportKind = 'stdio' | 'streamable-http';
export type InstanceMode = 'singleton' | 'per-workspace' | 'per-session';

export interface StdioTransportConfig {
  kind: 'stdio';
  instanceMode: InstanceMode;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface RemoteTransportConfig {
  kind: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
}

export type TransportConfig = StdioTransportConfig | RemoteTransportConfig;

// ── MCP Definition ──

export interface McpDefinition {
  id: number;
  name: string;
  slug: string;
  displayName: string;
  transportKind: TransportKind;
  instanceMode: InstanceMode;
  configJson: TransportConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMcpInput {
  name: string;
  slug?: string;
  displayName?: string;
  transportKind: TransportKind;
  instanceMode?: InstanceMode;
  configJson: TransportConfig;
}

export interface UpdateMcpInput {
  name?: string;
  slug?: string;
  displayName?: string;
  instanceMode?: InstanceMode;
  configJson?: TransportConfig;
}

// ── Workspace ──

export interface Workspace {
  id: number;
  name: string;
  slug: string;
  rootPath: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  rootPath: string;
  description?: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
  rootPath?: string;
  description?: string;
}

// ── Workspace MCP Binding ──

export interface WorkspaceMcpBinding {
  id: number;
  workspaceId: number;
  mcpId: number;
  enabled: boolean;
  instanceModeOverride: InstanceMode | null;
}

export interface SetBindingInput {
  mcpId: number;
  enabled?: boolean;
  instanceModeOverride?: InstanceMode | null;
}

// ── Runtime Instance ──

export type RuntimeStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export interface RuntimeInstance {
  id: number;
  mcpId: number;
  workspaceId: number | null;
  instanceMode: InstanceMode;
  pid: number | null;
  status: RuntimeStatus;
  startedAt: string;
  endedAt: string | null;
}

// ── Log ──

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  category: string;
  workspaceId: number | null;
  runtimeInstanceId: number | null;
  mcpId: number | null;
  sessionId: string | null;
  message: string;
  payloadPreview: string | null;
  payloadTruncated: boolean;
}

// ── Settings ──

export type ClientType = 'cursor' | 'claude' | 'codex' | 'gemini';

export interface SyncClientsSettings {
  clients: ClientType[];
}

export interface LogOptions {
  pageSize: number;
  retentionDays: number;
}

// ── API Pagination ──

export interface PaginatedResponse<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}
