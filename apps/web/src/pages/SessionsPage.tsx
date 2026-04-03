import React, { useEffect, useState, useCallback, useRef } from 'react';
import * as api from '../api';
import { ConfirmButton } from '../components/ConfirmButton';

interface BackendInfo {
  mcpSlug: string;
  mcpId: number;
  mode: string;
  runtimeKey: string;
  instanceId: number | null;
  isRemote: boolean;
  status: 'starting' | 'running' | 'error';
  error: string | null;
}

interface ClientInfo {
  name: string;
  version: string;
  userAgent: string;
  protocolVersion: string;
}

interface SessionInfo {
  sessionId: string;
  workspaceId: number;
  workspaceSlug: string;
  initialized: boolean;
  createdAt: number;
  clientInfo: ClientInfo | null;
  backends: BackendInfo[];
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function backendStatusBadge(status: string) {
  switch (status) {
    case 'running':
      return <span className="badge badge-success" style={{ minWidth: 52, justifyContent: 'center' }}>running</span>;
    case 'starting':
      return <span className="badge badge-warning" style={{ minWidth: 52, justifyContent: 'center' }}>loading</span>;
    case 'error':
      return <span className="badge badge-error" style={{ minWidth: 52, justifyContent: 'center' }}>error</span>;
    default:
      return <span className="badge badge-info" style={{ minWidth: 52, justifyContent: 'center' }}>{status}</span>;
  }
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.listSessions();
      setSessions(data);
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleDelete = async (sessionId: string) => {
    await api.deleteSession(sessionId);
    if (selected === sessionId) setSelected(null);
    await load();
  };

  const handleRestart = async (sessionId: string) => {
    await api.restartSession(sessionId);
    await load();
  };

  const selectedSession = sessions.find(s => s.sessionId === selected);

  return (
    <div>
      <div className="page-header">
        <h2 className="page-title">Sessions</h2>
        <p className="page-subtitle">Active aggregated MCP sessions</p>
      </div>

      <div style={{ display: 'flex', gap: 20, minHeight: 'calc(100vh - 220px)' }}>
        {/* Left: session list */}
        <div style={{ width: 340, flexShrink: 0, overflowY: 'auto' }}>
          {sessions.length === 0 ? (
            <div className="empty-state">
              <h3>No active sessions</h3>
              <p>Sessions are created when a client connects to a workspace endpoint</p>
            </div>
          ) : (
            sessions.map(s => {
              const runningCount = s.backends.filter(b => b.status === 'running').length;
              const totalCount = s.backends.length;
              const hasError = s.backends.some(b => b.status === 'error');
              const allRunning = runningCount === totalCount && totalCount > 0;

              return (
                <div
                  key={s.sessionId}
                  className="card"
                  style={{
                    cursor: 'pointer',
                    border: selected === s.sessionId ? '1px solid var(--accent)' : undefined,
                    padding: 14,
                  }}
                  onClick={() => setSelected(s.sessionId)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`status-label ${
                          hasError ? 'status-label-error' :
                          allRunning ? 'status-label-online' :
                          'status-label-loading'
                        }`}>
                          {hasError ? 'Error' : allRunning ? 'Active' : 'Init'}
                        </span>
                        <strong style={{ fontSize: 14 }}>{s.clientInfo?.name || 'unknown'}</strong>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, display: 'flex', gap: 12 }}>
                        <span>{s.workspaceSlug}</span>
                        <span title="Duration">{formatDuration(now - s.createdAt)}</span>
                        <span title="Backend status">{runningCount}/{totalCount} ready</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.sessionId}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                      <button className="btn btn-ghost btn-sm" onClick={() => handleRestart(s.sessionId)}>Restart</button>
                      <ConfirmButton onConfirm={() => handleDelete(s.sessionId)}>End</ConfirmButton>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right: session detail */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {selectedSession ? (
            <div>
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-header">
                  <h3 style={{ fontSize: 16, margin: 0 }}>Session Detail</h3>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleRestart(selectedSession.sessionId)}>Restart</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
                  <div style={{ display: 'flex', gap: 24 }}>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Client: </span>
                      <strong>{selectedSession.clientInfo?.name || 'unknown'}</strong>
                      {selectedSession.clientInfo?.version && (
                        <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>v{selectedSession.clientInfo.version}</span>
                      )}
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Workspace: </span>
                      <strong>{selectedSession.workspaceSlug}</strong>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Duration: </span>
                      <strong>{formatDuration(now - selectedSession.createdAt)}</strong>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 24 }}>
                    {selectedSession.clientInfo?.userAgent && (
                      <div>
                        <span style={{ color: 'var(--text-muted)' }}>User-Agent: </span>
                        <code style={{ fontSize: 11 }}>{selectedSession.clientInfo.userAgent}</code>
                      </div>
                    )}
                    {selectedSession.clientInfo?.protocolVersion && (
                      <div>
                        <span style={{ color: 'var(--text-muted)' }}>Protocol: </span>
                        <code style={{ fontSize: 11 }}>{selectedSession.clientInfo.protocolVersion}</code>
                      </div>
                    )}
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Session ID: </span>
                    <code style={{ fontSize: 11 }}>{selectedSession.sessionId}</code>
                  </div>
                </div>
              </div>

              <h4 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12 }}>
                MCP Instances ({selectedSession.backends.length})
              </h4>

              {selectedSession.backends.length === 0 ? (
                <div className="empty-state"><h3>No instances</h3></div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {selectedSession.backends.map(b => (
                    <div key={b.mcpSlug} className="card" style={{ width: 280, padding: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <strong style={{ fontSize: 14 }}>{b.mcpSlug}</strong>
                        {backendStatusBadge(b.status)}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div>
                          <span>Mode: </span>
                          <span className="badge badge-info" style={{ fontSize: 10 }}>{b.mode}</span>
                          {b.isRemote && (
                            <span className="badge badge-info" style={{ fontSize: 10, marginLeft: 4 }}>remote</span>
                          )}
                        </div>
                        {b.instanceId != null && (
                          <div>
                            <span>Instance: </span>#{b.instanceId}
                          </div>
                        )}
                        {b.status === 'error' && b.error && (
                          <div style={{ color: 'var(--error)', fontSize: 11, marginTop: 4, wordBreak: 'break-all' }}>
                            {b.error}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="card" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div className="empty-state">
                <h3>Select a session</h3>
                <p>Click a session to view its MCP instances</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
