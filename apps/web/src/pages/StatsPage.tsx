import React, { useEffect, useState, useRef, useCallback } from 'react';
import * as api from '../api';
import { useMessageBox } from '../components/MessageBox';

interface Summary {
  totalCalls: number;
  successCalls: number;
  failCalls: number;
  successRate: number;
  avgDurationMs: number;
  maxDurationMs: number;
}

interface ToolStat {
  mcpSlug: string;
  toolName: string;
  mcpId: number | null;
  totalCalls: number;
  successCalls: number;
  failCalls: number;
  avgDurationMs: number;
  maxDurationMs: number;
  avgRequestSize: number;
  maxRequestSize: number;
  avgResponseSize: number;
  maxResponseSize: number;
}

interface McpStat {
  mcpSlug: string;
  mcpId: number | null;
  totalCalls: number;
  successCalls: number;
  failCalls: number;
  avgDurationMs: number;
  maxDurationMs: number;
  avgRequestSize: number;
  maxRequestSize: number;
  avgResponseSize: number;
  maxResponseSize: number;
}

interface RecentCall {
  id: number;
  timestamp: string;
  sessionId: string | null;
  mcpSlug: string;
  toolName: string;
  success: boolean;
  durationMs: number;
  requestSize: number;
  responseSize: number;
  error: string | null;
}

type Tab = 'mcp' | 'tool' | 'recent' | 'slowest';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatJson(raw: string | null | undefined): string {
  if (!raw) return '(empty)';
  try {
    const obj = JSON.parse(raw);
    // JSON.stringify escapes \n back to \\n in string values.
    // We use a custom replacer: stringify first, then unescape \\n \\t within quoted strings.
    const pretty = JSON.stringify(obj, null, 2);
    // Replace \\n and \\t only inside JSON string values (between quotes)
    return pretty.replace(/"(?:[^"\\]|\\.)*"/g, (match) => {
      return match.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    });
  } catch {
    return raw;
  }
}

