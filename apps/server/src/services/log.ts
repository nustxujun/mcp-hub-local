import { desc, and, eq, lt, sql, like, isNull, isNotNull } from 'drizzle-orm';
import { schema, type HubDatabase } from '../db/index.js';
import type { LogEntry, PaginatedResponse, LogLevel } from '@mcp-hub-local/shared';
import { MAX_PAYLOAD_PREVIEW_LENGTH, DEFAULT_LOG_PAGE_SIZE } from '@mcp-hub-local/shared';
import { EventEmitter } from 'node:events';

export type LogTab = 'session' | 'mcp' | 'hub';

export class LogService extends EventEmitter {
  constructor(private db: HubDatabase) {
    super();
    this.setMaxListeners(100);
  }

  async append(entry: {
    level: LogLevel;
    category: string;
    workspaceId?: number | null;
    runtimeInstanceId?: number | null;
    mcpId?: number | null;
    sessionId?: string | null;
    message: string;
    payload?: string | null;
  }): Promise<LogEntry> {
    let payloadPreview = entry.payload ?? null;
    let payloadTruncated = false;

    if (payloadPreview && payloadPreview.length > MAX_PAYLOAD_PREVIEW_LENGTH) {
      payloadPreview = payloadPreview.slice(0, MAX_PAYLOAD_PREVIEW_LENGTH);
      payloadTruncated = true;
    }

    const now = new Date().toISOString();
    const result = await this.db.insert(schema.logs).values({
      timestamp: now,
      level: entry.level,
      category: entry.category,
      workspaceId: entry.workspaceId ?? null,
      runtimeInstanceId: entry.runtimeInstanceId ?? null,
      mcpId: entry.mcpId ?? null,
      sessionId: entry.sessionId ?? null,
      message: entry.message,
      payloadPreview,
      payloadTruncated,
    }).returning();

    const dto = this.toDto(result[0]);
    this.emit('log', dto);
    return dto;
  }

  async query(params: {
    workspaceId?: number;
    mcpId?: number;
    runtimeInstanceId?: number;
    sessionId?: string;
    tab?: LogTab;
    level?: LogLevel;
    cursor?: string;
    limit?: number;
  }): Promise<PaginatedResponse<LogEntry>> {
    const limit = params.limit || DEFAULT_LOG_PAGE_SIZE;
    const conditions = [];

    if (params.workspaceId) conditions.push(eq(schema.logs.workspaceId, params.workspaceId));
    if (params.mcpId) conditions.push(eq(schema.logs.mcpId, params.mcpId));
    if (params.runtimeInstanceId) conditions.push(eq(schema.logs.runtimeInstanceId, params.runtimeInstanceId));
    if (params.sessionId) conditions.push(eq(schema.logs.sessionId, params.sessionId));
    if (params.level) conditions.push(eq(schema.logs.level, params.level));

    // Tab filtering
    if (params.tab === 'session') {
      conditions.push(isNotNull(schema.logs.sessionId));
    } else if (params.tab === 'mcp') {
      conditions.push(like(schema.logs.category, 'stdio%'));
    } else if (params.tab === 'hub') {
      conditions.push(isNull(schema.logs.sessionId));
      conditions.push(sql`${schema.logs.category} NOT LIKE 'stdio%'`);
    }

    if (params.cursor) {
      const [cursorTs, cursorId] = params.cursor.split('_');
      conditions.push(
        sql`(${schema.logs.timestamp} < ${cursorTs} OR (${schema.logs.timestamp} = ${cursorTs} AND ${schema.logs.id} < ${parseInt(cursorId)}))`
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db.select()
      .from(schema.logs)
      .where(where)
      .orderBy(desc(schema.logs.timestamp), desc(schema.logs.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(this.toDto);
    const lastItem = items[items.length - 1];

    return {
      items,
      cursor: lastItem ? `${lastItem.timestamp}_${lastItem.id}` : null,
      hasMore,
    };
  }

  async clear(): Promise<void> {
    await this.db.delete(schema.logs);
  }

  private toDto(row: typeof schema.logs.$inferSelect): LogEntry {
    return {
      id: row.id,
      timestamp: row.timestamp,
      level: row.level as LogLevel,
      category: row.category,
      workspaceId: row.workspaceId,
      runtimeInstanceId: row.runtimeInstanceId,
      mcpId: row.mcpId,
      sessionId: row.sessionId,
      message: row.message,
      payloadPreview: row.payloadPreview,
      payloadTruncated: row.payloadTruncated,
    };
  }
}
