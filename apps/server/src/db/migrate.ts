import type Database from 'better-sqlite3';

export function runMigrations(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mcp_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      transport_kind TEXT NOT NULL,
      instance_mode TEXT NOT NULL DEFAULT 'per-workspace',
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_mcp_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      mcp_id INTEGER NOT NULL REFERENCES mcp_definitions(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      instance_mode_override TEXT,
      UNIQUE(workspace_id, mcp_id)
    );

    CREATE TABLE IF NOT EXISTS runtime_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mcp_id INTEGER NOT NULL REFERENCES mcp_definitions(id) ON DELETE CASCADE,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      instance_mode TEXT NOT NULL,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'starting',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      level TEXT NOT NULL DEFAULT 'info',
      category TEXT NOT NULL DEFAULT 'general',
      workspace_id INTEGER,
      runtime_instance_id INTEGER,
      mcp_id INTEGER,
      message TEXT NOT NULL,
      payload_preview TEXT,
      payload_truncated INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_logs_keyset ON logs(timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_workspace ON logs(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_logs_mcp ON logs(mcp_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `);

  // Migration: add session_id column to logs
  try {
    sqlite.exec(`ALTER TABLE logs ADD COLUMN session_id TEXT`);
  } catch { /* column already exists */ }
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id)`);

  // Migration: drop legacy tables/columns from older versions
  try {
    sqlite.exec(`DROP TABLE IF EXISTS sessions`);
  } catch { /* ignore */ }

  // Migration: remove protocol_session_id column if exists (SQLite doesn't support DROP COLUMN before 3.35)
  // We handle this by checking if the column exists and ignoring it if present — the ORM won't reference it.

  // Seed default settings if not present
  const existing = sqlite.prepare('SELECT key FROM settings WHERE key = ?').get('syncClients');
  if (!existing) {
    sqlite.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(
      'syncClients',
      JSON.stringify({ clients: [] })
    );
    sqlite.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(
      'logOptions',
      JSON.stringify({ pageSize: 50, retentionDays: 30 })
    );
    sqlite.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(
      'port',
      JSON.stringify(3000)
    );
  }
}
