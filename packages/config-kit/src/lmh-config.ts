import type { TransportConfig, InstanceMode } from '@mcp-hub-local/shared';

export interface LmhMcpEntry {
  id: string;
  slug: string;
  name: string;
  transportKind: 'stdio' | 'streamable-http';
  transport: TransportConfig;
}

export interface LmhConfig {
  version: number;
  mcps: LmhMcpEntry[];
}

export function createDefaultConfig(): LmhConfig {
  return { version: 1, mcps: [] };
}
