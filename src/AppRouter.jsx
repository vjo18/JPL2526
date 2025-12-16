import React from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";

// ✅ pas deze imports aan naar jouw twee dashboards
import DashboardA from "./App.jsx";
import DashboardB from "./app_scoutingapp.jsx";

const linkStyle = ({ isActive }) => ({
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid #e5e7eb",
  background: isActive ? "#111827" : "white",
  color: isActive ? "white" : "#111827",
  textDecoration: "none",
  fontWeight: 700,
  fontSize: 13,
});

export default function AppRouter() {
  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <NavLink to="/dashboard-a" style={linkStyle}>
          League Stats
        </NavLink>
        <NavLink to="/dashboard-b" style={linkStyle}>
          Player Scouting
        </NavLink>
      </div>

      <Routes>
        <Route path="/" element={<Navigate to="/dashboard-a" replace />} />
        <Route path="/dashboard-a" element={<DashboardA />} />
        <Route path="/dashboard-b" element={<DashboardB />} />
      </Routes>
    </div>
  );
}
