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
  const [tab, setTab] = useState<'remote' | 'local' | 'tools'>('remote');
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

  // Unified Tools Modal state
  const [toolsMcp, setToolsMcp] = useState<McpDef | null>(null);
  const [toolsList, setToolsList] = useState<any[]>([]);
  const [toolsExposed, setToolsExposed] = useState<Set<string>>(new Set());
  const [toolsPinned, setToolsPinned] = useState<Set<string>>(new Set());
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsMessage, setToolsMessage] = useState<string | null>(null);

  // Tools Tab state: per-MCP data
  const [allToolsData, setAllToolsData] = useState<Record<number, { tools: any[]; exposed: Set<string>; pinned: Set<string>; message?: string; loading: boolean }>>({});
  const [allToolsLoading, setAllToolsLoading] = useState(false);
  const [expandedMcps, setExpandedMcps] = useState<Set<number>>(new Set());

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
    for (const m of mcpList) initial[m.id] = 'checking';
    setConnStatus(initial);
    try {
      const results = await api.batchTestMcps();
      const updated: Record<number, ConnStatus> = {};
      for (const m of mcpList) {
        if (m.transportKind === 'stdio') updated[m.id] = 'checking';
        else {
          const r = results[m.id];
          updated[m.id] = r?.ok ? 'ok' : 'fail';
        }
      }
      setConnStatus(updated);
    } catch {
      const fallback: Record<number, ConnStatus> = {};
      for (const m of mcpList) fallback[m.id] = 'fail';
      setConnStatus(fallback);
    }
  };

  const loadAllInstances = useCallback(async (mcpList?: McpDef[]) => {
    try {
      const all = await api.listRuntimeInstances();
      setAllInstances(all);
      const list = mcpList || mcps;
      setConnStatus(prev => {
        const updated = { ...prev };
        for (const m of list) {
          if (m.transportKind === 'stdio') {
            const singletonInst = all.find((i: any) =>
              (i.mcp_id || i.mcpId) === m.id &&
              (i.instance_mode || i.instanceMode) === 'singleton'
            );
            if (!singletonInst) updated[m.id] = 'fail';
            else if (singletonInst.status === 'running') updated[m.id] = 'ok';
            else if (singletonInst.status === 'starting') updated[m.id] = 'starting';
            else if (singletonInst.status === 'error') updated[m.id] = 'error';
            else updated[m.id] = 'fail';
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

  useEffect(() => {
    if (selectedLocalMcp) {
      setInstances(allInstances.filter((i: any) => (i.mcp_id || i.mcpId) === selectedLocalMcp.id));
    }
  }, [selectedLocalMcp, allInstances]);

  useEffect(() => {
    if (selectedLocalMcp) {
      loadAllInstances();
      pollTimerRef.current = setInterval(() => loadAllInstances(), 1000);
    }
    return () => {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
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

  // ── Actions ──

  const openAddModal = () => {
    setEditingMcp(null);
    setForm({ ...emptyForm, transportKind: tab === 'remote' ? 'streamable-http' : 'stdio' });
    setShowModal(true);
  };

  const openEditModal = (mcp: McpDef) => {
    setEditingMcp(mcp);
    const cfg = mcp.configJson || {};
    setForm({
      name: mcp.name, slug: mcp.slug, transportKind: mcp.transportKind,
      instanceMode: mcp.instanceMode || 'per-workspace',
      command: cfg.command || '',
      args: Array.isArray(cfg.args) ? cfg.args.join(' ') : (cfg.args || ''),
      env: cfg.env && Object.keys(cfg.env).length > 0 ? JSON.stringify(cfg.env) : '',
      url: cfg.url || '', headers: cfg.headers && Object.keys(cfg.headers).length > 0 ? JSON.stringify(cfg.headers) : '',
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    const isRemote = form.transportKind === 'streamable-http';
    const configJson = isRemote
      ? { kind: 'streamable-http', url: form.url, headers: form.headers ? JSON.parse(form.headers) : {} }
      : { kind: 'stdio', command: form.command, args: form.args.split(' ').filter(Boolean), env: form.env ? JSON.parse(form.env) : {}, instanceMode: form.instanceMode };
    if (editingMcp) {
      await api.updateMcp(editingMcp.id, { name: form.name, slug: form.slug || undefined, instanceMode: isRemote ? 'singleton' : form.instanceMode, configJson });
    } else {
      await api.createMcp({ name: form.name, slug: form.slug || undefined, transportKind: form.transportKind, instanceMode: isRemote ? 'singleton' : form.instanceMode, configJson });
    }
    setShowModal(false); setEditingMcp(null); setForm({ ...emptyForm });
    const data = await load(); await scanConnectivity(data); await loadAllInstances(data);
  };

  const handleDelete = async (id: number) => {
    await api.deleteMcp(id);
    if (selectedLocalMcp?.id === id) setSelectedLocalMcp(null);
    const data = await load(); await scanConnectivity(data); await loadAllInstances(data);
  };

  const handleTest = async (id: number) => {
    const result = await api.testMcp(id);
    await msgbox.alert(JSON.stringify(result, null, 2));
  };

  const handleRestartMcp = async () => {
    if (!selectedLocalMcp) return;
    await api.restartMcp(selectedLocalMcp.id);
    await loadAllInstances();
  };

  const handleDeleteInstance = async (instanceId: number) => {
    await api.deleteRuntimeInstance(instanceId);
    await loadAllInstances();
  };

  const handleSelectLocalMcp = async (m: McpDef) => {
    setSelectedLocalMcp(m);
    const hasSingleton = allInstances.some((i: any) =>
      (i.mcp_id || i.mcpId) === m.id && (i.instance_mode || i.instanceMode) === 'singleton'
    );
    if (!hasSingleton) {
      try { await api.startMcp(m.id); } catch { /* ignore */ }
      await loadAllInstances();
    }
  };

  // ── Unified Tools Modal ──

  const openToolsModal = async (mcp: McpDef) => {
    setToolsMcp(mcp);
    setToolsList([]);
    setToolsExposed(new Set());
    setToolsPinned(new Set());
    setToolsLoading(true);
    setToolsMessage(null);
    try {
      const [toolsResult, settings] = await Promise.all([
        api.getMcpTools(mcp.id),
        api.getExposedTools(mcp.id),
      ]);
      setToolsList(toolsResult.tools || []);
      setToolsExposed(new Set(settings.filter(s => s.exposed).map(s => s.toolName)));
      setToolsPinned(new Set(settings.filter(s => s.pinned).map(s => s.toolName)));
      if (toolsResult.message) setToolsMessage(toolsResult.message);
    } catch (err: any) {
      setToolsMessage(err.message || 'Failed to load tools');
    } finally {
      setToolsLoading(false);
    }
  };

  const saveToolSettings = async (exposed: Set<string>, pinned: Set<string>) => {
    if (!toolsMcp) return;
    const allNames = new Set([...exposed, ...pinned]);
    const tools = [...allNames].map(toolName => ({
      toolName,
      exposed: exposed.has(toolName),
      pinned: pinned.has(toolName),
    }));
    await api.setExposedTools(toolsMcp.id, tools);
  };

  const handleToggleTool = async (toolName: string) => {
    const nextExposed = new Set(toolsExposed);
    const nextPinned = new Set(toolsPinned);
    if (nextExposed.has(toolName)) {
      nextExposed.delete(toolName);
    } else {
      nextExposed.add(toolName);
      nextPinned.delete(toolName); // expose implies no need for pin
    }
    setToolsExposed(nextExposed);
    setToolsPinned(nextPinned);
    await saveToolSettings(nextExposed, nextPinned);
  };

  const handleTogglePinned = async (toolName: string) => {
    const nextPinned = new Set(toolsPinned);
    if (nextPinned.has(toolName)) nextPinned.delete(toolName); else nextPinned.add(toolName);
    setToolsPinned(nextPinned);
    await saveToolSettings(toolsExposed, nextPinned);
  };

  // ── Tools Tab ──

  const loadAllTools = async () => {
    // Only loads settings counts (exposed/pinned) for summary display, not full tools
    setAllToolsLoading(true);
    const data: typeof allToolsData = {};
    await Promise.all(mcps.map(async (m) => {
      try {
        const settings = await api.getExposedTools(m.id);
        data[m.id] = {
          tools: [],
          exposed: new Set(settings.filter(s => s.exposed).map(s => s.toolName)),
          pinned: new Set(settings.filter(s => s.pinned).map(s => s.toolName)),
          loading: false,
        };
      } catch {
        data[m.id] = { tools: [], exposed: new Set(), pinned: new Set(), loading: false };
      }
    }));
    setAllToolsData({ ...data });
    setAllToolsLoading(false);
  };

  const loadMcpTools = async (mcpId: number) => {
    setAllToolsData(prev => ({ ...prev, [mcpId]: { ...prev[mcpId], loading: true } }));
    try {
      const [toolsResult, settings] = await Promise.all([
        api.getMcpTools(mcpId),
        api.getExposedTools(mcpId),
      ]);
      setAllToolsData(prev => ({
        ...prev,
        [mcpId]: {
          tools: toolsResult.tools || [],
          exposed: new Set(settings.filter(s => s.exposed).map(s => s.toolName)),
          pinned: new Set(settings.filter(s => s.pinned).map(s => s.toolName)),
          message: toolsResult.message,
          loading: false,
        },
      }));
    } catch (err: any) {
      setAllToolsData(prev => ({
        ...prev,
        [mcpId]: { ...prev[mcpId], tools: [], message: err.message, loading: false },
      }));
    }
  };

  const toggleMcpExpand = (mcpId: number) => {
    setExpandedMcps(prev => {
      const next = new Set(prev);
      if (next.has(mcpId)) {
        next.delete(mcpId);
      } else {
        next.add(mcpId);
        // Lazy load tools on first expand
        const d = allToolsData[mcpId];
        if (!d || d.tools.length === 0) loadMcpTools(mcpId);
      }
      return next;
    });
  };

  const handleTabToggleExpose = async (mcpId: number, toolName: string) => {
    const d = allToolsData[mcpId];
    if (!d) return;
    const nextExposed = new Set(d.exposed);
    const nextPinned = new Set(d.pinned);
    if (nextExposed.has(toolName)) {
      nextExposed.delete(toolName);
    } else {
      nextExposed.add(toolName);
      nextPinned.delete(toolName);
    }
    setAllToolsData(prev => ({ ...prev, [mcpId]: { ...prev[mcpId], exposed: nextExposed, pinned: nextPinned } }));
    const allNames = new Set([...nextExposed, ...nextPinned]);
    await api.setExposedTools(mcpId, [...allNames].map(tn => ({ toolName: tn, exposed: nextExposed.has(tn), pinned: nextPinned.has(tn) })));
  };

  const handleTabTogglePinned = async (mcpId: number, toolName: string) => {
    const d = allToolsData[mcpId];
    if (!d) return;
    const nextPinned = new Set(d.pinned);
    if (nextPinned.has(toolName)) nextPinned.delete(toolName); else nextPinned.add(toolName);
    setAllToolsData(prev => ({ ...prev, [mcpId]: { ...prev[mcpId], pinned: nextPinned } }));
    const allNames = new Set([...d.exposed, ...nextPinned]);
    await api.setExposedTools(mcpId, [...allNames].map(tn => ({ toolName: tn, exposed: d.exposed.has(tn), pinned: nextPinned.has(tn) })));
  };

  // Load tools when switching to Tools tab
  useEffect(() => {
    if (tab === 'tools' && mcps.length > 0) loadAllTools();
  }, [tab, mcps.length]);

  // ── Helpers ──

  const isOnline = (id: number) => {
    const s = connStatus[id];
    return s === 'ok';
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
      case 'running': return <span className="badge badge-success" style={{ minWidth: 52, justifyContent: 'center' }}>running</span>;
      case 'starting': return <span className="badge badge-warning" style={{ minWidth: 52, justifyContent: 'center' }}>loading</span>;
      case 'error': return <span className="badge badge-error" style={{ minWidth: 52, justifyContent: 'center' }}>error</span>;
      default: return <span className="badge badge-info" style={{ minWidth: 52, justifyContent: 'center' }}>{status}</span>;
    }
  };

  const isRemote = form.transportKind === 'streamable-http';

  // ── Shared MCP Card ──
  const McpCard = ({ mcp, isLocal }: { mcp: McpDef; isLocal: boolean }) => {
    const online = isOnline(mcp.id);
    const selected = isLocal && selectedLocalMcp?.id === mcp.id;
    return (
      <div
        className="card"
        style={{
          padding: '12px 14px',
          cursor: isLocal ? 'pointer' : undefined,
          border: selected ? '1px solid var(--accent)' : undefined,
          width: isLocal ? undefined : 260,
        }}
        onClick={isLocal ? () => handleSelectLocalMcp(mcp) : undefined}
      >
        {/* Row 1: Status + Name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          {statusDot(mcp.id)}
          <strong style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mcp.name}</strong>
          {isLocal && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-hover)', padding: '1px 6px', borderRadius: 4, flexShrink: 0 }}>
              {mcp.instanceMode}
            </span>
          )}
        </div>

        {/* Row 2: Actions (wrap allowed) */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!online}
            style={{ opacity: online ? 1 : 0.4 }}
            onClick={(e) => { e.stopPropagation(); openToolsModal(mcp); }}
          >
            Tools
          </button>
          {!isLocal && (
            <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); handleTest(mcp.id); }}>Test</button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); openEditModal(mcp); }}>Edit</button>
          <ConfirmButton onConfirm={() => handleDelete(mcp.id)}>Delete</ConfirmButton>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 className="page-title">MCP Registry</h2>
            <p className="page-subtitle">Manage registered MCP definitions</p>
          </div>
          <button className="btn btn-primary" onClick={openAddModal} style={{ visibility: tab === 'tools' ? 'hidden' : undefined }}>
            + Add {tab === 'remote' ? 'Remote' : 'Local'} MCP
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn ${tab === 'remote' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('remote')}>Remote MCPs</button>
        <button className={`btn ${tab === 'local' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('local')}>Local MCPs</button>
        <button className={`btn ${tab === 'tools' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('tools')}>Tools</button>
      </div>

      {tab !== 'tools' && (
        <div style={{ marginBottom: 16 }}>
          <input placeholder="Search by name or slug..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 320 }} />
        </div>
      )}

      {/* Remote MCPs Tab */}
      {tab === 'remote' && (
        filteredRemote.length === 0 ? (
          <div className="empty-state">
            <h3>{remoteMcps.length === 0 ? 'No remote MCPs registered' : 'No matching MCPs'}</h3>
            <p>{remoteMcps.length === 0 ? 'Add your first remote MCP to get started' : 'Try a different search term'}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {filteredRemote.map(m => <McpCard key={m.id} mcp={m} isLocal={false} />)}
          </div>
        )
      )}

      {/* Local MCPs Tab */}
      {tab === 'local' && (
        <div style={{ display: 'flex', gap: 20, minHeight: 'calc(100vh - 320px)' }}>
          {/* Left: MCP list */}
          <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredLocal.length === 0 ? (
              <div className="empty-state">
                <h3>{localMcps.length === 0 ? 'No local MCPs' : 'No matches'}</h3>
              </div>
            ) : (
              filteredLocal.map(m => <McpCard key={m.id} mcp={m} isLocal={true} />)
            )}
          </div>

          {/* Right: Instance detail */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            {selectedLocalMcp ? (
              <div className="card" style={{ flex: 1 }}>
                <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ fontSize: 16 }}>Instances - {selectedLocalMcp.name}</h3>
                  <button className="btn btn-ghost btn-sm" onClick={handleRestartMcp}>Restart All</button>
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

      {/* Tools Tab */}
      {tab === 'tools' && (
        <div>
          {allToolsLoading && mcps.length > 0 && (
            <div style={{ color: 'var(--text-muted)', padding: 16 }}>Loading tools from all MCPs...</div>
          )}
          {mcps.length === 0 ? (
            <div className="empty-state"><h3>No MCPs registered</h3><p>Add MCPs first to manage their tools</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {mcps.map(m => {
                const d = allToolsData[m.id];
                const online = isOnline(m.id);
                const collapsed = !expandedMcps.has(m.id);
                const toolCount = d?.tools?.length || 0;
                const exposedCount = d?.exposed?.size || 0;
                const pinnedCount = d?.pinned?.size || 0;

                return (
                  <div key={m.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    {/* Group header */}
                    <div
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                        cursor: 'pointer', userSelect: 'none',
                        borderBottom: collapsed ? 'none' : '1px solid var(--border)',
                      }}
                      onClick={() => toggleMcpExpand(m.id)}
                    >
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 14, textAlign: 'center' }}>{collapsed ? '\u25b6' : '\u25bc'}</span>
                      {statusDot(m.id)}
                      <strong style={{ fontSize: 14 }}>{m.name}</strong>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-hover)', padding: '1px 6px', borderRadius: 4 }}>
                        {m.transportKind === 'stdio' ? 'local' : 'remote'}
                      </span>
                      {toolCount > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {toolCount} tools{exposedCount > 0 ? `, ${exposedCount} exposed` : ''}{pinnedCount > 0 ? `, ${pinnedCount} pinned` : ''}
                        </span>
                      )}
                    </div>

                    {/* Tool list */}
                    {!collapsed && (
                      <div style={{ padding: '0 14px 10px' }}>
                        {d?.loading ? (
                          <div style={{ color: 'var(--text-muted)', padding: 12 }}>Loading...</div>
                        ) : d?.message && toolCount === 0 ? (
                          <div style={{ color: 'var(--text-muted)', padding: 12, fontSize: 13 }}>{d.message}</div>
                        ) : toolCount === 0 ? (
                          <div style={{ color: 'var(--text-muted)', padding: 12, fontSize: 13 }}>
                            {online ? 'No tools available' : 'MCP is offline — start it to discover tools'}
                          </div>
                        ) : (
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: 12, fontWeight: 600 }}>Tool</th>
                                <th style={{ padding: '6px 8px', textAlign: 'center', fontSize: 12, fontWeight: 600, width: 70 }}>Expose</th>
                                <th style={{ padding: '6px 8px', textAlign: 'center', fontSize: 12, fontWeight: 600, width: 70 }}>Pinned</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.tools.map((tool: any) => {
                                const isExposed = d.exposed.has(tool.name);
                                return (
                                  <tr key={tool.name} style={{ borderBottom: '1px solid var(--border)' }}>
                                    <td style={{ padding: '6px 8px' }}>
                                      <div style={{ fontSize: 13, fontWeight: 600 }}>{tool.name}</div>
                                      {tool.description && (
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, maxHeight: 36, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                          {tool.description}
                                        </div>
                                      )}
                                    </td>
                                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                      <input type="checkbox" checked={isExposed} onChange={() => handleTabToggleExpose(m.id, tool.name)} />
                                    </td>
                                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                      <input
                                        type="checkbox"
                                        checked={d.pinned.has(tool.name)}
                                        disabled={isExposed}
                                        style={{ opacity: isExposed ? 0.3 : 1 }}
                                        onChange={() => handleTabTogglePinned(m.id, tool.name)}
                                      />
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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

      {/* Unified Tools Modal */}
      {toolsMcp && (
        <div className="modal-overlay" onClick={() => setToolsMcp(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <h3 className="modal-title">Tools - {toolsMcp.name}</h3>

            {toolsLoading ? (
              <div style={{ color: 'var(--text-muted)', padding: 24, textAlign: 'center' }}>Loading tools...</div>
            ) : toolsMessage && toolsList.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', padding: 24, textAlign: 'center' }}>{toolsMessage}</div>
            ) : toolsList.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', padding: 24, textAlign: 'center' }}>No tools available</div>
            ) : (
              <>
                {/* Options section header */}
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.8 }}>
                  <div><b>Expose</b> — tool bypasses search_tools, directly available to AI</div>
                  <div><b>Pinned</b> — tool always appears in search_tools results</div>
                </div>

                <div style={{ maxHeight: 450, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg-primary, #1a1a2e)' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600 }}>Tool</th>
                        <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: 12, fontWeight: 600, width: 70 }}>Expose</th>
                        <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: 12, fontWeight: 600, width: 70 }}>Pinned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {toolsList.map((tool: any) => (
                        <tr key={tool.name} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '8px 12px' }}>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{tool.name}</div>
                            {tool.description && (
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, maxHeight: 40, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {tool.description}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={toolsExposed.has(tool.name)}
                              onChange={() => handleToggleTool(tool.name)}
                            />
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={toolsPinned.has(tool.name)}
                              disabled={toolsExposed.has(tool.name)}
                              style={{ opacity: toolsExposed.has(tool.name) ? 0.3 : 1 }}
                              onChange={() => handleTogglePinned(tool.name)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                  {toolsExposed.size} exposed, {toolsPinned.size} pinned of {toolsList.length} tools
                </div>
              </>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setToolsMcp(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

