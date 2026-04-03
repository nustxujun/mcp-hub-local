import type { FastifyRequest, FastifyReply } from 'fastify';
import type { McpAggregator } from './aggregator.js';

/**
 * HTTP handler that bridges Fastify to the McpAggregator.
 * Implements the MCP Streamable HTTP transport protocol.
 */
export class AggregatedHandler {
  constructor(private aggregator: McpAggregator) {}

  async handleRequest(
    request: FastifyRequest<{ Params: { workspaceSlug: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { workspaceSlug } = request.params;

    switch (request.method) {
      case 'POST':
        return this.handlePost(request, reply, workspaceSlug);
      case 'GET':
        return this.handleSse(request, reply);
      case 'DELETE':
        return this.handleDelete(request, reply);
      default:
        reply.status(405).send({ error: 'Method not allowed' });
    }
  }

  private async handlePost(
    request: FastifyRequest,
    reply: FastifyReply,
    workspaceSlug: string,
  ): Promise<void> {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') {
      reply.status(400).send({ error: 'Invalid JSON-RPC body' });
      return;
    }

    const method = body.method as string | undefined;
    const id = body.id as number | string | undefined;
    const params = body.params as any;

    // ── Initialize ──
    if (method === 'initialize') {
      if (id === undefined || id === null) {
        reply.status(400).send({ error: 'initialize must have an id' });
        return;
      }

      const userAgent = (request.headers['user-agent'] as string) || '';
      const { response, sessionId } = await this.aggregator.handleInitialize(workspaceSlug, id, params, userAgent);

      if (sessionId) {
        reply.header('mcp-session-id', sessionId);
      }
      reply.status(200).header('content-type', 'application/json').send(JSON.stringify(response));
      return;
    }

    // ── All other methods require a session ──
    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      reply.status(400).send({ error: 'Missing mcp-session-id header' });
      return;
    }

    // ── Notification (no id) ──
    const isNotification = id === undefined || id === null;
    if (isNotification) {
      if (method) {
        await this.aggregator.handleNotification(sessionId, method, params);
      }
      reply.status(202).send();
      return;
    }

    // ── Request ──
    if (!method) {
      reply.status(400).send({ error: 'Missing method' });
      return;
    }

    const response = await this.aggregator.handleRequest(sessionId, method, id!, params);
    reply.status(200).header('content-type', 'application/json').send(JSON.stringify(response));
  }

  private async handleSse(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      reply.status(400).send({ error: 'Missing mcp-session-id header' });
      return;
    }

    const sessionStore = this.aggregator.getSessionStore();
    const session = sessionStore.get(sessionId);
    if (!session) {
      reply.status(404).send({ error: `Session not found: ${sessionId}` });
      return;
    }

    // Set up SSE stream
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'mcp-session-id': sessionId,
    });

    // Attach SSE writer to session for server-initiated notifications
    session.sseWriter = reply.raw;

    // Keep-alive ping every 30 seconds
    const keepAlive = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 30000);

    // On client disconnect, destroy session
    request.raw.on('close', () => {
      clearInterval(keepAlive);
      if (session.sseWriter === reply.raw) {
        session.sseWriter = null;
      }
      this.aggregator.destroySession(sessionId).catch(() => {});
    });
  }

  private async handleDelete(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      reply.status(400).send({ error: 'Missing mcp-session-id header' });
      return;
    }

    await this.aggregator.destroySession(sessionId);
    reply.status(200).send({ ok: true });
  }
}
