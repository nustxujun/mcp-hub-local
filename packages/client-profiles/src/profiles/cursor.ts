import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ClientProfile, McpEndpointInfo, RuleSyncContext } from '../types.js';
import { buildRuleBody } from '../marker.js';

export const cursorProfile: ClientProfile = {
  clientType: 'cursor',

  getConfigPath(workspaceRoot: string) {
    return path.join(workspaceRoot, '.cursor', 'mcp.json');
  },

  generateMcpConfig(endpoints: McpEndpointInfo[]) {
    const mcpServers: Record<string, { url: string }> = {};
    for (const ep of endpoints) {
      mcpServers[ep.name] = { url: ep.url };
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

  getRulePath(workspaceRoot: string) {
    return path.join(workspaceRoot, '.cursor', 'rules', 'mcp-hub-local.mdc');
  },

  async writeManagedRule(filePath: string, ctx: RuleSyncContext) {
    const body = buildRuleBody(ctx);
    const frontmatter = `---
description: MCP servers available via mcp-hub-local for this workspace
alwaysApply: true
---

`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, frontmatter + body, 'utf-8');
  },
};
