import { desc, eq, sql } from 'drizzle-orm';
import { schema, type HubDatabase } from '../db/index.js';

const MAX_BODY_LENGTH = 4096;

function truncate(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.length > MAX_BODY_LENGTH ? s.slice(0, MAX_BODY_LENGTH) : s;
}

export class StatsService {
  constructor(private db: HubDatabase) {}

  /** Record a tool call (fire-and-forget from aggregator). */
  record(entry: {
    sessionId?: string | null;
    workspaceId?: number | null;
    mcpId?: number | null;
    mcpSlug: string;
    toolName: string;
    success: boolean;
    durationMs: number;
    requestSize: number;
    responseSize: number;
    error?: string | null;
    requestBody?: string | null;
    responseBody?: string | null;
  }): void {
    // Fire-and-forget: don't block the caller
    this.db.insert(schema.toolCalls).values({
      timestamp: new Date().toISOString(),
      sessionId: entry.sessionId ?? null,
      workspaceId: entry.workspaceId ?? null,
      mcpId: entry.mcpId ?? null,
      mcpSlug: entry.mcpSlug,
      toolName: entry.toolName,
      success: entry.success,
      durationMs: entry.durationMs,
      requestSize: entry.requestSize,
      responseSize: entry.responseSize,
      error: entry.error ?? null,
      requestBody: truncate(entry.requestBody),
      responseBody: truncate(entry.responseBody),
    }).catch(() => { /* swallow */ });
  }

  /** Get stats grouped by tool (mcpSlug + toolName). */
  async getToolStats(params?: { mcpId?: number }) {
    const conditions = [];
    if (params?.mcpId) conditions.push(eq(schema.toolCalls.mcpId, params.mcpId));

    const where = conditions.length > 0 ? conditions[0] : undefined;

    const rows = await this.db.select({
      mcpSlug: schema.toolCalls.mcpSlug,
      toolName: schema.toolCalls.toolName,
      mcpId: schema.toolCalls.mcpId,
      totalCalls: sql<number>`COUNT(*)`,
      successCalls: sql<number>`SUM(${schema.toolCalls.success})`,
      failCalls: sql<number>`COUNT(*) - SUM(${schema.toolCalls.success})`,
      avgDurationMs: sql<number>`ROUND(AVG(${schema.toolCalls.durationMs}), 1)`,
      maxDurationMs: sql<number>`MAX(${schema.toolCalls.durationMs})`,
      avgRequestSize: sql<number>`ROUND(AVG(${schema.toolCalls.requestSize}), 0)`,
      maxRequestSize: sql<number>`MAX(${schema.toolCalls.requestSize})`,
      avgResponseSize: sql<number>`ROUND(AVG(${schema.toolCalls.responseSize}), 0)`,
      maxResponseSize: sql<number>`MAX(${schema.toolCalls.responseSize})`,
    })
      .from(schema.toolCalls)
      .where(where)
      .groupBy(schema.toolCalls.mcpSlug, schema.toolCalls.toolName);

    return rows;
  }

  /** Get stats grouped by MCP. */
  async getMcpStats() {
    const rows = await this.db.select({
      mcpSlug: schema.toolCalls.mcpSlug,
      mcpId: schema.toolCalls.mcpId,
      totalCalls: sql<number>`COUNT(*)`,
      successCalls: sql<number>`SUM(${schema.toolCalls.success})`,
      failCalls: sql<number>`COUNT(*) - SUM(${schema.toolCalls.success})`,
      avgDurationMs: sql<number>`ROUND(AVG(${schema.toolCalls.durationMs}), 1)`,
      maxDurationMs: sql<number>`MAX(${schema.toolCalls.durationMs})`,
      avgRequestSize: sql<number>`ROUND(AVG(${schema.toolCalls.requestSize}), 0)`,
      maxRequestSize: sql<number>`MAX(${schema.toolCalls.requestSize})`,
      avgResponseSize: sql<number>`ROUND(AVG(${schema.toolCalls.responseSize}), 0)`,
      maxResponseSize: sql<number>`MAX(${schema.toolCalls.responseSize})`,
    })
      .from(schema.toolCalls)
      .groupBy(schema.toolCalls.mcpSlug);

    return rows;
  }

  /** Get recent tool call records. */
  async getRecentCalls(limit = 20) {
    return this.db.select()
      .from(schema.toolCalls)
      .orderBy(desc(schema.toolCalls.id))
      .limit(limit);
  }

  /** Get worst-case calls for each tool: slowest, largest request, largest response. */
  async getWorstCaseByTool() {
    // For each (mcpSlug, toolName), get max durationMs, max requestSize, max responseSize
    const groups = await this.db.select({
      mcpSlug: schema.toolCalls.mcpSlug,
      toolName: schema.toolCalls.toolName,
      maxDuration: sql<number>`MAX(${schema.toolCalls.durationMs})`,
      maxRequestSize: sql<number>`MAX(${schema.toolCalls.requestSize})`,
      maxResponseSize: sql<number>`MAX(${schema.toolCalls.responseSize})`,
    })
      .from(schema.toolCalls)
      .groupBy(schema.toolCalls.mcpSlug, schema.toolCalls.toolName);

    const results: { mcpSlug: string; toolName: string; slowest: any; largestRequest: any; largestResponse: any }[] = [];

    for (const g of groups) {
      const findOne = async (column: any, value: number) => {
        const rows = await this.db.select()
          .from(schema.toolCalls)
          .where(sql`${schema.toolCalls.mcpSlug} = ${g.mcpSlug} AND ${schema.toolCalls.toolName} = ${g.toolName} AND ${column} = ${value}`)
          .limit(1);
        return rows[0] || null;
      };

      const [slowest, largestReq, largestResp] = await Promise.all([
        findOne(schema.toolCalls.durationMs, g.maxDuration),
        findOne(schema.toolCalls.requestSize, g.maxRequestSize),
        findOne(schema.toolCalls.responseSize, g.maxResponseSize),
      ]);

      results.push({
        mcpSlug: g.mcpSlug,
        toolName: g.toolName,
        slowest,
        largestRequest: largestReq,
        largestResponse: largestResp,
      });
    }
    return results;
  }

  /** Get overall summary. */
  async getSummary() {
    const rows = await this.db.select({
      totalCalls: sql<number>`COUNT(*)`,
      successCalls: sql<number>`SUM(${schema.toolCalls.success})`,
      failCalls: sql<number>`COUNT(*) - SUM(${schema.toolCalls.success})`,
      avgDurationMs: sql<number>`ROUND(AVG(${schema.toolCalls.durationMs}), 1)`,
      maxDurationMs: sql<number>`MAX(${schema.toolCalls.durationMs})`,
    }).from(schema.toolCalls);

    const row = rows[0] || { totalCalls: 0, successCalls: 0, failCalls: 0, avgDurationMs: 0, maxDurationMs: 0 };
    return {
      totalCalls: row.totalCalls || 0,
      successCalls: row.successCalls || 0,
      failCalls: row.failCalls || 0,
      successRate: row.totalCalls ? Math.round((row.successCalls || 0) / row.totalCalls * 1000) / 10 : 0,
      avgDurationMs: row.avgDurationMs || 0,
      maxDurationMs: row.maxDurationMs || 0,
    };
  }

  /** Clear all stats data. */
  async clear() {
    await this.db.delete(schema.toolCalls);
  }
}
