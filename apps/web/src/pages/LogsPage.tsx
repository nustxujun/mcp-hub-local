import React, { useEffect, useState, useRef, useCallback } from 'react';
import * as api from '../api';

type LogTab = 'session' | 'mcp' | 'hub';

export function LogsPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [tab, setTab] = useState<LogTab>('session');
  const [level, setLevel] = useState('');

  // Session tab state
  const [sessions, setSessions] = useState<any[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');

  // MCP tab state
  const [mcps, setMcps] = useState<any[]>([]);
  const [selectedMcpId, setSelectedMcpId] = useState('');

  const eventSourceRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Load sessions and MCPs for filter dropdowns
  useEffect(() => {
    api.listSessions().then(setSessions).catch(() => {});
    api.listMcps().then((list) => {
      // Only show stdio MCPs for the MCP tab
      setMcps(list.filter((m: any) => m.transportKind === 'stdio'));
    }).catch(() => {});
  }, []);

  const loadLogs = async (loadCursor?: string) => {
    const params: Record<string, string> = { tab };
    if (level) params.level = level;
    if (tab === 'session' && selectedSessionId) params.sessionId = selectedSessionId;
    if (tab === 'mcp' && selectedMcpId) params.mcpId = selectedMcpId;
    if (loadCursor) params.cursor = loadCursor;

    const result = await api.queryLogs(params);
    // Reverse to chronological order (oldest first, newest last)
    const items = [...result.items].reverse();
    if (loadCursor) {
      setLogs(prev => [...prev, ...items]);
    } else {
      setLogs(items);
    }
    setCursor(result.cursor);
    setHasMore(result.hasMore);
  };

  useEffect(() => { loadLogs(); }, [tab, level, selectedSessionId, selectedMcpId]);

  // Reset sub-filters when switching tabs
  useEffect(() => {
    setSelectedSessionId('');
    setSelectedMcpId('');
    setLevel('');
  }, [tab]);

  // Scroll to bottom on initial load and when logs change
  useEffect(() => {
    if (wasNearBottomRef.current) {
      scrollToBottom();
    }
  }, [logs, scrollToBottom]);

  const handleScroll = useCallback(() => {
    wasNearBottomRef.current = isNearBottom();
  }, [isNearBottom]);

  const stopStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setStreaming(false);
  }, []);

  const toggleStream = () => {
    if (streaming) {
      stopStream();
      return;
    }

    const params = new URLSearchParams();
    params.set('tab', tab);
    if (tab === 'session' && selectedSessionId) params.set('sessionId', selectedSessionId);
    if (tab === 'mcp' && selectedMcpId) params.set('mcpId', selectedMcpId);

    const es = new EventSource(`/api/logs/stream?${params.toString()}`);
    es.onmessage = (event) => {
      const entry = JSON.parse(event.data);
      // Apply client-side level filter for streaming
      if (level && entry.level !== level) return;
      wasNearBottomRef.current = isNearBottom();
      setLogs(prev => [...prev, entry]);
    };
    es.onerror = () => {
      es.close();
      setStreaming(false);
    };
    eventSourceRef.current = es;
    setStreaming(true);
  };

  // Stop stream on tab/filter change
  useEffect(() => {
    stopStream();
  }, [tab, selectedSessionId, selectedMcpId, stopStream]);

  useEffect(() => () => eventSourceRef.current?.close(), []);

  const tabStyle = (t: LogTab) => ({
    padding: '8px 20px',
    border: 'none',
    borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
    background: 'none',
    color: tab === t ? 'var(--accent)' : 'var(--text-secondary)',
    fontWeight: tab === t ? 600 : 400,
    cursor: 'pointer',
    fontSize: 14,
  });

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 className="page-title">Logs</h2>
            <p className="page-subtitle">View and stream MCP logs</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => loadLogs()}>Refresh</button>
            <button className={`btn ${streaming ? 'btn-danger' : 'btn-primary'}`} onClick={toggleStream}>
              {streaming ? 'Stop Stream' : 'Live Stream'}
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        <button style={tabStyle('session')} onClick={() => setTab('session')}>Session Logs</button>
        <button style={tabStyle('mcp')} onClick={() => setTab('mcp')}>MCP Logs</button>
        <button style={tabStyle('hub')} onClick={() => setTab('hub')}>Hub Logs</button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        {tab === 'session' && (
          <select
            value={selectedSessionId}
            onChange={e => setSelectedSessionId(e.target.value)}
            style={{ width: 260 }}
          >
            <option value="">All Sessions</option>
            {sessions.map((s: any) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.clientInfo?.name || 'unknown'} - {s.workspaceSlug} (#{s.sessionId})
              </option>
            ))}
          </select>
        )}
        {tab === 'mcp' && (
          <select
            value={selectedMcpId}
            onChange={e => setSelectedMcpId(e.target.value)}
            style={{ width: 260 }}
          >
            <option value="">All MCPs</option>
            {mcps.map((m: any) => (
              <option key={m.id} value={String(m.id)}>
                {m.displayName || m.name}
              </option>
            ))}
          </select>
        )}
        <select value={level} onChange={e => setLevel(e.target.value)} style={{ width: 120 }}>
          <option value="">All Levels</option>
          <option value="error">Error</option>
          <option value="warn">Warn</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
      </div>

      <div
        ref={scrollRef}
        className="card"
        style={{ padding: 0, maxHeight: '65vh', overflowY: 'auto' }}
        onScroll={handleScroll}
      >
        {hasMore && (
          <div style={{ padding: 12, textAlign: 'center' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => loadLogs(cursor!)}>Load Older</button>
          </div>
        )}
        {logs.length === 0 ? (
          <div className="empty-state"><h3>No logs</h3></div>
        ) : (
          logs.map(log => (
            <div key={log.id} className="log-entry">
              <span className="log-timestamp">{new Date(log.timestamp).toLocaleTimeString()}</span>
              <span className={`log-level-${log.level}`} style={{ fontWeight: 600, marginRight: 8 }}>{log.level.toUpperCase().padEnd(5)}</span>
              <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>[{log.category}]</span>
              <span>{log.message}</span>
              {log.payloadPreview && (
                <details style={{ marginTop: 2 }}>
                  <summary style={{ color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>
                    payload{log.payloadTruncated && ' (truncated)'}
                  </summary>
                  <pre style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{log.payloadPreview}</pre>
                </details>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
