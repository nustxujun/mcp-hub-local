import type { FastifyInstance } from 'fastify';
import type { McpAggregator } from '../services/aggregator/index.js';

export function registerSessionRoutes(
  app: FastifyInstance,
  aggregator: McpAggregator,
) {
  // List all active sessions
  app.get('/api/sessions', async () => {
    const store = aggregator.getSessionStore();
    const sessions = store.all();

    return sessions.map(s => ({
      sessionId: s.sessionId,
      workspaceId: s.workspaceId,
      workspaceSlug: s.workspaceSlug,
      initialized: s.initialized,
      createdAt: s.createdAt,
      clientInfo: s.clientInfo,
      backends: [...s.backends.entries()].map(([slug, b]) => ({
        mcpSlug: slug,
        mcpId: b.mcpId,
        mode: b.mode,
        runtimeKey: b.runtimeKey,
        instanceId: b.handle?.instanceId ?? null,
        isRemote: !!b.handle?.remoteUrl,
        status: b.status,
        error: b.error,
      })),
    }));
  });

  // Destroy a specific session
  app.delete('/api/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    await aggregator.destroySession(sessionId);
    return reply.status(204).send();
  });

  // Restart a session: tear down all backends, re-read bindings, re-init
  app.post('/api/sessions/:sessionId/restart', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const ok = await aggregator.restartSession(sessionId);
    if (!ok) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return { ok: true };
  });
}
