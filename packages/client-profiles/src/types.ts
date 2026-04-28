import type { ClientType } from '@mcp-hub-local/shared';

export interface McpEndpointInfo {
  name: string;
  slug: string;
  url: string;
}

export interface RuleSyncContext {
  workspaceName: string;
  workspaceSlug: string;
  hubEndpointUrl: string;
  mcpNames: string[];
}

export interface ClientProfile {
  clientType: ClientType;
  getConfigPath(workspaceRoot: string): string;
  generateMcpConfig(endpoints: McpEndpointInfo[]): Record<string, unknown>;
  readExistingConfig(filePath: string): Promise<Record<string, unknown>>;
  writeManagedConfig(filePath: string, mcpConfig: Record<string, unknown>): Promise<void>;
  getRulePath(workspaceRoot: string): string;
  writeManagedRule(filePath: string, ctx: RuleSyncContext): Promise<void>;
}
