import { spawn, type ChildProcess } from 'node:child_process';
import { eq, and, ne } from 'drizzle-orm';
import { schema, type HubDatabase } from '../db/index.js';
import type { McpDefinition, InstanceMode, StdioTransportConfig } from '@mcp-hub-local/shared';
import type { LogService } from './log.js';
import { Readable, Writable } from 'node:stream';

export interface RuntimeHandle {
  instanceId: number;
  mcpId: number;
  workspaceId: number | null;
  mode: InstanceMode;
  stdin: Writable | null;
  stdout: Readable | null;
  process: ChildProcess | null;
  remoteUrl: string | null;
  remoteHeaders: Record<string, string>;
  /** Queue to serialize requests to the same stdio process. */
  _requestQueue?: Promise<any>;
}

export class RuntimePoolService {
  private handles = new Map<string, RuntimeHandle>();
  // Reference counting for shared instances (singleton / per-workspace)
  private refCounts = new Map<string, number>();

  constructor(
    private db: HubDatabase,
    private logService: LogService,
  ) {
    // On startup, clean up all instances from previous server processes
    // — they no longer have live processes and their status is stale.
    this.db.delete(schema.runtimeInstances).run();
  }

  private instanceKey(mcpId: number, mode: InstanceMode, workspaceId?: number | null, sessionId?: string | null): string {
    switch (mode) {
      case 'singleton':
        return `mcp:${mcpId}`;
      case 'per-workspace':
        return `mcp:${mcpId}:ws:${workspaceId}`;
      case 'per-session':
        return `mcp:${mcpId}:session:${sessionId}`;
    }
  }

  async getOrCreate(
    mcp: McpDefinition,
    mode: InstanceMode,
    workspaceId: number | null,
    cwd?: string,
    sessionId?: string | null,
  ): Promise<RuntimeHandle> {
    const key = this.instanceKey(mcp.id, mode, workspaceId, sessionId);
    const existing = this.handles.get(key);
    if (existing) return existing;

    if (mcp.transportKind === 'streamable-http') {
      return this.createRemoteHandle(mcp, key, workspaceId);
    }

    return this.createStdioHandle(mcp, mode, key, workspaceId, cwd);
  }

  /** Update the status of a runtime instance in the database. */
  async updateInstanceStatus(instanceId: number, status: string): Promise<void> {
    const updates: Record<string, any> = { status };
    if (status === 'stopped' || status === 'error') {
      updates.endedAt = new Date().toISOString();
    }
    await this.db.update(schema.runtimeInstances)
      .set(updates)
      .where(eq(schema.runtimeInstances.id, instanceId));
  }

  private async createRemoteHandle(mcp: McpDefinition, key: string, workspaceId: number | null): Promise<RuntimeHandle> {
    const config = mcp.configJson as { url: string; headers?: Record<string, string> };

    const now = new Date().toISOString();
    const result = await this.db.insert(schema.runtimeInstances).values({
      mcpId: mcp.id,
      workspaceId,
      instanceMode: 'singleton',
      pid: null,
      status: 'running',
      startedAt: now,
    }).returning();

    const handle: RuntimeHandle = {
      instanceId: result[0].id,
      mcpId: mcp.id,
      workspaceId,
      mode: 'singleton',
      stdin: null,
      stdout: null,
      process: null,
      remoteUrl: config.url,
      remoteHeaders: config.headers || {},
    };

    this.handles.set(key, handle);
    return handle;
  }

