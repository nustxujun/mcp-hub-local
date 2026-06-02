export const MARKER_START = '<!-- mcp-hub-local:start -->';
export const MARKER_END = '<!-- mcp-hub-local:end -->';

export function applyManagedBlock(existing: string, managed: string): string {
  const block = `${MARKER_START}\n${managed.trim()}\n${MARKER_END}`;
  const re = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`);
  if (re.test(existing)) return existing.replace(re, block);
  if (existing.trim().length === 0) return `${block}\n`;
  return `${existing.replace(/\s+$/, '')}\n\n${block}\n`;
}

export interface RuleBodyInput {
  workspaceName: string;
  hubEndpointUrl: string;
  mcpNames: string[];
}

export function buildRuleBody(input: RuleBodyInput): string {
  const { mcpNames } = input;

  if (mcpNames.length === 0) {
    return `# Available MCP Tools (via mcp-hub-local)

> Auto-generated. Do not edit; overwritten on next sync.

The \`mcp-hub-local\` proxy currently has no downstream MCP tools bound to this workspace.
`;
  }

  const list = mcpNames.map(n => `- ${n}`).join('\n');

  return `# Available MCP Tools (via mcp-hub-local)

> Auto-generated. Do not edit; overwritten on next sync.

The \`mcp-hub-local\` proxy exposes only these MCP tools — do not assume any others exist:

${list}
`;
}
