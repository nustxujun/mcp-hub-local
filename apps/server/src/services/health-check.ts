import type { McpRegistryService } from './mcp-registry.js';

export interface HealthCheckResult {
  ok: boolean;
  status?: number;
  error?: string;
  checkedAt: string;
}

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export class HealthCheckService {
  private cache = new Map<number, HealthCheckResult>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private registry: McpRegistryService) {}

  /** Run a single round of health checks against all remote MCPs. */
  async runChecks(): Promise<void> {
    const allMcps = await this.registry.list();
    const remoteMcps = allMcps.filter(m => m.transportKind === 'streamable-http');
    const now = new Date().toISOString();

    await Promise.all(remoteMcps.map(async (mcp) => {
      try {
        const config = mcp.configJson as { url: string; headers?: Record<string, string> };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const response = await fetch(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...(config.headers || {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'initialize',
            id: 1,
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'mcp-hub-local-health', version: '0.1.0' },
            },
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        this.cache.set(mcp.id, { ok: response.ok, status: response.status, checkedAt: now });
      } catch (err: any) {
        this.cache.set(mcp.id, { ok: false, error: err.message, checkedAt: now });
      }
    }));

    // Mark stdio MCPs
    for (const mcp of allMcps) {
      if (mcp.transportKind === 'stdio') {
        this.cache.set(mcp.id, { ok: true, status: -1, checkedAt: now });
      }
    }

    // Remove entries for MCPs that no longer exist
    const validIds = new Set(allMcps.map(m => m.id));
    for (const id of this.cache.keys()) {
      if (!validIds.has(id)) {
        this.cache.delete(id);
      }
    }
  }

  /** Returns the cached health status for all MCPs. */
  getStatus(): Record<number, HealthCheckResult> {
    const result: Record<number, HealthCheckResult> = {};
    for (const [id, entry] of this.cache) {
      result[id] = entry;
    }
    return result;
  }

  /** Start periodic health checks (runs an initial check immediately). */
  start(): void {
    // Fire initial check without blocking startup
    this.runChecks().catch(() => {});
    this.timer = setInterval(() => {
      this.runChecks().catch(() => {});
    }, CHECK_INTERVAL_MS);
  }

  /** Stop periodic health checks. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
