import type { FastifyInstance } from 'fastify';
import type { StatsService } from '../services/stats.js';

export function registerStatsRoutes(app: FastifyInstance, statsService: StatsService) {
  app.get('/api/stats/summary', async () => {
    return statsService.getSummary();
  });

  app.get('/api/stats/tools', async (request) => {
    const q = request.query as { mcpId?: string };
    return statsService.getToolStats({
      mcpId: q.mcpId ? parseInt(q.mcpId) : undefined,
    });
  });

  app.get('/api/stats/mcps', async () => {
    return statsService.getMcpStats();
  });

  app.get('/api/stats/recent', async (request) => {
    const q = request.query as { limit?: string };
    return statsService.getRecentCalls(q.limit ? parseInt(q.limit) : 20);
  });

  app.get('/api/stats/slowest', async () => {
    return statsService.getWorstCaseByTool();
  });

  app.delete('/api/stats', async (_request, reply) => {
    await statsService.clear();
    reply.status(204).send();
  });
}
