import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as TOML from 'smol-toml';
import type { ClientProfile, McpEndpointInfo } from '../types.js';

export const codexProfile: ClientProfile = {
  clientType: 'codex',

  getConfigPath(workspaceRoot: string) {
    return path.join(workspaceRoot, '.codex', 'config.toml');
  },

  generateMcpConfig(endpoints: McpEndpointInfo[]) {
    const mcp_servers: Record<string, { url: string }> = {};
    for (const ep of endpoints) {
      mcp_servers[ep.name] = { url: ep.url };
    }
    return { mcp_servers };
  },

  async readExistingConfig(filePath: string) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return TOML.parse(content) as Record<string, unknown>;
    } catch {
      return {};
    }
  },

  async writeManagedConfig(filePath: string, mcpConfig: Record<string, unknown>) {
    const existing = await this.readExistingConfig(filePath);
    existing.mcp_servers = mcpConfig.mcp_servers;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, TOML.stringify(existing as any), 'utf-8');
  },
};