export function StatsPage() {
  const msgbox = useMessageBox();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [mcpStats, setMcpStats] = useState<McpStat[]>([]);
  const [toolStats, setToolStats] = useState<ToolStat[]>([]);
  const [recentCalls, setRecentCalls] = useState<RecentCall[]>([]);
  const [slowestCalls, setSlowestCalls] = useState<any[]>([]);
  const [tab, setTab] = useState<Tab>('mcp');
  const [clearing, setClearing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const [s, m, t, r, sl] = await Promise.all([
      api.getStatsSummary(),
      api.getMcpStats(),
      api.getToolStats(),
      api.getRecentCalls(30),
      api.getSlowestCalls(),
    ]);
    setSummary(s);
    setMcpStats(m);
    setToolStats(t);
    setRecentCalls(r);
    setSlowestCalls(sl);
  }, []);

  // Poll every 2 seconds
  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const handleClear = async () => {
    const ok = await msgbox.confirm('Clear all tool call statistics? This cannot be undone.');
    if (!ok) return;
    setClearing(true);
    try {
      await api.clearStats();
      await load();
    } finally {
      setClearing(false);
    }
  };

  const tabStyle = (t: Tab) => ({
    padding: '8px 20px',
    border: 'none',
    borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
    background: 'none',
    color: tab === t ? 'var(--accent)' : 'var(--text-secondary)',
    fontWeight: tab === t ? 600 : 400 as const,
    cursor: 'pointer',
    fontSize: 14,
  });

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 className="page-title">Tool Call Stats</h2>
            <p className="page-subtitle">Monitor MCP tool usage and performance</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={load}>Refresh</button>
            <button className="btn btn-danger" onClick={handleClear} disabled={clearing}>
              {clearing ? 'Clearing...' : 'Clear Stats'}
            </button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      {summary && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          <div className="card" style={{ flex: 1, minWidth: 150, padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{summary.totalCalls}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Total Calls</div>
          </div>
          <div className="card" style={{ flex: 1, minWidth: 150, padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--success, #22c55e)' }}>{summary.successRate}%</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Success Rate</div>
          </div>
          <div className="card" style={{ flex: 1, minWidth: 150, padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{formatMs(summary.avgDurationMs)}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Avg Duration</div>
          </div>
          <div className="card" style={{ flex: 1, minWidth: 150, padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--warning, #eab308)' }}>{formatMs(summary.maxDurationMs)}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Max Duration</div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        <button style={tabStyle('mcp')} onClick={() => setTab('mcp')}>By MCP</button>
        <button style={tabStyle('tool')} onClick={() => setTab('tool')}>By Tool</button>
        <button style={tabStyle('recent')} onClick={() => setTab('recent')}>Recent Calls</button>
        <button style={tabStyle('slowest')} onClick={() => setTab('slowest')}>Debug</button>
      </div>

      {/* By MCP */}
      {tab === 'mcp' && (
        <div className="card" style={{ padding: 0 }}>
          {mcpStats.length === 0 ? (
            <div className="empty-state"><h3>No data</h3><p>Tool call stats will appear here after tools are used</p></div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>MCP</th>
                    <th style={{ textAlign: 'right' }}>Calls</th>
                    <th style={{ textAlign: 'right' }}>Success</th>
                    <th style={{ textAlign: 'right' }}>Fail</th>
                    <th style={{ textAlign: 'right' }}>Avg Time</th>
                    <th style={{ textAlign: 'right' }}>Max Time</th>
                    <th style={{ textAlign: 'right' }}>Avg Req</th>
                    <th style={{ textAlign: 'right' }}>Avg Resp</th>
                    <th style={{ textAlign: 'right' }}>Max Resp</th>
                  </tr>
                </thead>
                <tbody>
                  {mcpStats.map(s => (
                    <tr key={s.mcpSlug}>
                      <td><strong>{s.mcpSlug}</strong></td>
                      <td style={{ textAlign: 'right' }}>{s.totalCalls}</td>
                      <td style={{ textAlign: 'right', color: 'var(--success, #22c55e)' }}>{s.successCalls}</td>
                      <td style={{ textAlign: 'right', color: s.failCalls > 0 ? 'var(--danger, #ef4444)' : undefined }}>{s.failCalls}</td>
                      <td style={{ textAlign: 'right' }}>{formatMs(s.avgDurationMs)}</td>
                      <td style={{ textAlign: 'right' }}>{formatMs(s.maxDurationMs)}</td>
                      <td style={{ textAlign: 'right' }}>{formatBytes(s.avgRequestSize)}</td>
                      <td style={{ textAlign: 'right' }}>{formatBytes(s.avgResponseSize)}</td>
                      <td style={{ textAlign: 'right' }}>{formatBytes(s.maxResponseSize)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* By Tool */}
      {tab === 'tool' && (
        <div className="card" style={{ padding: 0 }}>
          {toolStats.length === 0 ? (
            <div className="empty-state"><h3>No data</h3><p>Tool call stats will appear here after tools are used</p></div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>MCP</th>
                    <th>Tool</th>
                    <th style={{ textAlign: 'right' }}>Calls</th>
                    <th style={{ textAlign: 'right' }}>Success</th>
                    <th style={{ textAlign: 'right' }}>Fail</th>
                    <th style={{ textAlign: 'right' }}>Avg Time</th>
                    <th style={{ textAlign: 'right' }}>Max Time</th>
                    <th style={{ textAlign: 'right' }}>Avg Resp</th>
                    <th style={{ textAlign: 'right' }}>Max Resp</th>
                  </tr>
                </thead>
                <tbody>
                  {toolStats.map(s => (
                    <tr key={`${s.mcpSlug}__${s.toolName}`}>
                      <td style={{ color: 'var(--text-muted)' }}>{s.mcpSlug}</td>
                      <td><strong>{s.toolName}</strong></td>
                      <td style={{ textAlign: 'right' }}>{s.totalCalls}</td>
                      <td style={{ textAlign: 'right', color: 'var(--success, #22c55e)' }}>{s.successCalls}</td>
                      <td style={{ textAlign: 'right', color: s.failCalls > 0 ? 'var(--danger, #ef4444)' : undefined }}>{s.failCalls}</td>
                      <td style={{ textAlign: 'right' }}>{formatMs(s.avgDurationMs)}</td>
                      <td style={{ textAlign: 'right' }}>{formatMs(s.maxDurationMs)}</td>
                      <td style={{ textAlign: 'right' }}>{formatBytes(s.avgResponseSize)}</td>
                      <td style={{ textAlign: 'right' }}>{formatBytes(s.maxResponseSize)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Recent Calls */}
      {tab === 'recent' && (
        <div className="card" style={{ padding: 0 }}>
          {recentCalls.length === 0 ? (
            <div className="empty-state"><h3>No recent calls</h3></div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>MCP</th>
                    <th>Tool</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Duration</th>
                    <th style={{ textAlign: 'right' }}>Req Size</th>
                    <th style={{ textAlign: 'right' }}>Resp Size</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {recentCalls.map(c => (
                    <tr key={c.id}>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(c.timestamp).toLocaleTimeString()}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{c.mcpSlug}</td>
                      <td><strong>{c.toolName}</strong></td>
                      <td>
                        {c.success
                          ? <span className="badge badge-success">ok</span>
                          : <span className="badge badge-error">fail</span>
                        }
                      </td>
                      <td style={{ textAlign: 'right' }}>{formatMs(c.durationMs)}</td>
                      <td style={{ textAlign: 'right' }}>{formatBytes(c.requestSize)}</td>
                      <td style={{ textAlign: 'right' }}>{formatBytes(c.responseSize)}</td>
                      <td style={{ color: 'var(--danger, #ef4444)', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.error || ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Worst case per tool (debug) */}
      {tab === 'slowest' && (
        <div>
          {slowestCalls.length === 0 ? (
            <div className="card"><div className="empty-state"><h3>No data</h3></div></div>
          ) : (
            slowestCalls.map((group: any) => {
              const cases = [
                { label: 'Slowest', record: group.slowest },
                { label: 'Largest Request', record: group.largestRequest },
                { label: 'Largest Response', record: group.largestResponse },
              ];
              // Merge labels for same record id
              const merged: { labels: string[]; record: any }[] = [];
              const idMap = new Map<number, number>(); // record.id → index in merged
              for (const c of cases) {
                if (!c.record) continue;
                const idx = idMap.get(c.record.id);
                if (idx !== undefined) {
                  merged[idx].labels.push(c.label);
                } else {
                  idMap.set(c.record.id, merged.length);
                  merged.push({ labels: [c.label], record: c.record });
                }
              }

              return (
                <div key={`${group.mcpSlug}__${group.toolName}`} className="card" style={{ marginBottom: 16 }}>
                  <h3 style={{ fontSize: 15, marginBottom: 12 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{group.mcpSlug}</span> :: {group.toolName}
                  </h3>
                  {merged.map(({ labels, record: c }) => (
                    <div key={c.id} style={{ marginBottom: 12, paddingLeft: 12, borderLeft: '2px solid var(--border)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontSize: 13 }}>
                          {labels.map(l => (
                            <span key={l} style={{
                              display: 'inline-block',
                              background: 'var(--bg-hover)',
                              color: 'var(--accent)',
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 600,
                              marginRight: 6,
                            }}>{l}</span>
                          ))}
                          {(c.success === true || c.success === 1)
                            ? <span className="badge badge-success">ok</span>
                            : <span className="badge badge-error">fail</span>
                          }
                        </span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                          {formatMs(c.duration_ms ?? c.durationMs)} | req {formatBytes(c.request_size ?? c.requestSize)} | resp {formatBytes(c.response_size ?? c.responseSize)}
                        </span>
                      </div>
                      {c.error && (
                        <div style={{ color: 'var(--danger, #ef4444)', fontSize: 12, marginBottom: 4 }}>Error: {c.error}</div>
                      )}
                      <details style={{ marginBottom: 4 }}>
                        <summary style={{ color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>Request Body</summary>
                        <pre style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{formatJson(c.request_body || c.requestBody)}</pre>
                      </details>
                      <details>
                        <summary style={{ color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>Response Body</summary>
                        <pre style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{formatJson(c.response_body || c.responseBody)}</pre>
                      </details>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
