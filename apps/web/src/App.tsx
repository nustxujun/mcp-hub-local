import React from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import { McpsPage } from './pages/McpsPage';
import { WorkspacesPage } from './pages/WorkspacesPage';
import { SessionsPage } from './pages/SessionsPage';
import { LogsPage } from './pages/LogsPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { MessageBoxProvider } from './components/MessageBox';
import './App.css';

const navItems = [
  { to: '/', label: 'Sessions', end: true },
  { to: '/mcps', label: 'MCPs' },
  { to: '/workspaces', label: 'Workspaces' },
  { to: '/logs', label: 'Logs' },
  { to: '/stats', label: 'Stats' },
  { to: '/settings', label: 'Settings' },
];

export function App() {
  return (
    <MessageBoxProvider>
      <div className="app-layout">
        <nav className="topbar">
          <div className="topbar-brand">
            <h1 className="topbar-title">MCP Hub Local</h1>
            <span className="topbar-version">v0.1.0</span>
          </div>
          <ul className="nav-list">
            {navItems.map(item => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="main-content">
          <Routes>
            <Route path="/" element={<SessionsPage />} />
            <Route path="/mcps" element={<McpsPage />} />
            <Route path="/workspaces" element={<WorkspacesPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </MessageBoxProvider>
  );
}
