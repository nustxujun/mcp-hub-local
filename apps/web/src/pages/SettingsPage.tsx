import React, { useEffect, useState, useRef } from 'react';
import * as api from '../api';

const CLIENT_OPTIONS = ['cursor', 'claude', 'codex', 'gemini'] as const;

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [dataDir, setDataDir] = useState<string>('');
  const [importStatus, setImportStatus] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const [data, info] = await Promise.all([
      api.getSettings(),
      api.getSettingsInfo().catch(() => ({ dataDir: '' })),
    ]);
    setSettings(data);
    setDataDir(info.dataDir || '');
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await api.patchSettings(settings);
      setSettings(updated);
    } finally {
      setSaving(false);
    }
  };

  const syncClients = (settings.syncClients as { clients: string[] })?.clients || [];

  const toggleClient = (client: string) => {
    const current = [...syncClients];
    const idx = current.indexOf(client);
    if (idx >= 0) {
      current.splice(idx, 1);
    } else {
      current.push(client);
    }
    setSettings(s => ({ ...s, syncClients: { clients: current } }));
  };

  const logOptions = settings.logOptions || { pageSize: 50, retentionDays: 30 };

  const handleClearLogs = async () => {
    if (!window.confirm('Are you sure you want to clear all logs? This action cannot be undone.')) return;
    setClearingLogs(true);
    try {
      await api.clearLogs();
    } finally {
      setClearingLogs(false);
    }
  };

  const handleShutdown = async () => {
    if (!window.confirm('Are you sure you want to shut down the server? You will need to restart it manually.')) return;
    setShuttingDown(true);
    try {
      await api.shutdownServer();
    } catch {
      // Server may close connection before responding — that's expected
    } finally {
      setShuttingDown(false);
    }
  };

  const handleOpenDataDir = () => {
    if (dataDir) {
      navigator.clipboard.writeText(dataDir).then(() => {}).catch(() => {});
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const config = await api.exportConfig();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mcp-hub-local-config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setImportStatus({ message: `Export failed: ${e.message}`, type: 'error' });
    } finally {
      setExporting(false);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setImportStatus(null);
    try {
      const text = await file.text();
      const config = JSON.parse(text);
      const result = await api.importConfig(config);
      const msg = `Import complete: ${result.created} items created.` +
        (result.errors?.length ? ` Warnings: ${result.errors.join('; ')}` : '');
      setImportStatus({ message: msg, type: result.errors?.length ? 'error' : 'success' });
    } catch (e: any) {
      setImportStatus({ message: `Import failed: ${e.message}`, type: 'error' });
    } finally {
      setImporting(false);
      // Reset file input so same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2 className="page-title">Settings</h2>
        <p className="page-subtitle">Configure hub settings</p>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 16, marginBottom: 16 }}>General</h3>
        <div className="form-group">
          <label className="form-label">Port</label>
          <input className="form-input" type="number" value={settings.port ?? 3000} onChange={e => setSettings(s => ({ ...s, port: parseInt(e.target.value) || 3000 }))} style={{ width: 120 }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>Requires restart</span>
        </div>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 16, marginBottom: 4 }}>
          PTC (Programmatic Tool Calling)
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: 8 }}>⚗️ Preview features</span>
        </h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
          Enable PTC mode. When enabled, AI clients will only see <code>search_tools</code> and <code>execute_code</code> instead of individual MCP tools.
          AI can search for available tools and write code to call them.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.enablePTC !== false}
            onChange={e => setSettings(s => ({ ...s, enablePTC: e.target.checked }))}
          />
          <span>Enable PTC</span>
        </label>
        <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 8 }}>
          Default: enabled. When on, <code>tools/list</code> returns only <code>search_tools</code> and <code>execute_code</code>. Existing sessions need to reconnect.
        </p>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 16, marginBottom: 16 }}>Auto-Sync Clients</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
          Select which clients should receive automatic MCP configuration sync when workspace bindings change.
        </p>
        <div style={{ display: 'flex', gap: 16 }}>
          {CLIENT_OPTIONS.map(client => (
            <label key={client} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={syncClients.includes(client)} onChange={() => toggleClient(client)} />
              <span style={{ textTransform: 'capitalize' }}>{client}</span>
            </label>
          ))}
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 8 }}>
          Removing a client stops future sync but does not clean up existing managed configurations.
        </p>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 16, marginBottom: 16 }}>Log Options</h3>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Page Size (entries per page)</label>
            <input className="form-input" type="number" value={logOptions.pageSize} onChange={e => setSettings(s => ({ ...s, logOptions: { ...logOptions, pageSize: parseInt(e.target.value) || 50 } }))} style={{ width: 100 }} />
          </div>
          <div className="form-group">
            <label className="form-label">Retention (days)</label>
            <input className="form-input" type="number" value={logOptions.retentionDays} onChange={e => setSettings(s => ({ ...s, logOptions: { ...logOptions, retentionDays: parseInt(e.target.value) || 30 } }))} style={{ width: 100 }} />
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-danger" onClick={handleClearLogs} disabled={clearingLogs}>
            {clearingLogs ? 'Clearing...' : 'Clear All Logs'}
          </button>
          <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>Permanently deletes all log entries</span>
        </div>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 16, marginBottom: 16 }}>Data Directory</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
          Database and log data are stored in this directory.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <code style={{ fontSize: 13, color: 'var(--accent)', background: 'var(--bg-hover)', padding: '6px 12px', borderRadius: 'var(--radius)', flex: 1 }}>
            {dataDir || 'Loading...'}
          </code>
          <button className="btn btn-ghost btn-sm" onClick={handleOpenDataDir} title="Copy path to clipboard" disabled={!dataDir}>
            Copy Path
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 16, marginBottom: 16 }}>Configuration</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
          Export or import your complete hub configuration (MCPs, Workspaces, and Bindings).
          Import will replace all existing data.
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="btn btn-ghost" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Exporting...' : 'Export Config'}
          </button>
          <button className="btn btn-ghost" onClick={handleImportClick} disabled={importing}>
            {importing ? 'Importing...' : 'Import Config'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleFileSelected}
          />
        </div>
        {importStatus && (
          <p style={{
            marginTop: 12,
            fontSize: 13,
            color: importStatus.type === 'success' ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)',
          }}>
            {importStatus.message}
          </p>
        )}
      </div>

      <div className="card">
        <h3 style={{ fontSize: 16, marginBottom: 16 }}>Server</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
          Gracefully shut down the hub server. All running MCPs will be stopped and connections closed.
        </p>
        <button className="btn btn-danger" onClick={handleShutdown} disabled={shuttingDown}>
          {shuttingDown ? 'Shutting down...' : 'Shutdown Server'}
        </button>
        <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>Requires manual restart</span>
      </div>

      <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}
