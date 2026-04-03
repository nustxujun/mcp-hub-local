import type { ClientType } from '@mcp-hub-local/shared';
import type { ClientProfile } from './types.js';
import { cursorProfile } from './profiles/cursor.js';
import { claudeProfile } from './profiles/claude.js';
import { codexProfile } from './profiles/codex.js';
import { geminiProfile } from './profiles/gemini.js';

const profiles: Record<ClientType, ClientProfile> = {
  cursor: cursorProfile,
  claude: claudeProfile,
  codex: codexProfile,
  gemini: geminiProfile,
};

export function getProfile(clientType: ClientType): ClientProfile {
  const profile = profiles[clientType];
  if (!profile) throw new Error(`Unknown client type: ${clientType}`);
  return profile;
}

export function getAllProfiles(): ClientProfile[] {
  return Object.values(profiles);
}
