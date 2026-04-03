import type { FastifyInstance } from 'fastify';
import type { LogService, LogTab } from '../services/log.js';
import type { LogLevel, LogEntry } from '@mcp-hub-local/shared';

export function registerLogRoutes(app: FastifyInstance, logService: LogService) {
  app.get('/api/logs', async (request) => {
    const q = request.query as {
      workspaceId?: string;
      mcpId?: string;
      runtimeInstanceId?: string;
      sessionId?: string;
      tab?: LogTab;
      level?: LogLevel;
      cursor?: string;
      limit?: string;
    };

    return logService.query({
      workspaceId: q.workspaceId ? parseInt(q.workspaceId) : undefined,
      mcpId: q.mcpId ? parseInt(q.mcpId) : undefined,
      runtimeInstanceId: q.runtimeInstanceId ? parseInt(q.runtimeInstanceId) : undefined,
      sessionId: q.sessionId || undefined,
      tab: q.tab || undefined,
      level: q.level,
      cursor: q.cursor,
      limit: q.limit ? parseInt(q.limit) : undefined,
    });
  });

  app.delete('/api/logs', async (_request, reply) => {
    await logService.clear();
    reply.status(204).send();
  });

  app.get('/api/logs/stream', async (request, reply) => {
    const q = request.query as {
      workspaceId?: string;
      mcpId?: string;
      sessionId?: string;
      tab?: LogTab;
    };
    const workspaceId = q.workspaceId ? parseInt(q.workspaceId) : null;
    const mcpId = q.mcpId ? parseInt(q.mcpId) : null;
    const sessionId = q.sessionId || null;
    const tab = q.tab || null;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const onLog = (entry: unknown) => {
      const e = entry as LogEntry;
      if (workspaceId && e.workspaceId !== workspaceId) return;
      if (mcpId && e.mcpId !== mcpId) return;
      if (sessionId && e.sessionId !== sessionId) return;

      // Tab-based filtering
      if (tab === 'session' && !e.sessionId) return;
      if (tab === 'mcp' && !e.category.startsWith('stdio')) return;
      if (tab === 'hub' && (e.sessionId || e.category.startsWith('stdio'))) return;

      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    logService.on('log', onLog);

    request.raw.on('close', () => {
      logService.removeListener('log', onLog);
    });
  });
}
