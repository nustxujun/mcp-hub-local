import React, { useEffect, useState, useMemo } from 'react';
import * as api from '../api';
import { useMessageBox } from '../components/MessageBox';
import { ConfirmButton } from '../components/ConfirmButton';

interface Workspace {
  id: number;
  name: string;
  slug: string;
  rootPath: string;
  description: string;
}

interface Binding {
  id: number;
  workspaceId: number;
  mcpId: number;
  enabled: boolean;
  instanceModeOverride: string | null;
}

interface McpDef {
  id: number;
  name: string;
  slug: string;
  transportKind: string;
  instanceMode: string;
}

type ConnStatus = 'checking' | 'ok' | 'fail' | 'starting' | 'error';

export function WorkspacesPage() {
  const msgbox = useMessageBox();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [mcps, setMcps] = useState<McpDef[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedWs, setSelectedWs] = useState<Workspace | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [form, setForm] = useState({ name: '', slug: '', rootPath: '', description: '' });
  const [wsSearch, setWsSearch] = useState('');
  const [mcpSearch, setMcpSearch] = useState('');
  const [connStatus, setConnStatus] = useState<Record<number, ConnStatus>>({});

  const load = async () => {
    const [ws, m] = await Promise.all([api.listWorkspaces(), api.listMcps()]);
    setWorkspaces(ws);
    setMcps(m);
    return m;
  };

  const loadHealth = async (mcpList: McpDef[]) => {
    try {
      const [cached, sessions] = await Promise.all([
        api.getHealthStatus(),
        api.listSessions(),
      ]);

      // Build mcpId → best status from all session backends
      const mcpSessionStatus = new Map<number, string>();
      for (const s of sessions) {
        for (const b of s.backends) {
          const prev = mcpSessionStatus.get(b.mcpId);
          // Priority: running > starting > error > none
          if (b.status === 'running') {
            mcpSessionStatus.set(b.mcpId, 'running');
          } else if (b.status === 'starting' && prev !== 'running') {
            mcpSessionStatus.set(b.mcpId, 'starting');
          } else if (b.status === 'error' && !prev) {
            mcpSessionStatus.set(b.mcpId, 'error');
          }
        }
      }

      const updated: Record<number, ConnStatus> = {};
      for (const m of mcpList) {
        if (m.transportKind === 'stdio') {
          const ss = mcpSessionStatus.get(m.id);
          if (ss === 'running') updated[m.id] = 'ok';
          else if (ss === 'starting') updated[m.id] = 'starting';
          else if (ss === 'error') updated[m.id] = 'error';
          else updated[m.id] = 'fail';
        } else {
          // For remote MCPs, also check session status first, fall back to health cache
          const ss = mcpSessionStatus.get(m.id);
          if (ss === 'running') {
            updated[m.id] = 'ok';
          } else if (ss === 'starting') {
            updated[m.id] = 'starting';
          } else if (ss === 'error') {
            updated[m.id] = 'error';
          } else {
            const r = cached[m.id];
            updated[m.id] = !r ? 'checking' : r.ok ? 'ok' : 'fail';
          }
        }
      }
      setConnStatus(updated);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    load().then(loadHealth);
  }, []);

  const loadBindings = async (ws: Workspace) => {
    setSelectedWs(ws);
    const b = await api.listBindings(ws.id);
    setBindings(b);
  };

  const handleCreate = async () => {
    await api.createWorkspace({
      name: form.name,
      slug: form.slug || undefined,
      rootPath: form.rootPath,
      description: form.description,
    });
    setShowCreateModal(false);
    setForm({ name: '', slug: '', rootPath: '', description: '' });
    load();
  };

  const handleDelete = async (id: number) => {
    await api.deleteWorkspace(id);
    if (selectedWs?.id === id) setSelectedWs(null);
    load();
  };

  const toggleBinding = async (mcpId: number, currentlyBound: boolean, currentEnabled?: boolean) => {
    if (!selectedWs) return;
    if (currentlyBound) {
      await api.setBinding(selectedWs.id, { mcpId, enabled: !currentEnabled });
    } else {
      await api.setBinding(selectedWs.id, { mcpId, enabled: true });
    }
    const b = await api.listBindings(selectedWs.id);
    setBindings(b);
  };

  const handleSync = async () => {
    if (!selectedWs) return;
    const result = await api.syncWorkspace(selectedWs.id);
    await msgbox.alert(JSON.stringify(result, null, 2));
  };

  const filteredWorkspaces = useMemo(() => {
    if (!wsSearch.trim()) return workspaces;
    const q = wsSearch.toLowerCase();
    return workspaces.filter(ws =>
      ws.name.toLowerCase().includes(q) ||
      ws.slug.toLowerCase().includes(q) ||
      ws.rootPath.toLowerCase().includes(q)
    );
  }, [workspaces, wsSearch]);

  const filteredMcps = useMemo(() => {
    if (!mcpSearch.trim()) return mcps;
    const q = mcpSearch.toLowerCase();
    return mcps.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.slug.toLowerCase().includes(q) ||
      m.transportKind.toLowerCase().includes(q)
    );
  }, [mcps, mcpSearch]);

  const statusBadge = (id: number) => {
    const s = connStatus[id];
    if (!s || s === 'checking') return <span className="badge badge-info" style={{ minWidth: 48, justifyContent: 'center' }}>...</span>;
    if (s === 'starting') return <span className="badge badge-warning" style={{ minWidth: 48, justifyContent: 'center' }}>loading</span>;
    if (s === 'ok') return <span className="badge badge-success" style={{ minWidth: 48, justifyContent: 'center' }}>online</span>;
    if (s === 'error') return <span className="badge badge-error" style={{ minWidth: 48, justifyContent: 'center' }}>error</span>;
    return <span className="badge badge-error" style={{ minWidth: 48, justifyContent: 'center' }}>offline</span>;
  };

  const statusDot = (id: number) => {
    const s = connStatus[id];
    if (!s || s === 'checking') return <span className="status-label status-label-checking">...</span>;
    if (s === 'starting') return <span className="status-label status-label-loading">Loading</span>;
    if (s === 'ok') return <span className="status-label status-label-online">Online</span>;
    if (s === 'error') return <span className="status-label status-label-error">Error</span>;
    return <span className="status-label status-label-offline">Offline</span>;
  };

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 className="page-title">Workspaces</h2>
            <p className="page-subtitle">Manage workspaces and MCP bindings</p>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, minHeight: 'calc(100vh - 220px)' }}>
        {/* Left panel - narrow workspace list */}
        <div style={{ width: 280, flexShrink: 0 }}>
          <div style={{ marginBottom: 12 }}>
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => setShowCreateModal(true)}>+ Add Workspace</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <input
              placeholder="Filter workspaces..."
              value={wsSearch}
              onChange={e => setWsSearch(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          {filteredWorkspaces.length === 0 ? (
            <div className="empty-state"><h3>{workspaces.length === 0 ? 'No workspaces' : 'No matches'}</h3><p>{workspaces.length === 0 ? 'Create your first workspace' : 'Try a different search'}</p></div>
          ) : (
            filteredWorkspaces.map(ws => (
              <div
                key={ws.id}
                className="card"
                style={{
                  cursor: 'pointer',
                  border: selectedWs?.id === ws.id ? '1px solid var(--accent)' : undefined,
                  padding: 14,
                }}
                onClick={() => loadBindings(ws)}
              >
                <div>
                  <strong style={{ fontSize: 14 }}>{ws.name}</strong>
                  <code style={{ marginLeft: 8, color: 'var(--accent)', fontSize: 11 }}>{ws.slug}</code>
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>{ws.rootPath}</div>
                {ws.description && <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 2 }}>{ws.description}</div>}
              </div>
            ))
          )}
        </div>

        {/* Right panel - bindings */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {selectedWs ? (
            <div className="card" style={{ flex: 1 }}>
              <div className="card-header">
                <h3 style={{ fontSize: 16 }}>MCP Bindings — {selectedWs.name}</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={handleSync}>Sync Configs</button>
                  <ConfirmButton onConfirm={() => handleDelete(selectedWs.id)}>Delete</ConfirmButton>
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <input
                  placeholder="Filter MCPs..."
                  value={mcpSearch}
                  onChange={e => setMcpSearch(e.target.value)}
                  style={{ width: 260 }}
                />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {filteredMcps.map(m => {
                  const binding = bindings.find(b => b.mcpId === m.id);
                  return (
                    <div key={m.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px',
                      background: 'var(--bg-hover)',
                      borderRadius: 'var(--radius)',
                      border: binding?.enabled ? '1px solid var(--accent)' : '1px solid var(--border)',
                      width: 260,
                    }}>
                      <input
                        type="checkbox"
                        checked={binding?.enabled ?? false}
                        onChange={() => toggleBinding(m.id, !!binding, binding?.enabled)}
                        style={{ flexShrink: 0 }}
                      />
                      {statusDot(m.id)}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{m.name}</div>
                        {m.transportKind === 'stdio' && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.instanceMode}</div>}
                      </div>
                      <span className={`badge ${m.transportKind === 'stdio' ? 'badge-warning' : 'badge-info'}`} style={{ flexShrink: 0 }}>{m.transportKind === 'stdio' ? 'local' : 'remote'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="card" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div className="empty-state"><h3>Select a workspace</h3><p>Click a workspace to manage its MCP bindings</p></div>
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Create Workspace</h3>
            <div className="form-group">
              <label className="form-label">Name *</label>
              <input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Slug (auto)</label>
              <input className="form-input" value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} placeholder="auto-generated" />
            </div>
            <div className="form-group">
              <label className="form-label">Root Path *</label>
              <input className="form-input" value={form.rootPath} onChange={e => setForm(f => ({ ...f, rootPath: e.target.value }))} placeholder="G:\project\my-app" />
            </div>
            <div className="form-group">
              <label className="form-label">Description</label>
              <input className="form-input" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={!form.name || !form.rootPath}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
