import type { InstanceMode, McpDefinition } from '@mcp-hub-local/shared';
import type { RuntimePoolService } from '../runtime-pool.js';
import type { WorkspaceService } from '../workspace.js';
import type { McpRegistryService } from '../mcp-registry.js';
import type { LogService } from '../log.js';
import { SessionStore, type AggregatedSession, type BackendEntry, type BackendStatus } from './session-store.js';
import { prefixName, parsePrefixedName } from './name-mapper.js';

export class McpAggregator {
  constructor(
    private sessionStore: SessionStore,
    private runtimePool: RuntimePoolService,
    private workspaceService: WorkspaceService,
    private registry: McpRegistryService,
    private logService: LogService,
  ) {}

  // ── Protocol: initialize ──

  async handleInitialize(
    workspaceSlug: string,
    id: number | string,
    params: any,
    userAgent?: string,
  ): Promise<{ response: object; sessionId: string }> {
    const workspace = await this.workspaceService.getBySlug(workspaceSlug);
    if (!workspace) {
      return {
        sessionId: '',
        response: {
          jsonrpc: '2.0',
          id,
          error: { code: -32001, message: `Workspace not found: ${workspaceSlug}` },
        },
      };
    }

    const bindings = await this.workspaceService.getBindings(workspace.id);
    const enabledBindings = bindings.filter(b => b.enabled);

    const allMcps = await this.registry.list();
    const mcpMap = new Map(allMcps.map(m => [m.id, m]));

    const session = this.sessionStore.create(workspace.id, workspace.slug, workspace.rootPath);

    // Store client info from initialize params
    session.clientInfo = {
      name: params?.clientInfo?.name || 'unknown',
      version: params?.clientInfo?.version || '',
      userAgent: userAgent || '',
      protocolVersion: params?.protocolVersion || '',
    };

    // Pre-register all backends as "starting" so they appear immediately in the UI
    const toInit: { mcp: McpDefinition; mode: InstanceMode }[] = [];
    for (const binding of enabledBindings) {
      const mcp = mcpMap.get(binding.mcpId);
      if (!mcp) continue;
      const effectiveMode = (binding.instanceModeOverride || mcp.instanceMode) as InstanceMode;

      const runtimeKey = this.runtimePool.getInstanceKey(
        mcp.id, effectiveMode, workspace.id,
        effectiveMode === 'per-session' ? session.sessionId : null,
      );

      const placeholder: BackendEntry = {
        mcpSlug: mcp.slug,
        mcpId: mcp.id,
        mode: effectiveMode,
        runtimeKey,
        handle: null,
        capabilities: null,
        remoteSessionId: null,
        status: 'starting',
        error: null,
      };
      session.backends.set(mcp.slug, placeholder);
      toInit.push({ mcp, mode: effectiveMode });
    }

    session.initialized = true;

    // Return response immediately — backends will init in background
    const response = {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
        },
        serverInfo: {
          name: 'mcp-hub-local',
          version: '0.1.0',
        },
      },
    };

    await this.logService.append({
      level: 'info',
      category: 'aggregator',
      workspaceId: workspace.id,
      sessionId: session.sessionId,
      message: `Session ${session.sessionId} created with ${toInit.length} backends (initializing in background)`,
    });

    // Fire-and-forget: init each backend, push tools/list_changed after each one
    this.initBackendsIncrementally(session, toInit).catch(() => {});

    return { response, sessionId: session.sessionId };
  }

  /**
   * Initialize backends one-by-one (concurrently).
   * After each completes, clear cache and push tools/list_changed so the client
   * re-fetches with the newly available tools.
   */
  private async initBackendsIncrementally(
    session: AggregatedSession,
    items: { mcp: McpDefinition; mode: InstanceMode }[],
  ): Promise<void> {
    const promises = items.map(async ({ mcp, mode }) => {
      try {
        await this.initBackend(session, mcp, mode);
      } catch (err) {
        // Mark as error
        const entry = session.backends.get(mcp.slug);
        if (entry) {
          entry.status = 'error';
          entry.error = String(err);
        }
        this.logService.append({
          level: 'error',
          category: 'aggregator',
          mcpId: mcp.id,
          workspaceId: session.workspaceId,
          sessionId: session.sessionId,
          message: `Failed to initialize backend ${mcp.slug}: ${err}`,
        });
      }
      // After each backend finishes (success or error), invalidate caches and notify
      session.cachedTools = null;
      session.cachedResources = null;
      session.cachedPrompts = null;
      this.pushToolsListChanged(session);
    });

    await Promise.allSettled(promises);
  }

  private async initBackend(
    session: AggregatedSession,
    mcp: McpDefinition,
    mode: InstanceMode,
  ): Promise<void> {
    const runtimeKey = this.runtimePool.getInstanceKey(
      mcp.id, mode, session.workspaceId,
      mode === 'per-session' ? session.sessionId : null,
    );

    const handle = await this.runtimePool.getOrCreate(
      mcp, mode, session.workspaceId,
      session.workspaceRootPath,
      mode === 'per-session' ? session.sessionId : null,
    );

    // Increment ref for shared modes
    if (mode !== 'per-session') {
      this.runtimePool.incrementRef(runtimeKey);
    }

    // Send initialize
    const initId = Date.now() + Math.floor(Math.random() * 10000);
    const initResponse = await this.runtimePool.sendJsonRpc(handle, {
      jsonrpc: '2.0',
      method: 'initialize',
      id: initId,
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-hub-local', version: '0.1.0' },
      },
    }, 10000) as any;

    // Send initialized notification
    await this.runtimePool.sendJsonRpc(handle, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    // Mark as running
    await this.runtimePool.updateInstanceStatus(handle.instanceId, 'running');

    const capabilities = initResponse?.result?.capabilities || null;

    // Update existing placeholder entry (or create if missing)
    const existing = session.backends.get(mcp.slug);
    if (existing) {
      existing.handle = handle;
      existing.runtimeKey = runtimeKey;
      existing.capabilities = capabilities;
      existing.status = 'running';
      existing.error = null;
    } else {
      const entry: BackendEntry = {
        mcpSlug: mcp.slug,
        mcpId: mcp.id,
        mode,
        runtimeKey,
        handle,
        capabilities,
        remoteSessionId: null,
        status: 'running',
        error: null,
      };
      session.backends.set(mcp.slug, entry);
    }
  }

  private pushToolsListChanged(session: AggregatedSession): void {
    if (session.sseWriter && !session.sseWriter.destroyed) {
      try {
        const notification = JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
        });
        session.sseWriter.write(`event: message\ndata: ${notification}\n\n`);
      } catch {
        // SSE write failed, ignore
      }
    }
  }

  // ── Protocol: notifications ──

  async handleNotification(sessionId: string, method: string, params?: any): Promise<void> {
    const session = this.sessionStore.get(sessionId);
    if (!session) return;

    // Broadcast notification to all running backends
    for (const [, backend] of session.backends) {
      if (backend.status !== 'running' || !backend.handle) continue;
      try {
        await this.runtimePool.sendJsonRpc(backend.handle, {
          jsonrpc: '2.0',
          method,
          ...(params !== undefined ? { params } : {}),
        });
      } catch {
        // swallow
      }
    }
  }

  // ── Protocol: requests ──

  async handleRequest(
    sessionId: string,
    method: string,
    id: number | string,
    params?: any,
  ): Promise<object> {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: `Session not found: ${sessionId}` },
      };
    }

    switch (method) {
      case 'tools/list':
        return this.handleToolsList(session, id, params);
      case 'tools/call':
        return this.handleToolsCall(session, id, params);
      case 'resources/list':
        return this.handleResourcesList(session, id, params);
      case 'resources/read':
        return this.handleResourcesRead(session, id, params);
      case 'prompts/list':
        return this.handlePromptsList(session, id, params);
      case 'prompts/get':
        return this.handlePromptsGet(session, id, params);
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  // ── tools/list ──

  private async handleToolsList(session: AggregatedSession, id: number | string, params?: any): Promise<object> {
    if (session.cachedTools) {
      return { jsonrpc: '2.0', id, result: { tools: session.cachedTools } };
    }

    const allTools: any[] = [];
    const fanoutId = Date.now();

    const promises = [...session.backends.entries()].map(async ([slug, backend]) => {
      if (backend.status !== 'running' || !backend.handle) return [];
      try {
        const reqId = fanoutId + Math.floor(Math.random() * 100000);
        const response = await this.runtimePool.sendJsonRpc(backend.handle, {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: reqId,
          params: params || {},
        }, 5000) as any;

        const tools = response?.result?.tools || [];
        return tools.map((tool: any) => ({
          ...tool,
          name: prefixName(slug, tool.name),
          description: tool.description ? `[${slug}] ${tool.description}` : `[${slug}]`,
        }));
      } catch (err) {
        this.logService.append({
          level: 'error',
          category: 'aggregator-fanout',
          mcpId: backend.mcpId,
          workspaceId: session.workspaceId,
          sessionId: session.sessionId,
          message: `tools/list fanout failed for ${slug}: ${err}`,
        });
        return [];
      }
    });

    const results = await Promise.allSettled(promises);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allTools.push(...result.value);
      }
    }

    session.cachedTools = allTools;
    return { jsonrpc: '2.0', id, result: { tools: allTools } };
  }

  // ── tools/call ──

  private async handleToolsCall(session: AggregatedSession, id: number | string, params: any): Promise<object> {
    if (!params?.name) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tool name' } };
    }

    let mcpSlug: string;
    let originalName: string;

    try {
      const parsed = parsePrefixedName(params.name);
      mcpSlug = parsed.mcpSlug;
      originalName = parsed.name;
    } catch {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Invalid tool name: ${params.name}` } };
    }

    const backend = session.backends.get(mcpSlug);
    if (!backend) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Backend not found: ${mcpSlug}` } };
    }
    if (backend.status !== 'running' || !backend.handle) {
      return { jsonrpc: '2.0', id, error: { code: -32002, message: `Backend not ready: ${mcpSlug} (${backend.status})` } };
    }

    await this.logService.append({
      level: 'debug',
      category: 'aggregator-call',
      mcpId: backend.mcpId,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      message: `→ tools/call ${mcpSlug}::${originalName}`,
    });

    try {
      const callId = Date.now() + Math.floor(Math.random() * 100000);
      const response = await this.runtimePool.sendJsonRpc(backend.handle, {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: callId,
        params: {
          name: originalName,
          arguments: params.arguments || {},
        },
      }, 30000) as any;

      // Rewrite the response with the aggregator's request id
      if (response?.result !== undefined) {
        return { jsonrpc: '2.0', id, result: response.result };
      }
      if (response?.error) {
        return { jsonrpc: '2.0', id, error: response.error };
      }
      return { jsonrpc: '2.0', id, result: response?.result ?? {} };
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: `Backend call failed: ${err}` } };
    }
  }

  // ── resources/list ──

  private async handleResourcesList(session: AggregatedSession, id: number | string, params?: any): Promise<object> {
    if (session.cachedResources) {
      return { jsonrpc: '2.0', id, result: { resources: session.cachedResources } };
    }

    const allResources: any[] = [];
    const fanoutId = Date.now();

    const promises = [...session.backends.entries()].map(async ([slug, backend]) => {
      if (backend.status !== 'running' || !backend.handle) return [];
      if (!backend.capabilities?.resources) return [];
      try {
        const response = await this.runtimePool.sendJsonRpc(backend.handle, {
          jsonrpc: '2.0',
          method: 'resources/list',
          id: fanoutId + Math.floor(Math.random() * 100000),
          params: params || {},
        }, 5000) as any;

        const resources = response?.result?.resources || [];
        return resources.map((r: any) => ({
          ...r,
          name: prefixName(slug, r.name),
          description: r.description ? `[${slug}] ${r.description}` : `[${slug}]`,
        }));
      } catch {
        return [];
      }
    });

    const results = await Promise.allSettled(promises);
    for (const result of results) {
      if (result.status === 'fulfilled') allResources.push(...result.value);
    }

    session.cachedResources = allResources;
    return { jsonrpc: '2.0', id, result: { resources: allResources } };
  }

  // ── resources/read ──

  private async handleResourcesRead(session: AggregatedSession, id: number | string, params: any): Promise<object> {
    if (!params?.uri) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing resource uri' } };
    }

    // Try to find the backend from the resource name
    // Resources might be referenced by URI, which doesn't have our prefix.
    // We'll try all backends.
    for (const [, backend] of session.backends) {
      if (backend.status !== 'running' || !backend.handle) continue;
      if (!backend.capabilities?.resources) continue;
      try {
        const callId = Date.now() + Math.floor(Math.random() * 100000);
        const response = await this.runtimePool.sendJsonRpc(backend.handle, {
          jsonrpc: '2.0',
          method: 'resources/read',
          id: callId,
          params,
        }, 10000) as any;

        if (response?.result) {
          return { jsonrpc: '2.0', id, result: response.result };
        }
      } catch {
        continue;
      }
    }

    return { jsonrpc: '2.0', id, error: { code: -32602, message: `Resource not found: ${params.uri}` } };
  }

  // ── prompts/list ──

  private async handlePromptsList(session: AggregatedSession, id: number | string, params?: any): Promise<object> {
    if (session.cachedPrompts) {
      return { jsonrpc: '2.0', id, result: { prompts: session.cachedPrompts } };
    }

    const allPrompts: any[] = [];
    const fanoutId = Date.now();

    const promises = [...session.backends.entries()].map(async ([slug, backend]) => {
      if (backend.status !== 'running' || !backend.handle) return [];
      if (!backend.capabilities?.prompts) return [];
      try {
        const response = await this.runtimePool.sendJsonRpc(backend.handle, {
          jsonrpc: '2.0',
          method: 'prompts/list',
          id: fanoutId + Math.floor(Math.random() * 100000),
          params: params || {},
        }, 5000) as any;

        const prompts = response?.result?.prompts || [];
        return prompts.map((p: any) => ({
          ...p,
          name: prefixName(slug, p.name),
          description: p.description ? `[${slug}] ${p.description}` : `[${slug}]`,
        }));
      } catch {
        return [];
      }
    });

    const results = await Promise.allSettled(promises);
    for (const result of results) {
      if (result.status === 'fulfilled') allPrompts.push(...result.value);
    }

    session.cachedPrompts = allPrompts;
    return { jsonrpc: '2.0', id, result: { prompts: allPrompts } };
  }

  // ── prompts/get ──

  private async handlePromptsGet(session: AggregatedSession, id: number | string, params: any): Promise<object> {
    if (!params?.name) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing prompt name' } };
    }

    let mcpSlug: string;
    let originalName: string;

    try {
      const parsed = parsePrefixedName(params.name);
      mcpSlug = parsed.mcpSlug;
      originalName = parsed.name;
    } catch {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Invalid prompt name: ${params.name}` } };
    }

    const backend = session.backends.get(mcpSlug);
    if (!backend) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Backend not found: ${mcpSlug}` } };
    }
    if (backend.status !== 'running' || !backend.handle) {
      return { jsonrpc: '2.0', id, error: { code: -32002, message: `Backend not ready: ${mcpSlug} (${backend.status})` } };
    }

    try {
      const callId = Date.now() + Math.floor(Math.random() * 100000);
      const response = await this.runtimePool.sendJsonRpc(backend.handle, {
        jsonrpc: '2.0',
        method: 'prompts/get',
        id: callId,
        params: { name: originalName, arguments: params.arguments || {} },
      }, 10000) as any;

      if (response?.result !== undefined) {
        return { jsonrpc: '2.0', id, result: response.result };
      }
      if (response?.error) {
        return { jsonrpc: '2.0', id, error: response.error };
      }
      return { jsonrpc: '2.0', id, error: { code: -32603, message: 'No result from backend' } };
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: `Backend call failed: ${err}` } };
    }
  }

  // ── Lifecycle: destroy session ──

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessionStore.get(sessionId);
    if (!session) return;

    const workspaceId = session.workspaceId;
    await this.tearDownAllBackends(session);

    this.sessionStore.delete(sessionId);

    await this.logService.append({
      level: 'info',
      category: 'aggregator',
      workspaceId,
      sessionId,
      message: `Session ${sessionId} destroyed`,
    });
  }

  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  // ── Restart a single session: tear down all backends, re-read bindings, re-init ──

  async restartSession(sessionId: string): Promise<boolean> {
    const session = this.sessionStore.get(sessionId);
    if (!session) return false;

    // 1. Tear down all current backends
    await this.tearDownAllBackends(session);

    // 2. Re-read workspace bindings
    const bindings = await this.workspaceService.getBindings(session.workspaceId);
    const enabledBindings = bindings.filter(b => b.enabled);
    const allMcps = await this.registry.list();
    const mcpMap = new Map(allMcps.map(m => [m.id, m]));

    // 3. Pre-register as starting
    const toInit: { mcp: McpDefinition; mode: InstanceMode }[] = [];
    for (const binding of enabledBindings) {
      const mcp = mcpMap.get(binding.mcpId);
      if (!mcp) continue;
      const mode = (binding.instanceModeOverride || mcp.instanceMode) as InstanceMode;
      const runtimeKey = this.runtimePool.getInstanceKey(
        mcp.id, mode, session.workspaceId,
        mode === 'per-session' ? session.sessionId : null,
      );
      session.backends.set(mcp.slug, {
        mcpSlug: mcp.slug, mcpId: mcp.id, mode, runtimeKey,
        handle: null, capabilities: null, remoteSessionId: null,
        status: 'starting', error: null,
      });
      toInit.push({ mcp, mode });
    }

    // 4. Clear caches
    session.cachedTools = null;
    session.cachedResources = null;
    session.cachedPrompts = null;

    await this.logService.append({
      level: 'info',
      category: 'aggregator',
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      message: `Session ${sessionId} restarting with ${toInit.length} backends`,
    });

    // 5. Init incrementally (push tools/list_changed after each)
    this.initBackendsIncrementally(session, toInit).catch(() => {});
    return true;
  }

  /** Tear down all backends of a session, releasing refs properly. */
  private async tearDownAllBackends(session: AggregatedSession): Promise<void> {
    for (const [slug, backend] of session.backends) {
      if (backend.handle) {
        try {
          switch (backend.mode) {
            case 'per-session':
              await this.runtimePool.stop(backend.runtimeKey);
              break;
            case 'per-workspace': {
              const remaining = this.runtimePool.decrementRef(backend.runtimeKey);
              if (remaining === 0) await this.runtimePool.stop(backend.runtimeKey);
              break;
            }
            case 'singleton':
              this.runtimePool.decrementRef(backend.runtimeKey);
              break;
          }
        } catch { /* swallow */ }
      }
    }
    session.backends.clear();
  }

  // ── MCP config changed: stop old instances, refresh all affected sessions ──

  async onMcpConfigChanged(mcpId: number): Promise<void> {
    await this.restartMcpInstances(mcpId);

    await this.logService.append({
      level: 'info',
      category: 'aggregator',
      message: `MCP ${mcpId} config changed — restarted affected backends`,
    });
  }

  // ── Restart all instances for a specific MCP without breaking other backends ──

  async restartMcpInstances(mcpId: number): Promise<void> {
    // 1. Stop all running instances for this MCP
    await this.runtimePool.stopByMcpId(mcpId);

    // 2. Get the latest MCP definition
    const mcp = await this.registry.getById(mcpId);
    if (!mcp) return;

    // 3. Collect all affected backends across sessions
    const allSessions = this.sessionStore.all();
    const affected: { session: AggregatedSession; slug: string; backend: BackendEntry }[] = [];

    for (const session of allSessions) {
      for (const [slug, backend] of session.backends) {
        if (backend.mcpId !== mcpId) continue;

        // Decrement ref to compensate for the previous initBackend's incrementRef
        if (backend.mode !== 'per-session') {
          this.runtimePool.decrementRef(backend.runtimeKey);
        }

        // Reset backend state
        backend.handle = null;
        backend.status = 'starting';
        backend.error = null;

        affected.push({ session, slug, backend });
      }
    }

    // 4. Re-init backends sequentially to avoid duplicate process spawns
    //    For shared modes (singleton/per-workspace), the first initBackend creates the process,
    //    subsequent ones reuse it via getOrCreate.
    for (const { session, slug, backend } of affected) {
      try {
        await this.initBackend(session, mcp, backend.mode);
      } catch (err) {
        backend.status = 'error';
        backend.error = String(err);
        this.logService.append({
          level: 'error',
          category: 'aggregator',
          mcpId: mcp.id,
          workspaceId: session.workspaceId,
          sessionId: session.sessionId,
          message: `Failed to restart backend ${slug}: ${err}`,
        });
      }
      // After each backend, invalidate caches and notify
      session.cachedTools = null;
      session.cachedResources = null;
      session.cachedPrompts = null;
      this.pushToolsListChanged(session);
    }

    // 5. For local MCPs, always ensure a singleton instance exists
    //    (even when no sessions are active, so the process stays warm)
    if (mcp.transportKind === 'stdio') {
      try {
        await this.runtimePool.startAndInitialize(mcp);
      } catch {
        // Non-fatal: will be started on next session connect
      }
    }

    await this.logService.append({
      level: 'info',
      category: 'aggregator',
      message: `MCP ${mcpId} instances restarted — re-initialized ${affected.length} backend(s)`,
    });
  }

  // ── Binding change: refresh all sessions for a workspace ──

  async refreshWorkspaceBindings(workspaceId: number): Promise<void> {
    const sessions = this.sessionStore.getByWorkspace(workspaceId);
    if (sessions.length === 0) return;

    // Fetch current state
    const bindings = await this.workspaceService.getBindings(workspaceId);
    const enabledBindings = bindings.filter(b => b.enabled);
    const allMcps = await this.registry.list();
    const mcpMap = new Map(allMcps.map(m => [m.id, m]));

    // Build slug→binding+mcp map for enabled MCPs
    const enabledMap = new Map<string, { mcp: McpDefinition; mode: InstanceMode }>();
    for (const binding of enabledBindings) {
      const mcp = mcpMap.get(binding.mcpId);
      if (!mcp) continue;
      const mode = (binding.instanceModeOverride || mcp.instanceMode) as InstanceMode;
      enabledMap.set(mcp.slug, { mcp, mode });
    }

    for (const session of sessions) {
      // 1. Remove backends that are no longer enabled
      for (const [slug, backend] of session.backends) {
        if (!enabledMap.has(slug)) {
          // Tear down ref
          try {
            if (backend.mode === 'per-session') {
              await this.runtimePool.stop(backend.runtimeKey);
            } else if (backend.mode === 'per-workspace') {
              const remaining = this.runtimePool.decrementRef(backend.runtimeKey);
              if (remaining === 0) await this.runtimePool.stop(backend.runtimeKey);
            } else {
              this.runtimePool.decrementRef(backend.runtimeKey);
            }
          } catch { /* swallow */ }
          session.backends.delete(slug);
        }
      }

      // 2. Add backends that are newly enabled
      for (const [slug, { mcp, mode }] of enabledMap) {
        if (!session.backends.has(slug)) {
          // Pre-register as starting
          const runtimeKey = this.runtimePool.getInstanceKey(
            mcp.id, mode, session.workspaceId,
            mode === 'per-session' ? session.sessionId : null,
          );
          const placeholder: BackendEntry = {
            mcpSlug: slug,
            mcpId: mcp.id,
            mode,
            runtimeKey,
            handle: null,
            capabilities: null,
            remoteSessionId: null,
            status: 'starting',
            error: null,
          };
          session.backends.set(slug, placeholder);

          // Init in background, push notification after each
          this.initBackend(session, mcp, mode)
            .catch((err) => {
              placeholder.status = 'error';
              placeholder.error = String(err);
              this.logService.append({
                level: 'error',
                category: 'aggregator',
                mcpId: mcp.id,
                workspaceId,
                sessionId: session.sessionId,
                message: `Failed to init backend ${slug} during refresh: ${err}`,
              });
            })
            .finally(() => {
              session.cachedTools = null;
              session.cachedResources = null;
              session.cachedPrompts = null;
              this.pushToolsListChanged(session);
            });
        }
      }

      // 3. Clear caches
      session.cachedTools = null;
      session.cachedResources = null;
      session.cachedPrompts = null;

      // 4. Push notifications/tools/list_changed via SSE (for removed backends)
      this.pushToolsListChanged(session);
    }

    await this.logService.append({
      level: 'info',
      category: 'aggregator',
      workspaceId,
      message: `Refreshed bindings for ${sessions.length} session(s), enabled MCPs: [${[...enabledMap.keys()].join(', ')}]`,
    });
  }
}
