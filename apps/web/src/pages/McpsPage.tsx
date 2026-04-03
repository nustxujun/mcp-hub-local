import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import * as api from '../api';
import { useMessageBox } from '../components/MessageBox';
import { ConfirmButton } from '../components/ConfirmButton';

interface McpDef {
  id: number;
  name: string;
  slug: string;
  displayName: string;
  transportKind: string;
  instanceMode: string;
  configJson: any;
}

type ConnStatus = 'checking' | 'ok' | 'fail' | 'starting' | 'error';

const emptyForm = {
  name: '', slug: '', transportKind: 'stdio', instanceMode: 'per-workspace',
  command: '', args: '', env: '', url: '', headers: '',
};

export function McpsPage() {
  const msgbox = useMessageBox();
  const [mcps, setMcps] = useState<McpDef[]>([]);
  const [tab, setTab] = useState<'remote' | 'local'>('remote');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingMcp, setEditingMcp] = useState<McpDef | null>(null);
  const [connStatus, setConnStatus] = useState<Record<number, ConnStatus>>({});
  const [form, setForm] = useState({ ...emptyForm });

  // Local tab state
  const [selectedLocalMcp, setSelectedLocalMcp] = useState<McpDef | null>(null);
  const [instances, setInstances] = useState<any[]>([]);
  const [allInstances, setAllInstances] = useState<any[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    const data = await api.listMcps();
    setMcps(data);
    return data;
  };

  const loadCachedHealth = async (mcpList: McpDef[]) => {
    try {
      const [cached, sessions] = await Promise.all([
        api.getHealthStatus(),
        api.listSessions(),
      ]);

      // Build mcpId → best status from all session backends
      const mcpSessionStatus = new Map<number, string>();
      for (const s of sessions) {
        for (const b of (s as any).backends || []) {
          const prev = mcpSessionStatus.get(b.mcpId);
          if (b.status === 'running') mcpSessionStatus.set(b.mcpId, 'running');
          else if (b.status === 'starting' && prev !== 'running') mcpSessionStatus.set(b.mcpId, 'starting');
          else if (b.status === 'error' && !prev) mcpSessionStatus.set(b.mcpId, 'error');
        }
      }

      const updated: Record<number, ConnStatus> = {};
      for (const m of mcpList) {
        const ss = mcpSessionStatus.get(m.id);
        if (ss === 'running') {
          updated[m.id] = 'ok';
        } else if (ss === 'starting') {
          updated[m.id] = 'starting';
        } else if (ss === 'error') {
          updated[m.id] = 'error';
        } else if (m.transportKind === 'stdio') {
          updated[m.id] = 'fail';
        } else {
          const r = cached[m.id];
          updated[m.id] = !r ? 'checking' : r.ok ? 'ok' : 'fail';
        }
      }
      setConnStatus(updated);
    } catch {
      scanConnectivity(mcpList);
    }
  };

  const scanConnectivity = async (mcpList: McpDef[]) => {
    const initial: Record<number, ConnStatus> = {};
    for (const m of mcpList) {
      initial[m.id] = 'checking';
    }
    setConnStatus(initial);

    try {
      const results = await api.batchTestMcps();
      const updated: Record<number, ConnStatus> = {};
      for (const m of mcpList) {
        if (m.transportKind === 'stdio') {
          updated[m.id] = 'checking';
        } else {
          const r = results[m.id];
          updated[m.id] = r?.ok ? 'ok' : 'fail';
        }
      }
      setConnStatus(updated);
    } catch {
      const fallback: Record<number, ConnStatus> = {};
      for (const m of mcpList) {
        fallback[m.id] = 'fail';
      }
      setConnStatus(fallback);
    }
  };

  /** Load all runtime instances (only active: starting/running) and derive local MCP status.
   *  For local MCPs, status is determined by singleton instances only. */
  const loadAllInstances = useCallback(async (mcpList?: McpDef[]) => {
    try {
      const all = await api.listRuntimeInstances();
      setAllInstances(all);
      const list = mcpList || mcps;
      setConnStatus(prev => {
        const updated = { ...prev };
        for (const m of list) {
          if (m.transportKind === 'stdio') {
            // Only use singleton instances for local MCP status
            const singletonInst = all.find((i: any) =>
              (i.mcp_id || i.mcpId) === m.id &&
              (i.instance_mode || i.instanceMode) === 'singleton'
            );
            if (!singletonInst) {
              updated[m.id] = 'fail'; // no singleton instance → offline
            } else if (singletonInst.status === 'running') {
              updated[m.id] = 'ok';
            } else if (singletonInst.status === 'starting') {
              updated[m.id] = 'starting';
            } else if (singletonInst.status === 'error') {
              updated[m.id] = 'error';
            } else {
              updated[m.id] = 'fail';
            }
          }
        }
        return updated;
      });
      return all;
    } catch {
      setAllInstances([]);
      return [];
    }
  }, [mcps]);

  useEffect(() => {
    load().then(async (data) => {
      await loadCachedHealth(data);
      await loadAllInstances(data);
    });
  }, []);

  // When a local MCP is selected, filter instances for it
  useEffect(() => {
    if (selectedLocalMcp) {
      setInstances(allInstances.filter((i: any) => (i.mcp_id || i.mcpId) === selectedLocalMcp.id));
    }
  }, [selectedLocalMcp, allInstances]);

  // 1-second polling when local MCP instance panel is open
  useEffect(() => {
    if (selectedLocalMcp) {
      // Immediate fetch
      loadAllInstances();
      pollTimerRef.current = setInterval(() => {
        loadAllInstances();
      }, 1000);
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [selectedLocalMcp?.id]);

  const remoteMcps = useMemo(() => mcps.filter(m => m.transportKind === 'streamable-http'), [mcps]);
  const localMcps = useMemo(() => mcps.filter(m => m.transportKind === 'stdio'), [mcps]);

  const filteredRemote = useMemo(() => {
    if (!search.trim()) return remoteMcps;
    const q = search.toLowerCase();
    return remoteMcps.filter(m => m.name.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q));
  }, [remoteMcps, search]);

  const filteredLocal = useMemo(() => {
    if (!search.trim()) return localMcps;
    const q = search.toLowerCase();
    return localMcps.filter(m => m.name.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q));
  }, [localMcps, search]);

  const openAddModal = () => {
    setEditingMcp(null);
    setForm({
      ...emptyForm,
      transportKind: tab === 'remote' ? 'streamable-http' : 'stdio',
    });
    setShowModal(true);
  };

  const openEditModal = (mcp: McpDef) => {
    setEditingMcp(mcp);
    const cfg = mcp.configJson || {};
    setForm({
      name: mcp.name,
      slug: mcp.slug,
      transportKind: mcp.transportKind,
      instanceMode: mcp.instanceMode || 'per-workspace',
      command: cfg.command || '',
      args: Array.isArray(cfg.args) ? cfg.args.join(' ') : (cfg.args || ''),
      env: cfg.env && Object.keys(cfg.env).length > 0 ? JSON.stringify(cfg.env) : '',
      url: cfg.url || '',
      headers: cfg.headers && Object.keys(cfg.headers).length > 0 ? JSON.stringify(cfg.headers) : '',
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    const isRemote = form.transportKind === 'streamable-http';
    const configJson = isRemote
      ? { kind: 'streamable-http', url: form.url, headers: form.headers ? JSON.parse(form.headers) : {} }
      : { kind: 'stdio', command: form.command, args: form.args.split(' ').filter(Boolean), env: form.env ? JSON.parse(form.env) : {}, instanceMode: form.instanceMode };

    if (editingMcp) {
      await api.updateMcp(editingMcp.id, {
        name: form.name,
        slug: form.slug || undefined,
        instanceMode: isRemote ? 'singleton' : form.instanceMode,
        configJson,
      });
    } else {
      await api.createMcp({
        name: form.name,
        slug: form.slug || undefined,
        transportKind: form.transportKind,
        instanceMode: isRemote ? 'singleton' : form.instanceMode,
        configJson,
      });
    }
    setShowModal(false);
    setEditingMcp(null);
    setForm({ ...emptyForm });
    const data = await load();
    await scanConnectivity(data);
    await loadAllInstances(data);
  };

  const handleDelete = async (id: number) => {
    await api.deleteMcp(id);
    if (selectedLocalMcp?.id === id) setSelectedLocalMcp(null);
    const data = await load();
    await scanConnectivity(data);
    await loadAllInstances(data);
  };

  const handleTest = async (id: number) => {
    const result = await api.testMcp(id);
    await msgbox.alert(JSON.stringify(result, null, 2));
  };

  const handleDeleteInstance = async (instanceId: number) => {
    await api.deleteRuntimeInstance(instanceId);
    await loadAllInstances();
  };

  const handleSelectLocalMcp = async (m: McpDef) => {
    setSelectedLocalMcp(m);
    // Check if a singleton instance exists; if not, try to start one
    const hasSingleton = allInstances.some((i: any) =>
      (i.mcp_id || i.mcpId) === m.id &&
      (i.instance_mode || i.instanceMode) === 'singleton'
    );
    if (!hasSingleton) {
      try {
        await api.startMcp(m.id);
        await loadAllInstances();
      } catch {
        // start failed — loadAllInstances will pick up the error state
        await loadAllInstances();
      }
    }
  };

  const statusDot = (id: number) => {
    const s = connStatus[id];
    if (!s || s === 'checking') return <span className="status-label status-label-checking">...</span>;
    if (s === 'starting') return <span className="status-label status-label-loading">Loading</span>;
    if (s === 'ok') return <span className="status-label status-label-online">Online</span>;
    if (s === 'error') return <span className="status-label status-label-error">Error</span>;
    return <span className="status-label status-label-offline">Offline</span>;
  };

  const instanceStatusBadge = (status: string) => {
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
  };

  const isRemote = form.transportKind === 'streamable-http';

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 className="page-title">MCP Registry</h2>
            <p className="page-subtitle">Manage registered MCP definitions</p>
          </div>
          <button className="btn btn-primary" onClick={openAddModal}>
            + Add {tab === 'remote' ? 'Remote' : 'Local'} MCP
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn ${tab === 'remote' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('remote')}>Remote MCPs</button>
        <button className={`btn ${tab === 'local' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('local')}>Local MCPs</button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <input
          placeholder="Search by name or slug..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: 320 }}
        />
      </div>

      {/* Remote MCPs Tab */}
      {tab === 'remote' && (
        filteredRemote.length === 0 ? (
          <div className="empty-state">
            <h3>{remoteMcps.length === 0 ? 'No remote MCPs registered' : 'No matching MCPs'}</h3>
            <p>{remoteMcps.length === 0 ? 'Add your first remote MCP to get started' : 'Try a different search term'}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {filteredRemote.map(m => (
              <div key={m.id} className="card" style={{ padding: 14, width: 280 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {statusDot(m.id)}
                      <strong style={{ fontSize: 14 }}>{m.name}</strong>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => openEditModal(m)}>Edit</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => handleTest(m.id)}>Test</button>
                    <ConfirmButton onConfirm={() => handleDelete(m.id)}>Delete</ConfirmButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Local MCPs Tab */}
      {tab === 'local' && (
        <div style={{ display: 'flex', gap: 20, minHeight: 'calc(100vh - 320px)' }}>
          <div style={{ width: 280, flexShrink: 0 }}>
            {filteredLocal.length === 0 ? (
              <div className="empty-state">
                <h3>{localMcps.length === 0 ? 'No local MCPs' : 'No matches'}</h3>
              </div>
            ) : (
              filteredLocal.map(m => (
                <div
                  key={m.id}
                  className="card"
                  style={{
                    cursor: 'pointer',
                    border: selectedLocalMcp?.id === m.id ? '1px solid var(--accent)' : undefined,
                    padding: 14,
                  }}
                  onClick={() => handleSelectLocalMcp(m)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {statusDot(m.id)}
                        <strong style={{ fontSize: 14 }}>{m.name}</strong>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{m.instanceMode}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); openEditModal(m); }}>Edit</button>
                      <ConfirmButton onConfirm={() => handleDelete(m.id)}>Delete</ConfirmButton>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            {selectedLocalMcp ? (
              <div className="card" style={{ flex: 1 }}>
                <div className="card-header">
                  <h3 style={{ fontSize: 16 }}>Instances - {selectedLocalMcp.name}</h3>
                </div>
                {instances.length === 0 ? (
                  <div className="empty-state"><h3>No running instances</h3></div>
                ) : (
                  <div className="table-container">
                    <table>
                      <thead>
                        <tr><th>ID</th><th>Mode</th><th>PID</th><th>Status</th><th>Started At</th><th></th></tr>
                      </thead>
                      <tbody>
                        {instances.map((inst: any) => (
                          <tr key={inst.id}>
                            <td>{inst.id}</td>
                            <td>{inst.instance_mode || inst.instanceMode}</td>
                            <td>{inst.pid || '--'}</td>
                            <td>{instanceStatusBadge(inst.status)}</td>
                            <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{new Date(inst.started_at || inst.startedAt).toLocaleString()}</td>
                            <td>
                              {inst.status === 'error' && (
                                <button className="btn btn-danger btn-sm" onClick={() => handleDeleteInstance(inst.id)}>Delete</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <div className="card" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="empty-state"><h3>Select a local MCP</h3><p>Click a local MCP to view its running instances</p></div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => { setShowModal(false); setEditingMcp(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">{editingMcp ? 'Edit MCP' : 'Add MCP'}</h3>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Name *</label>
                <input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Slug (auto)</label>
                <input className="form-input" value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} placeholder="auto-generated" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Transport Kind</label>
                {editingMcp ? (
                  <input className="form-input" value={form.transportKind} disabled style={{ color: 'var(--text-muted)' }} />
                ) : (
                  <select className="form-input" value={form.transportKind} onChange={e => setForm(f => ({ ...f, transportKind: e.target.value }))}>
                    <option value="stdio">stdio</option>
                    <option value="streamable-http">streamable-http</option>
                  </select>
                )}
              </div>
              {!isRemote && (
                <div className="form-group">
                  <label className="form-label">Instance Mode</label>
                  <select className="form-input" value={form.instanceMode} onChange={e => setForm(f => ({ ...f, instanceMode: e.target.value }))}>
                    <option value="per-workspace">per-workspace</option>
                    <option value="singleton">singleton</option>
                    <option value="per-session">per-session</option>
                  </select>
                </div>
              )}
              {isRemote && (
                <div className="form-group">
                  <label className="form-label">Instance Mode</label>
                  <input className="form-input" value="singleton" disabled style={{ color: 'var(--text-muted)' }} />
                </div>
              )}
            </div>

            {!isRemote ? (
              <>
                <div className="form-group">
                  <label className="form-label">Command *</label>
                  <input className="form-input" value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))} placeholder="e.g. node" />
                </div>
                <div className="form-group">
                  <label className="form-label">Args (space-separated)</label>
                  <input className="form-input" value={form.args} onChange={e => setForm(f => ({ ...f, args: e.target.value }))} placeholder="e.g. dist/server.js --port 8080" />
                </div>
                <div className="form-group">
                  <label className="form-label">Env (JSON)</label>
                  <input className="form-input" value={form.env} onChange={e => setForm(f => ({ ...f, env: e.target.value }))} placeholder='{"KEY": "value"}' />
                </div>
              </>
            ) : (
              <>
                <div className="form-group">
                  <label className="form-label">URL *</label>
                  <input className="form-input" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://remote-mcp.example.com/mcp" />
                </div>
                <div className="form-group">
                  <label className="form-label">Headers (JSON)</label>
                  <input className="form-input" value={form.headers} onChange={e => setForm(f => ({ ...f, headers: e.target.value }))} placeholder='{"Authorization": "Bearer ..."}' />
                </div>
              </>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { setShowModal(false); setEditingMcp(null); }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={!form.name || (isRemote ? !form.url : !form.command)}>
                {editingMcp ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
