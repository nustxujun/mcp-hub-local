const BASE = '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...init?.headers as Record<string, string> };
  if (init?.body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
  });
  if (res.status === 204) return undefined as unknown as T;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

// ── MCPs ──
export const listMcps = () => request<any[]>('/api/mcps');
export const createMcp = (data: any) => request<any>('/api/mcps', { method: 'POST', body: JSON.stringify(data) });
export const updateMcp = (id: number, data: any) => request<any>(`/api/mcps/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteMcp = (id: number) => request<void>(`/api/mcps/${id}`, { method: 'DELETE' });
export const testMcp = (id: number) => request<any>(`/api/mcps/${id}/test`, { method: 'POST' });
export const startMcp = (id: number) => request<any>(`/api/mcps/${id}/start`, { method: 'POST' });
export const restartMcp = (id: number) => request<any>(`/api/mcps/${id}/restart`, { method: 'POST' });
export const batchTestMcps = () => request<Record<number, { ok: boolean; status?: number; error?: string }>>('/api/mcps/batch-test');
export const getHealthStatus = () => request<Record<number, { ok: boolean; status?: number; error?: string; checkedAt?: string }>>('/api/mcps/health');
export const listRuntimeInstances = () => request<any[]>('/api/runtime-instances');
export const deleteRuntimeInstance = (id: number) => request<void>(`/api/runtime-instances/${id}`, { method: 'DELETE' });

// ── Tool Exposure ──
export const getMcpTools = (mcpId: number) => request<{ tools: any[]; message?: string }>(`/api/mcps/${mcpId}/tools`);
export const getExposedTools = (mcpId: number) => request<Array<{ toolName: string; exposed: boolean; pinned: boolean }>>(`/api/mcps/${mcpId}/exposed-tools`);
export const setExposedTools = (mcpId: number, tools: Array<{ toolName: string; exposed?: boolean; pinned?: boolean }>) => request<any>(`/api/mcps/${mcpId}/exposed-tools`, { method: 'PUT', body: JSON.stringify({ tools }) });

// ── Workspaces ──
export const listWorkspaces = () => request<any[]>('/api/workspaces');
export const getWorkspace = (id: number) => request<any>(`/api/workspaces/${id}`);
export const createWorkspace = (data: any) => request<any>('/api/workspaces', { method: 'POST', body: JSON.stringify(data) });
export const updateWorkspace = (id: number, data: any) => request<any>(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteWorkspace = (id: number) => request<void>(`/api/workspaces/${id}`, { method: 'DELETE' });

// ── Bindings ──
export const listBindings = (workspaceId: number) => request<any[]>(`/api/workspaces/${workspaceId}/bindings`);
export const setBinding = (workspaceId: number, data: any) => request<any>(`/api/workspaces/${workspaceId}/bindings`, { method: 'PUT', body: JSON.stringify(data) });
export const removeBinding = (workspaceId: number, mcpId: number) => request<void>(`/api/workspaces/${workspaceId}/bindings/${mcpId}`, { method: 'DELETE' });

// ── Client configs ──
export const getClientConfigs = (workspaceId: number) => request<any>(`/api/workspaces/${workspaceId}/client-configs`);
export const syncWorkspace = (workspaceId: number) => request<any>(`/api/workspaces/${workspaceId}/sync`, { method: 'POST' });

// ── Sessions ──
export const listSessions = () => request<any[]>('/api/sessions');
export const deleteSession = (sessionId: string) => request<void>(`/api/sessions/${sessionId}`, { method: 'DELETE' });
export const restartSession = (sessionId: string) => request<any>(`/api/sessions/${sessionId}/restart`, { method: 'POST' });

// ── Logs ──
export const queryLogs = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request<any>(`/api/logs${qs}`);
};
export const clearLogs = () => request<void>('/api/logs', { method: 'DELETE' });

// ── Stats ──
export const getStatsSummary = () => request<any>('/api/stats/summary');
export const getToolStats = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request<any[]>(`/api/stats/tools${qs}`);
};
export const getMcpStats = () => request<any[]>('/api/stats/mcps');
export const getRecentCalls = (limit = 20) => request<any[]>(`/api/stats/recent?limit=${limit}`);
export const getSlowestCalls = () => request<any[]>('/api/stats/slowest');
export const clearStats = () => request<void>('/api/stats', { method: 'DELETE' });

// ── Settings ──
export const getSettings = () => request<any>('/api/settings');
export const patchSettings = (data: any) => request<any>('/api/settings', { method: 'PATCH', body: JSON.stringify(data) });
export const getSettingsInfo = () => request<{ dataDir: string }>('/api/settings/info');
export const shutdownServer = () => request<{ ok: boolean }>('/api/shutdown', { method: 'POST' });

// ── Config Import / Export ──
export const exportConfig = () => request<any>('/api/config/export');
export const importConfig = (data: any, mode: 'replace' | 'merge' = 'replace') =>
  request<any>(`/api/config/import?mode=${mode}`, { method: 'POST', body: JSON.stringify(data) });
