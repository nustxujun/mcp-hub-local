import type { TransportConfig } from '@mcp-hub-local/shared';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateStdioConfig(config: unknown): ValidationResult {
  const errors: string[] = [];
  const c = config as Record<string, unknown>;

  if (!c || typeof c !== 'object') {
    return { valid: false, errors: ['configJson must be an object'] };
  }

  if (typeof c.command !== 'string' || !c.command) {
    errors.push('stdio config requires a non-empty "command" string');
  }
  if (!Array.isArray(c.args)) {
    errors.push('stdio config requires an "args" array');
  }

  return { valid: errors.length === 0, errors };
}

export function validateRemoteConfig(config: unknown): ValidationResult {
  const errors: string[] = [];
  const c = config as Record<string, unknown>;

  if (!c || typeof c !== 'object') {
    return { valid: false, errors: ['configJson must be an object'] };
  }

  if (typeof c.url !== 'string' || !c.url) {
    errors.push('remote config requires a non-empty "url" string');
  }

  return { valid: errors.length === 0, errors };
}

export function validateTransportConfig(kind: string, config: unknown): ValidationResult {
  if (kind === 'stdio') return validateStdioConfig(config);
  if (kind === 'streamable-http') return validateRemoteConfig(config);
  return { valid: false, errors: [`Unknown transport kind: ${kind}`] };
}
