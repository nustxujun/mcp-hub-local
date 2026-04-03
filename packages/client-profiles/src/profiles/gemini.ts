import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ClientProfile, McpEndpointInfo } from '../types.js';

export const geminiProfile: ClientProfile = {
  clientType: 'gemini',

  getConfigPath(workspaceRoot: string) {
    return path.join(workspaceRoot, '.gemini', 'settings.json');
  },

  generateMcpConfig(endpoints: McpEndpointInfo[]) {
    const mcpServers: Record<string, { httpUrl: string }> = {};
    for (const ep of endpoints) {
      mcpServers[ep.name] = { httpUrl: ep.url };
    }
    return { mcpServers };
  },

  async readExistingConfig(filePath: string) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  },

  async writeManagedConfig(filePath: string, mcpConfig: Record<string, unknown>) {
    const existing = await this.readExistingConfig(filePath);
    existing.mcpServers = mcpConfig.mcpServers;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(existing, null, 2), 'utf-8');
  },
};