  private async createStdioHandle(
    mcp: McpDefinition,
    mode: InstanceMode,
    key: string,
    workspaceId: number | null,
    cwd?: string,
  ): Promise<RuntimeHandle> {
    const config = mcp.configJson as StdioTransportConfig;

    const child = spawn(config.command, config.args || [], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...(config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const now = new Date().toISOString();
    const result = await this.db.insert(schema.runtimeInstances).values({
      mcpId: mcp.id,
      workspaceId,
      instanceMode: mode,
      pid: child.pid ?? null,
      status: 'starting',
      startedAt: now,
    }).returning();

    const instanceId = result[0].id;

    child.stderr?.on('data', (data: Buffer) => {
      this.logService.append({
        level: 'warn',
        category: 'stdio-stderr',
        mcpId: mcp.id,
        workspaceId,
        runtimeInstanceId: instanceId,
        message: data.toString('utf-8').trimEnd(),
      });
    });

    child.on('error', (err) => {
      this.handles.delete(key);
      this.db.update(schema.runtimeInstances)
        .set({ status: 'error', endedAt: new Date().toISOString() })
        .where(eq(schema.runtimeInstances.id, instanceId))
        .run();

      this.logService.append({
        level: 'error',
        category: 'stdio-lifecycle',
        mcpId: mcp.id,
        workspaceId,
        runtimeInstanceId: instanceId,
        message: `Process spawn error: ${err.message}`,
      });
    });

    child.on('exit', (code, signal) => {
      this.handles.delete(key);
      this.db.update(schema.runtimeInstances)
        .set({ status: code === 0 ? 'stopped' : 'error', endedAt: new Date().toISOString() })
        .where(eq(schema.runtimeInstances.id, instanceId))
        .run();

      this.logService.append({
        level: code === 0 ? 'info' : 'error',
        category: 'stdio-lifecycle',
        mcpId: mcp.id,
        workspaceId,
        runtimeInstanceId: instanceId,
        message: `Process exited with code=${code} signal=${signal}`,
      });
    });

    const handle: RuntimeHandle = {
      instanceId,
      mcpId: mcp.id,
      workspaceId,
      mode,
      stdin: child.stdin,
      stdout: child.stdout,
      process: child,
      remoteUrl: null,
      remoteHeaders: {},
    };

    this.handles.set(key, handle);

    await this.logService.append({
      level: 'info',
      category: 'stdio-lifecycle',
      mcpId: mcp.id,
      workspaceId,
      runtimeInstanceId: instanceId,
      message: `Started stdio process pid=${child.pid} mode=${mode} command=${config.command}`,
    });

    return handle;
  }

  async stop(key: string): Promise<void> {
    const handle = this.handles.get(key);
    if (!handle) return;

    // Proactively mark DB record as stopped (don't rely solely on async exit callback)
    await this.updateInstanceStatus(handle.instanceId, 'stopped');

    if (handle.process) {
      handle.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          handle.process?.kill('SIGKILL');
          resolve();
        }, 5000);
        handle.process?.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    this.handles.delete(key);
  }

  async stopAll(): Promise<void> {
    const keys = [...this.handles.keys()];
    for (const key of keys) {
      await this.stop(key);
    }
  }

  /** Stop a per-workspace instance by mcpId + workspaceId. */
  async stopForWorkspace(mcpId: number, workspaceId: number): Promise<void> {
    const key = this.instanceKey(mcpId, 'per-workspace', workspaceId);
    await this.stop(key);
  }

  /** Stop a per-session instance by mcpId + sessionId. */
  async stopForSession(mcpId: number, sessionId: string): Promise<void> {
    const key = this.instanceKey(mcpId, 'per-session', null, sessionId);
    await this.stop(key);
  }

  /** Get the instance key for external use (e.g. aggregator). */
  getInstanceKey(mcpId: number, mode: InstanceMode, workspaceId?: number | null, sessionId?: string | null): string {
    return this.instanceKey(mcpId, mode, workspaceId, sessionId);
  }

  /** Get a handle by its key. */
  getHandle(key: string): RuntimeHandle | undefined {
    return this.handles.get(key);
  }

  // ── Reference counting ──

  incrementRef(key: string): number {
    const count = (this.refCounts.get(key) || 0) + 1;
    this.refCounts.set(key, count);
    return count;
  }

  decrementRef(key: string): number {
    const count = Math.max(0, (this.refCounts.get(key) || 0) - 1);
    if (count === 0) {
      this.refCounts.delete(key);
    } else {
      this.refCounts.set(key, count);
    }
    return count;
  }

  getRefCount(key: string): number {
    return this.refCounts.get(key) || 0;
  }

  // ── JSON-RPC over stdio ──

  /**
   * Send a JSON-RPC message to a stdio handle and wait for the matching response (by id).
   * For notifications (no id), fire-and-forget.
   */
  async sendJsonRpc(handle: RuntimeHandle, message: object, timeoutMs = 300000): Promise<object | null> {
    const msg = message as { id?: number | string; method?: string };

    if (handle.remoteUrl) {
      return this.sendJsonRpcRemote(handle, message, timeoutMs);
    }

    if (!handle.stdin || !handle.stdout) {
      throw new Error('Stdio process not available');
    }

    const jsonStr = JSON.stringify(message) + '\n';
    const isNotification = msg.id === undefined || msg.id === null;

    if (isNotification) {
      return new Promise((resolve, reject) => {
        handle.stdin!.write(jsonStr, (err) => {
          if (err) reject(err);
          else resolve(null);
        });
      });
    }

    // Queue requests per handle so they run serially.
    // This ensures durationMs reflects actual execution time, not queue wait.
    const prev = handle._requestQueue ?? Promise.resolve();
    const task = prev.catch(() => {}).then(() => this._doSendJsonRpc(handle, jsonStr, msg.id!, timeoutMs));
    handle._requestQueue = task;
    return task;
  }

  private _doSendJsonRpc(handle: RuntimeHandle, jsonStr: string, id: number | string, timeoutMs: number): Promise<object> {
    return new Promise<object>((resolve, reject) => {
      const timeout = setTimeout(() => {
        handle.stdout!.removeListener('data', onData);
        reject(new Error(`JSON-RPC timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      let buf = '';
      let writeTime = 0;
      const onData = (data: Buffer) => {
        buf += data.toString('utf-8');
        const lines = buf.split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              clearTimeout(timeout);
              handle.stdout!.removeListener('data', onData);
              parsed._rpcDurationMs = writeTime > 0 ? Date.now() - writeTime : undefined;
              resolve(parsed);
              return;
            }
          } catch {
            // partial JSON, continue
          }
        }
        buf = lines[lines.length - 1];
      };

      handle.stdout!.on('data', onData);
      handle.stdin!.write(jsonStr, (err) => {
        if (err) {
          clearTimeout(timeout);
          handle.stdout!.removeListener('data', onData);
          reject(err);
        }
        writeTime = Date.now();
      });
    });
  }

  private async sendJsonRpcRemote(handle: RuntimeHandle, message: object, timeoutMs: number): Promise<object | null> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...handle.remoteHeaders,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(handle.remoteUrl!, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const msg = message as { id?: number | string };
      if (msg.id === undefined || msg.id === null) {
        return null; // notification
      }

      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /** Stop all running instances for a specific MCP and clean up old DB records. */
  async stopByMcpId(mcpId: number): Promise<void> {
    const keys = [...this.handles.entries()]
      .filter(([, h]) => h.mcpId === mcpId)
      .map(([k]) => k);
    for (const key of keys) {
      await this.stop(key);
    }
    // Remove stopped/error records for this MCP so they don't pile up
    this.db.delete(schema.runtimeInstances)
      .where(
        and(
          eq(schema.runtimeInstances.mcpId, mcpId),
          ne(schema.runtimeInstances.status, 'running'),
          ne(schema.runtimeInstances.status, 'starting'),
        )
      )
      .run();
  }

  listHandles(): RuntimeHandle[] {
    return [...this.handles.values()];
  }

  /** Delete a specific instance record (only allowed for error status). */
  async deleteInstance(id: number): Promise<boolean> {
    const rows = await this.db.select().from(schema.runtimeInstances)
      .where(eq(schema.runtimeInstances.id, id));
    if (!rows.length || rows[0].status !== 'error') return false;
    this.db.delete(schema.runtimeInstances)
      .where(eq(schema.runtimeInstances.id, id))
      .run();
    return true;
  }

  /** List active instances (starting, running, error). Excludes cleanly stopped. */
  async listInstances() {
    return this.db.select().from(schema.runtimeInstances)
      .where(ne(schema.runtimeInstances.status, 'stopped'));
  }

  /** List all instances including historical stopped/error ones. */
  async listAllInstances() {
    return this.db.select().from(schema.runtimeInstances);
  }

  /** Start a singleton stdio instance and perform MCP initialize handshake. */
  async startAndInitialize(mcp: McpDefinition): Promise<RuntimeHandle> {
    const handle = await this.getOrCreate(mcp, 'singleton', null, undefined, null);

    if (handle.stdin && handle.stdout) {
      const initMsg = JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'local-mcp-hub', version: '0.1.0' },
        },
      }) + '\n';

      const ok = await new Promise<boolean>((resolve) => {
        let buf = '';
        const timeout = setTimeout(() => {
          handle.stdout!.removeListener('data', onData);
          resolve(false);
        }, 10000);

        const onData = (data: Buffer) => {
          buf += data.toString('utf-8');
          const lines = buf.split('\n');
          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.result) {
                clearTimeout(timeout);
                handle.stdout!.removeListener('data', onData);
                resolve(true);
                return;
              }
            } catch {}
          }
          buf = lines[lines.length - 1];
        };

        handle.stdout!.on('data', onData);
        handle.stdin!.write(initMsg, (err) => {
          if (err) {
            clearTimeout(timeout);
            handle.stdout!.removeListener('data', onData);
            resolve(false);
          }
        });
      });

      if (ok) {
        await this.updateInstanceStatus(handle.instanceId, 'running');
      }
    }

    return handle;
  }
}
