import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ClientProfile, McpEndpointInfo, RuleSyncContext } from '../types.js';
import { buildRuleBody } from '../marker.js';
import { claudeProfile } from './claude.js';

export const codebuddyProfile: ClientProfile = {
  clientType: 'codebuddy',

  getConfigPath(workspaceRoot: string) {
    return claudeProfile.getConfigPath(workspaceRoot);
  },

  generateMcpConfig(endpoints: McpEndpointInfo[]) {
    return claudeProfile.generateMcpConfig(endpoints);
  },

  readExistingConfig(filePath: string) {
    return claudeProfile.readExistingConfig(filePath);
  },

  writeManagedConfig(filePath: string, mcpConfig: Record<string, unknown>) {
    return claudeProfile.writeManagedConfig(filePath, mcpConfig);
  },

  getRulePath(workspaceRoot: string) {
    return path.join(workspaceRoot, '.codebuddy', 'rules', 'mcp-hub-local.md');
  },

  async writeManagedRule(filePath: string, ctx: RuleSyncContext) {
    const body = buildRuleBody(ctx);
    const frontmatter = `---
description: MCP servers available via mcp-hub-local for this workspace
alwaysApply: true
enabled: true
---

`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, frontmatter + body, 'utf-8');
  },
};
