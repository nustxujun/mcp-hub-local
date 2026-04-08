import type { ServerResponse } from 'node:http';
import type { InstanceMode } from '@mcp-hub-local/shared';
import type { RuntimeHandle } from '../runtime-pool.js';
import type { ToolSignatureEntry } from './ptc.js';

export type BackendStatus = 'starting' | 'running' | 'error';

export interface BackendEntry {
  mcpSlug: string;
  mcpId: number;
  mode: InstanceMode;
  runtimeKey: string;
  handle: RuntimeHandle | null;
  capabilities: any | null;
  remoteSessionId: string | null;
  status: BackendStatus;
  error: string | null;
}

export interface ClientInfo {
  name: string;
  version: string;
  userAgent: string;
  protocolVersion: string;
}

export interface AggregatedSession {
  sessionId: string;
  workspaceId: number;
  workspaceSlug: string;
  workspaceRootPath: string;
  backends: Map<string, BackendEntry>;  // key = mcpSlug
  cachedTools: any[] | null;
  cachedToolSignatures: ToolSignatureEntry[] | null;
  cachedResources: any[] | null;
  cachedPrompts: any[] | null;
  initialized: boolean;
  createdAt: number;  // Date.now() timestamp
  sseWriter: ServerResponse | null;  // SSE connection for pushing notifications
  clientInfo: ClientInfo | null;
}

export class SessionStore {
  private sessions = new Map<string, AggregatedSession>();
  private nextId = 1;

  create(workspaceId: number, workspaceSlug: string, rootPath: string): AggregatedSession {
    const sessionId = String(this.nextId++);
    const session: AggregatedSession = {
      sessionId,
      workspaceId,
      workspaceSlug,
      workspaceRootPath: rootPath,
      backends: new Map(),
      cachedTools: null,
      cachedToolSignatures: null,
      cachedResources: null,
      cachedPrompts: null,
      initialized: false,
      createdAt: Date.now(),
      sseWriter: null,
      clientInfo: null,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): AggregatedSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getByWorkspace(workspaceId: number): AggregatedSession[] {
    return [...this.sessions.values()].filter(s => s.workspaceId === workspaceId);
  }

  all(): AggregatedSession[] {
    return [...this.sessions.values()];
  }
}
