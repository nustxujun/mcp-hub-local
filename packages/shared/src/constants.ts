export const DEFAULT_PORT = 3000;
export const MCP_PROXY_PREFIX = '/w';
export const API_PREFIX = '/api';
export const APP_PREFIX = '/app';

export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 64;
export const MAX_NAME_LENGTH = 128;

export const DEFAULT_INSTANCE_MODE = 'per-workspace' as const;

export const SUPPORTED_CLIENTS = ['cursor', 'claude', 'codex', 'gemini'] as const;

export const DEFAULT_LOG_PAGE_SIZE = 50;
export const DEFAULT_LOG_RETENTION_DAYS = 30;

export const MAX_PAYLOAD_PREVIEW_LENGTH = 2048;
