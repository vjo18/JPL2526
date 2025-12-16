import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Scouting Dashboard (profiles-first, dynamic cutoffs)
 *
 * Updates in v4:
 * 1) Profile explanation now shows as 4 compact boxes NEXT TO each other (same top row as controls).
 * 2) Hover-card on player name shows richer info (Explain_*, Reliability, Minutes_factor, etc.) if present.
 * 3) Click player name opens a details modal with optional season evolution chart.
 *    - Works if history is available either:
 *      a) embedded per row as row.History (array of matchweeks/rounds), OR
 *      b) in a separate JSON file: /public/data/player_history.json
 *         Format: { "<Team>__<Speler>": [ {Round: 1, FinalScoutingScore: ..., ImpactScore: ..., Confidence: ..., Speelminuten: ...}, ... ] }
 *
 * Notes:
 * - If you don't have history data yet, the modal will explain what to add.
 */

const DEFAULTS = {
  minMinutesPct: 60,
  profileImpactPctElite: 85,
  profileImpactPctUpside: 85,
  profileImpactPctReliable: 60,
  profileConfPctElite: 60,
  profileConfPctReliable: 75,
  profileConfPctHighRisk: 35,
};

// --- Profile pill colors (gebruik overal dezelfde visual) ---
const profilePillBase = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid transparent",
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1,
  whiteSpace: "nowrap",
};

const PROFILE_PILL = {
  Elite: { background: "#E7F6EC", borderColor: "#BFE7CB", color: "#136F33" },
  "High-upside": { background: "#E8F1FF", borderColor: "#C7DCFF", color: "#1D4ED8" },
  "Reliable regular": { background: "#F1E9FF", borderColor: "#DCCBFF", color: "#6D28D9" },
  "High risk": { background: "#FDE8E8", borderColor: "#F8C7C7", color: "#B91C1C" },
  Other: { background: "#F3F4F6", borderColor: "#E5E7EB", color: "#374151" },
};

function ProfilePill({ profile }) {
  const style = PROFILE_PILL[profile] || PROFILE_PILL.Other;
  return <span style={{ ...profilePillBase, ...style }}>{profile}</span>;
}


function toNum(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function fmt(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}
function quantile(sortedArr, q) {
  const n = sortedArr.length;
  if (!n) return NaN;
  if (q <= 0) return sortedArr[0];
  if (q >= 1) return sortedArr[n - 1];
  const pos = (n - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = sortedArr[base];
  const b = sortedArr[Math.min(base + 1, n - 1)];
  return a + rest * (b - a);
}
function percentileCutoff(values, pct) {
  const arr = values
    .map((x) => toNum(x, NaN))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  return quantile(arr, pct / 100);
}

function isKeeperType(typeStr) {
  const t = String(typeStr ?? "").toLowerCase();
  return t.includes("keeper") || t.includes("goal") || t === "gk" || t.includes("doel");
}

function playerKey(row) {
  const team = row.Team ?? row.Club ?? row.team ?? "";
  const name = row.Speler ?? row.Player ?? row.Naam ?? row.Name ?? "Unknown";
  return `${team}__${name}`;
}

function normalizePlayerRow(row) {
  const team = row.Team ?? row.Club ?? row.team ?? "";
  const name = row.Speler ?? row.Player ?? row.Naam ?? row.Name ?? "Unknown";
  const mins = toNum(row.Speelminuten ?? row.Minutes ?? row.Mins ?? 0, 0);

  const fss = toNum(row.FinalScoutingScore ?? row.FSS ?? row.finalScore, NaN);
  const impact = toNum(row.ImpactScore ?? row.Impact ?? row.impactScore, NaN);
  const conf = toNum(row.Confidence ?? row.confidence, NaN);
  const stability = toNum(row.StabilityScore ?? row.Stability ?? row.stabilityScore, NaN);

  const starts = toNum(row.Gestart ?? row.Starts ?? 0, 0);
  const subs = toNum(row.Ingevallen ?? row.Subs ?? 0, 0);
  const g90 = toNum(row["Goals/90min"] ?? row.Goals90 ?? row.g90, NaN);
  const y90 = toNum(row["Geel/90min"] ?? row.Yellow90 ?? row.y90, NaN);

  const type = row.Type ?? row.type ?? "";
  const key = playerKey({ ...row, Team: team, Speler: name });

  return {
    ...row,
    Team: team,
    Speler: name,
    _key: key,
    _name: name,
    _team: team,
    _type: type,
    _mins: mins,
    _fss: fss,
    _impact: impact,
    _conf: conf,
    _stability: stability,
    _starts: starts,
    _subs: subs,
    _g90: g90,
    _y90: y90,
  };
}

function computeCutoffs(players, cfg) {
  const impacts = players.map((p) => p._impact);
  const confs = players.map((p) => p._conf);

  return {
    impactElite: percentileCutoff(impacts, cfg.profileImpactPctElite),
    impactUpside: percentileCutoff(impacts, cfg.profileImpactPctUpside),
    impactReliable: percentileCutoff(impacts, cfg.profileImpactPctReliable),
    confElite: percentileCutoff(confs, cfg.profileConfPctElite),
    confReliable: percentileCutoff(confs, cfg.profileConfPctReliable),
    confHighRisk: percentileCutoff(confs, cfg.profileConfPctHighRisk),
  };
}

function classifyProfile(p, cut) {
  const hasImpact = Number.isFinite(p._impact);
  const hasConf = Number.isFinite(p._conf);

  if (hasImpact && hasConf && p._impact >= cut.impactElite && p._conf >= cut.confElite) return "Elite";
  if (hasImpact && hasConf && p._impact >= cut.impactUpside && p._conf < cut.confElite) return "High-upside";
  if (hasImpact && hasConf && p._impact >= cut.impactReliable && p._conf >= cut.confReliable) return "Reliable regular";
  if (hasConf && p._conf <= cut.confHighRisk) return "High risk";
  return "Other";
}

function passesNumericFilter(value, expr) {
  if (!expr) return true;
  const v = toNum(value, NaN);
  if (!Number.isFinite(v)) return false;

  const s = String(expr).trim().replace(",", ".");
  const m = s.match(/^([<>]=?|=)\s*(-?\d+(\.\d+)?)$/);
  if (m) {
    const op = m[1];
    const x = Number(m[2]);
    if (!Number.isFinite(x)) return true;
    if (op === "=") return v === x;
    if (op === ">") return v > x;
    if (op === ">=") return v >= x;
    if (op === "<") return v < x;
    if (op === "<=") return v <= x;
    return true;
  }

  const r = s.match(/^(-?\d+(\.\d+)?)\s*-\s*(-?\d+(\.\d+)?)$/);
  if (r) {
    const a = Number(r[1]);
    const b = Number(r[3]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return v >= lo && v <= hi;
  }

  const x = Number(s);
  if (Number.isFinite(x)) return v >= x;
  return true;
}

function compare(a, b, dir) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return dir === "asc" ? a - b : b - a;
  const as = String(a).toLowerCase();
  const bs = String(b).toLowerCase();
  return dir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function getHistoryForPlayer(p, historyMap) {
  // 1) embedded history
  const embedded = p?.History;
  if (Array.isArray(embedded) && embedded.length) return embedded;

  // 2) external map keyed by <Team>__<Speler>
  const k = p?._key;
  const fromMap = k ? historyMap?.[k] : null;
  if (Array.isArray(fromMap) && fromMap.length) return fromMap;

  return [];
}

function normalizeHistoryRow(h) {
  const round = toNum(h.Round ?? h.Speelronde ?? h.Matchweek ?? h.GW ?? h.ronde, NaN);
  const mins = toNum(h.Speelminuten ?? h.Minutes ?? h.Mins ?? 0, 0);
  const fss = toNum(h.FinalScoutingScore ?? h.FSS ?? h.finalScore, NaN);
  const impact = toNum(h.ImpactScore ?? h.Impact ?? h.impactScore, NaN);
  const conf = toNum(h.Confidence ?? h.confidence, NaN);
  return { ...h, _round: round, _mins: mins, _fss: fss, _impact: impact, _conf: conf };
}

function Sparkline({ values, width = 420, height = 120 }) {
  const xs = values.map((d) => d.x);
  const ys = values.map((d) => d.y).filter((y) => Number.isFinite(y));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = ys.length ? Math.min(...ys) : 0;
  const yMax = ys.length ? Math.max(...ys) : 1;

  const pad = 10;
  const w = width - pad * 2;
  const h = height - pad * 2;

  function sx(x) {
    if (xMax === xMin) return pad + w / 2;
    return pad + ((x - xMin) / (xMax - xMin)) * w;
  }
  function sy(y) {
    if (yMax === yMin) return pad + h / 2;
    return pad + (1 - (y - yMin) / (yMax - yMin)) * h;
  }

  const points = values
    .filter((d) => Number.isFinite(d.y) && Number.isFinite(d.x))
    .sort((a, b) => a.x - b.x)
    .map((d) => `${sx(d.x)},${sy(d.y)}`)
    .join(" ");

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <rect x="0" y="0" width={width} height={height} fill="transparent" />
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
      {/* baseline */}
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#ddd" />
      {/* y range label */}
      <text x={pad} y={pad + 10} fontSize="11" fill="#666">
        {fmt(yMax, 2)}
      </text>
      <text x={pad} y={height - pad} fontSize="11" fill="#666" dominantBaseline="ideographic">
        {fmt(yMin, 2)}
      </text>
    </svg>
  );
}

function ProfileBox({ title, desc, lines }) {
  return (
    <div style={styles.profileBox}>
      <div style={{ marginBottom: 6 }}><ProfilePill profile={title} /></div>
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>{desc}</div>
      <div style={{ fontSize: 12, opacity: 0.9 }}>
        {lines.map((x) => (
          <div key={x}>• {x}</div>
        ))}
      </div>
    </div>
  );
}

function HoverCard({ trigger, children }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {trigger}
      {open ? <span style={styles.hoverCard}>{children}</span> : null}
    </span>
  );
}

function Modal({ open, onClose, title, children }) {
  const backdropRef = useRef(null);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      onMouseDown={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      style={styles.modalBackdrop}
    >
      <div style={styles.modalCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 16, flex: 1 }}>{title}</div>
          <button onClick={onClose} style={styles.btn}>
            Sluiten
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [rawRows, setRawRows] = useState([]);
  const [loadingErr, setLoadingErr] = useState("");

  const [historyMap, setHistoryMap] = useState({});
  const [historyNote, setHistoryNote] = useState("");

  const [globalSearch, setGlobalSearch] = useState("");
  const [profileFilter, setProfileFilter] = useState("ALL");
  const [minMinutesPct, setMinMinutesPct] = useState(DEFAULTS.minMinutesPct);

  const [showSpelers, setShowSpelers] = useState(true);
  const [showKeepers, setShowKeepers] = useState(true);

  const [sortKey, setSortKey] = useState("_fss");
  const [sortDir, setSortDir] = useState("desc");

  const [colFilters, setColFilters] = useState({
    mins: "",
    fss: "",
    impact: "",
    conf: "",
    starts: "",
    subs: "",
    g90: "",
    y90: "",
  });

  const [selected, setSelected] = useState(null);
  const [metric, setMetric] = useState("FinalScoutingScore");

  // Load player_stats.json
  useEffect(() => {
    let cancelled = false;

    async function loadMain() {
      setLoadingErr("");
      const base = (import.meta?.env?.BASE_URL ?? "/").replace(/\/+$/, "/");
      const candidates = [
        `${base}data/player_stats.json`,
        `${base}player_stats.json`,
        "/data/player_stats.json",
        "/player_stats.json",
        "data/player_stats.json",
        "player_stats.json",
      ];

      let lastErr = "";
      for (const url of candidates) {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) {
            lastErr = `${url} → HTTP ${res.status}`;
            continue;
          }
          const data = await res.json();

          let rows = [];
          if (Array.isArray(data)) {
            rows = data;
          } else if (data && typeof data === "object") {
            const entries = Object.entries(data);
            const looksLikeTeamMap = entries.length > 0 && entries.every(([, v]) => Array.isArray(v));
            if (looksLikeTeamMap) {
              rows = entries.flatMap(([team, arr]) => arr.map((r) => ({ ...r, Team: team })));
            } else if (Array.isArray(data.players)) {
              rows = data.players;
            }
          }

          if (!cancelled) setRawRows(rows);
          return;
        } catch (e) {
          lastErr = `${url} → ${e?.message ?? String(e)}`;
        }
      }

      if (!cancelled) {
        setRawRows([]);
        setLoadingErr(
          [
            "Kon player_stats.json niet laden (of JSON-structuur niet herkend).",
            "Tip: export_json_local.py schrijft typisch naar public/data/player_stats.json.",
            "",
            "Geprobeerd:",
            ...candidates.map((c) => ` - ${c}`),
            "",
            `Laatste fout: ${lastErr}`,
          ].join("\n")
        );
      }
    }

    loadMain();
    return () => {
      cancelled = true;
    };
  }, []);

  // OPTIONAL: Load history file if present
  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      const base = (import.meta?.env?.BASE_URL ?? "/").replace(/\/+$/, "/");
      const candidates = [
        `${base}data/player_history.json`,
        "/data/player_history.json",
        "data/player_history.json",
      ];

      for (const url of candidates) {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) continue;
          const data = await res.json();
          if (!cancelled && data && typeof data === "object") {
            setHistoryMap(data);
            setHistoryNote(`History loaded from ${url}`);
          }
          return;
        } catch {
          // ignore
        }
      }

      if (!cancelled) setHistoryNote("No player_history.json found (optional).");
    }

    loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

  const cfg = useMemo(() => ({ ...DEFAULTS, minMinutesPct }), [minMinutesPct]);

  const allPlayers = useMemo(() => rawRows.map(normalizePlayerRow), [rawRows]);

  const contextPlayers = useMemo(() => {
    if (showSpelers && showKeepers) return allPlayers;
    if (!showSpelers && !showKeepers) return [];
    return allPlayers.filter((p) => {
      const isK = isKeeperType(p._type);
      return showKeepers ? isK : !isK;
    });
  }, [allPlayers, showSpelers, showKeepers]);

  const minsCutoff = useMemo(() => {
    const mins = contextPlayers.map((p) => p._mins);
    const pct = Math.max(0, Math.min(95, cfg.minMinutesPct));
    return percentileCutoff(mins, pct);
  }, [contextPlayers, cfg.minMinutesPct]);

  // 1) Basis voor cutoffs: context + minuten cutoff (GEEN search)
  const cutoffBasePlayers = useMemo(() => {
    const mc = minsCutoff;
    return contextPlayers.filter((p) => !Number.isFinite(mc) || p._mins >= mc);
  }, [contextPlayers, minsCutoff]);

  // 2) Wat je effectief toont: cutoff base + search
  const filteredPlayers = useMemo(() => {
    const q = globalSearch.trim().toLowerCase();
    return q
      ? cutoffBasePlayers.filter((p) => `${p._name} ${p._team} ${p._type}`.toLowerCase().includes(q))
      : cutoffBasePlayers;
  }, [cutoffBasePlayers, globalSearch]);


  const cutoffs = useMemo(() => computeCutoffs(cutoffBasePlayers, cfg), [cutoffBasePlayers, cfg]);


  const scoutedPlayers = useMemo(() => {
    return filteredPlayers.map((p) => {
      const profile = classifyProfile(p, cutoffs);
      return { ...p, _profile: profile };
    });
  }, [filteredPlayers, cutoffs]);

  const profileOptions = useMemo(() => {
    const set = new Set(scoutedPlayers.map((p) => p._profile));
    return ["ALL", ...Array.from(set)];
  }, [scoutedPlayers]);

  const tableRows = useMemo(() => {
    const afterProfile = profileFilter === "ALL" ? scoutedPlayers : scoutedPlayers.filter((p) => p._profile === profileFilter);

    const afterColFilters = afterProfile.filter((p) => {
      return (
        passesNumericFilter(p._mins, colFilters.mins) &&
        passesNumericFilter(p._fss, colFilters.fss) &&
        passesNumericFilter(p._impact, colFilters.impact) &&
        passesNumericFilter(p._conf, colFilters.conf) &&
        passesNumericFilter(p._starts, colFilters.starts) &&
        passesNumericFilter(p._subs, colFilters.subs) &&
        passesNumericFilter(p._g90, colFilters.g90) &&
        passesNumericFilter(p._y90, colFilters.y90)
      );
    });

    return [...afterColFilters].sort((a, b) => compare(a[sortKey], b[sortKey], sortDir));
  }, [scoutedPlayers, profileFilter, colFilters, sortKey, sortDir]);

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const minsCutoffText = Number.isFinite(minsCutoff) ? `${Math.round(minsCutoff)}` : "—";

  const profileBoxes = useMemo(() => {
    return [
      {
        title: "Elite",
        desc: "Directe versterking: top impact + voldoende zekerheid.",
        lines: [
          `ImpactScore ≥ ${fmt(cutoffs.impactElite, 2)} (P${cfg.profileImpactPctElite})`,
          `Confidence ≥ ${fmt(cutoffs.confElite, 2)} (P${cfg.profileConfPctElite})`,
        ],
      },
      {
        title: "High-upside",
        desc: "Top impact, maar lagere zekerheid: groeiprofiel / buy early.",
        lines: [
          `ImpactScore ≥ ${fmt(cutoffs.impactUpside, 2)} (P${cfg.profileImpactPctUpside})`,
          `Confidence < ${fmt(cutoffs.confElite, 2)} (P${cfg.profileConfPctElite})`,
        ],
      },
      {
        title: "Reliable regular",
        desc: "Goede impact met hoge betrouwbaarheid (hoge floor).",
        lines: [
          `ImpactScore ≥ ${fmt(cutoffs.impactReliable, 2)} (P${cfg.profileImpactPctReliable})`,
          `Confidence ≥ ${fmt(cutoffs.confReliable, 2)} (P${cfg.profileConfPctReliable})`,
        ],
      },
      {
        title: "High risk",
        desc: "Grotere foutmarge: lage zekerheid/instabiliteit (extra context nodig).",
        lines: [`Confidence ≤ ${fmt(cutoffs.confHighRisk, 2)} (P${cfg.profileConfPctHighRisk})`],
      },
    ];
  }, [cutoffs, cfg]);

  const selectedHistory = useMemo(() => {
    if (!selected) return [];
    const hist = getHistoryForPlayer(selected, historyMap).map(normalizeHistoryRow);
    return hist
      .filter((h) => Number.isFinite(h._round))
      .sort((a, b) => a._round - b._round);
  }, [selected, historyMap]);

  const chartValues = useMemo(() => {
    const m = metric;
    const keyToY = {
      FinalScoutingScore: (h) => h._fss,
      ImpactScore: (h) => h._impact,
      Confidence: (h) => h._conf,
      Speelminuten: (h) => h._mins,
    };
    const fn = keyToY[m] ?? keyToY.FinalScoutingScore;
    return selectedHistory.map((h) => ({ x: h._round, y: fn(h) }));
  }, [selectedHistory, metric]);

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
      <h2 style={{ margin: "0 0 10px 0" }}>Scouting Dashboard</h2>

      {loadingErr ? (
        <pre style={{ whiteSpace: "pre-wrap", background: "#fff3f3", padding: 12, border: "1px solid #ffd0d0", borderRadius: 8 }}>
          {loadingErr}
        </pre>
      ) : null}

      {/* One-row top controls + profile boxes */}
      <div style={styles.topRow}>
        <div style={styles.controlsRow}>
          <div style={styles.control}>
            <label style={styles.label}>Search</label>
            <input value={globalSearch} onChange={(e) => setGlobalSearch(e.target.value)} placeholder="Naam / team / type…" style={styles.input} />
          </div>

          <div style={styles.control}>
            <label style={styles.label}>Profiel</label>
            <select value={profileFilter} onChange={(e) => setProfileFilter(e.target.value)} style={styles.select}>
              {profileOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div style={styles.control}>
            <label style={styles.label}>Minuten cutoff (percentiel)</label>
            <input type="range" min={0} max={95} step={1} value={minMinutesPct} onChange={(e) => setMinMinutesPct(Number(e.target.value))} style={{ width: 220 }} />
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              P{minMinutesPct} → mins ≥ {minsCutoffText}
            </div>
          </div>

          <div style={styles.control}>
            <label style={styles.label}>Type</label>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={showSpelers} onChange={(e) => setShowSpelers(e.target.checked)} />
                Speler
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={showKeepers} onChange={(e) => setShowKeepers(e.target.checked)} />
                Keeper
              </label>
            </div>
          </div>
        </div>

        <div style={styles.profileRow}>
          {profileBoxes.map((b) => (
            <ProfileBox key={b.title} title={b.title} desc={b.desc} lines={b.lines} />
          ))}
        </div>
      </div>

      <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#fafafa" }}>
              <th style={thFilterLeft}></th>
              <th style={thFilterCenter}></th>
              <th style={thFilterCenter}>
                <input style={filterInput} value={colFilters.mins} onChange={(e) => setColFilters((s) => ({ ...s, mins: e.target.value }))} placeholder=">=1200" />
              </th>
              <th style={thFilterCenter}>
                <input style={filterInput} value={colFilters.fss} onChange={(e) => setColFilters((s) => ({ ...s, fss: e.target.value }))} placeholder=">=0.50" />
              </th>
              <th style={thFilterCenter}>
                <input style={filterInput} value={colFilters.impact} onChange={(e) => setColFilters((s) => ({ ...s, impact: e.target.value }))} placeholder=">=0.20" />
              </th>
              <th style={thFilterCenter}>
                <input style={filterInput} value={colFilters.conf} onChange={(e) => setColFilters((s) => ({ ...s, conf: e.target.value }))} placeholder=">=0.70" />
              </th>
              <th style={thFilterCenter}>
                <input style={filterInput} value={colFilters.starts} onChange={(e) => setColFilters((s) => ({ ...s, starts: e.target.value }))} placeholder=">=10" />
              </th>
              <th style={thFilterCenter}>
                <input style={filterInput} value={colFilters.subs} onChange={(e) => setColFilters((s) => ({ ...s, subs: e.target.value }))} placeholder="<=5" />
              </th>
              <th style={thFilterCenter}>
                <input style={filterInput} value={colFilters.g90} onChange={(e) => setColFilters((s) => ({ ...s, g90: e.target.value }))} placeholder=">=0.3" />
              </th>
              <th style={thFilterCenter}>
                <input style={filterInput} value={colFilters.y90} onChange={(e) => setColFilters((s) => ({ ...s, y90: e.target.value }))} placeholder="<=0.2" />
              </th>
            </tr>

            <tr style={{ background: "#f4f6f8" }}>
              <th style={thLeft} onClick={() => toggleSort("_name")}>
                Speler
              </th>
              <th style={thCenter} onClick={() => toggleSort("_profile")}>
                Profiel
              </th>
              <th style={thCenter} onClick={() => toggleSort("_mins")}>
                Mins
              </th>
              <th style={thCenter} onClick={() => toggleSort("_fss")}>
                FSS
              </th>
              <th style={thCenter} onClick={() => toggleSort("_impact")}>
                Impact
              </th>
              <th style={thCenter} onClick={() => toggleSort("_conf")}>
                Conf
              </th>
              <th style={thCenter} onClick={() => toggleSort("_starts")}>
                Starts
              </th>
              <th style={thCenter} onClick={() => toggleSort("_subs")}>
                Invaller
              </th>
              <th style={thCenter} onClick={() => toggleSort("_g90")}>
                Goals/90
              </th>
              <th style={thCenter} onClick={() => toggleSort("_y90")}>
                Geel/90
              </th>
            </tr>
          </thead>

          <tbody>
            {tableRows.map((p, i) => (
              <tr key={`${p._key}-${i}`} style={{ borderTop: "1px solid #eee" }}>
                <td style={tdLeft}>
                  <HoverCard
                    trigger={
                      <button
                        onClick={() => setSelected(p)}
                        style={{ ...styles.linkBtn, textAlign: "left" }}
                        title="Klik voor details"
                      >
                        <div style={{ fontWeight: 800 }}>{p._name}</div>
                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          {p._team}
                          {p._type ? ` · ${p._type}` : ""}
                        </div>
                      </button>
                    }
                  >
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>{p._name}</div>
                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>
                      {p._team} {p._type ? `· ${p._type}` : ""} · Profiel: <ProfilePill profile={p._profile} />
                    </div>

                    <div style={styles.kvGrid}>
                      <div style={styles.k}>Mins</div>
                      <div style={styles.v}>{Math.round(p._mins)}</div>
                      <div style={styles.k}>FSS</div>
                      <div style={styles.v}>{Number.isFinite(p._fss) ? fmt(p._fss, 3) : "—"}</div>
                      <div style={styles.k}>Impact</div>
                      <div style={styles.v}>{Number.isFinite(p._impact) ? fmt(p._impact, 3) : "—"}</div>
                      <div style={styles.k}>Conf</div>
                      <div style={styles.v}>{Number.isFinite(p._conf) ? fmt(p._conf, 3) : "—"}</div>
                      <div style={styles.k}>Stability</div>
                      <div style={styles.v}>{Number.isFinite(p._stability) ? fmt(p._stability, 3) : "—"}</div>
                    </div>

                    {p.Reliability_overall !== undefined ? (
                      <div style={{ marginTop: 8, fontSize: 12 }}>
                        <b>Reliability_overall:</b> {fmt(toNum(p.Reliability_overall, NaN), 3)}
                      </div>
                    ) : null}
                    {p.Minutes_factor !== undefined ? (
                      <div style={{ marginTop: 4, fontSize: 12 }}>
                        <b>Minutes_factor:</b> {fmt(toNum(p.Minutes_factor, NaN), 3)}
                      </div>
                    ) : null}

                    {p.Explain_Impact ? <div style={styles.explain}><b>Explain_Impact:</b> {safeStr(p.Explain_Impact)}</div> : null}
                    {p.Explain_Reliability ? <div style={styles.explain}><b>Explain_Reliability:</b> {safeStr(p.Explain_Reliability)}</div> : null}
                    {p.Explain_Stability ? <div style={styles.explain}><b>Explain_Stability:</b> {safeStr(p.Explain_Stability)}</div> : null}

                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                      Klik op naam voor detail-view & (optionele) evolutie doorheen speelrondes.
                    </div>
                  </HoverCard>
                </td>

                <td style={tdCenter}><ProfilePill profile={p._profile} /></td>
                <td style={tdCenter}>{Math.round(p._mins)}</td>
                <td style={tdCenter}>{Number.isFinite(p._fss) ? fmt(p._fss, 3) : "—"}</td>
                <td style={tdCenter}>{Number.isFinite(p._impact) ? fmt(p._impact, 3) : "—"}</td>
                <td style={tdCenter}>{Number.isFinite(p._conf) ? fmt(p._conf, 3) : "—"}</td>
                <td style={tdCenter}>{p._starts}</td>
                <td style={tdCenter}>{p._subs}</td>
                <td style={tdCenter}>{Number.isFinite(p._g90) ? fmt(p._g90, 2) : "—"}</td>
                <td style={tdCenter}>{Number.isFinite(p._y90) ? fmt(p._y90, 2) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
        Rows: {tableRows.length} / {scoutedPlayers.length} (context: {contextPlayers.length}) · Loaded raw rows: {rawRows.length}
        <span style={{ marginLeft: 10, opacity: 0.6 }}>{historyNote}</span>
      </div>

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `${selected._name} · ${selected._team}${selected._type ? ` · ${selected._type}` : ""}` : ""}
      >
        {selected ? (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={styles.modalGrid}>
              <Stat label="Profiel" value={<ProfilePill profile={selected._profile} />} />
              <Stat label="Mins" value={Math.round(selected._mins)} />
              <Stat label="FSS" value={Number.isFinite(selected._fss) ? fmt(selected._fss, 3) : "—"} />
              <Stat label="Impact" value={Number.isFinite(selected._impact) ? fmt(selected._impact, 3) : "—"} />
              <Stat label="Conf" value={Number.isFinite(selected._conf) ? fmt(selected._conf, 3) : "—"} />
              <Stat label="Stability" value={Number.isFinite(selected._stability) ? fmt(selected._stability, 3) : "—"} />
              <Stat label="Starts" value={selected._starts} />
              <Stat label="Invaller" value={selected._subs} />
              <Stat label="Goals/90" value={Number.isFinite(selected._g90) ? fmt(selected._g90, 2) : "—"} />
              <Stat label="Geel/90" value={Number.isFinite(selected._y90) ? fmt(selected._y90, 2) : "—"} />
            </div>

            {(selected.Explain_Impact || selected.Explain_Reliability || selected.Explain_Stability) ? (
              <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>Explain (uit export)</div>
                {selected.Explain_Impact ? <div style={styles.explain}><b>Explain_Impact:</b> {safeStr(selected.Explain_Impact)}</div> : null}
                {selected.Explain_Reliability ? <div style={styles.explain}><b>Explain_Reliability:</b> {safeStr(selected.Explain_Reliability)}</div> : null}
                {selected.Explain_Stability ? <div style={styles.explain}><b>Explain_Stability:</b> {safeStr(selected.Explain_Stability)}</div> : null}
              </div>
            ) : null}

            <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 800 }}>Evolutie doorheen seizoen</div>
                <div style={{ flex: 1 }} />
                <label style={{ fontSize: 12, opacity: 0.85 }}>Metric</label>
                <select value={metric} onChange={(e) => setMetric(e.target.value)} style={{ ...styles.select, minWidth: 160 }}>
                  <option value="FinalScoutingScore">FSS</option>
                  <option value="ImpactScore">ImpactScore</option>
                  <option value="Confidence">Confidence</option>
                  <option value="Speelminuten">Speelminuten</option>
                </select>
              </div>

              {selectedHistory.length ? (
                <div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
                    Rounds: {selectedHistory.length} · Key: <code>{selected._key}</code>
                  </div>
                  <Sparkline values={chartValues} />
                  <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                    x-as = speelronde, y-as = gekozen metric. (Tip: als je “round” in je export meegeeft is dit automatisch.)
                  </div>

                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.85 }}>Toon tabel met waarden</summary>
                    <div style={{ overflowX: "auto", marginTop: 8 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: "#fafafa" }}>
                            <th style={miniTh}>Round</th>
                            <th style={miniTh}>Mins</th>
                            <th style={miniTh}>FSS</th>
                            <th style={miniTh}>Impact</th>
                            <th style={miniTh}>Conf</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedHistory.map((h, idx) => (
                            <tr key={idx} style={{ borderTop: "1px solid #eee" }}>
                              <td style={miniTd}>{h._round}</td>
                              <td style={miniTd}>{Math.round(h._mins)}</td>
                              <td style={miniTd}>{Number.isFinite(h._fss) ? fmt(h._fss, 3) : "—"}</td>
                              <td style={miniTd}>{Number.isFinite(h._impact) ? fmt(h._impact, 3) : "—"}</td>
                              <td style={miniTd}>{Number.isFinite(h._conf) ? fmt(h._conf, 3) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </div>
              ) : (
                <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.4 }}>
                  Geen history gevonden voor deze speler.
                  <div style={{ marginTop: 8 }}>
                    Om evolutie te zien heb je één van deze nodig:
                    <ul style={{ marginTop: 6 }}>
                      <li>
                        <b>Embedded</b>: voeg <code>History</code> toe per speler in <code>player_stats.json</code> (array met per ronde: Round, FinalScoutingScore, ImpactScore, Confidence, Speelminuten)
                      </li>
                      <li>
                        <b>Los bestand</b>: maak <code>public/data/player_history.json</code> met key <code>{"<Team>__<Speler>"}</code> → array met dezelfde velden.
                      </li>
                    </ul>
                    Key voor deze speler: <code>{selected._key}</code>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 800 }}>{value}</div>
    </div>
  );
}

const styles = {
  topRow: {
    display: "flex",
    gap: 12,
    alignItems: "stretch",
    flexWrap: "wrap",
    marginBottom: 12,
  },
  controlsRow: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "flex-end",
  },
  profileRow: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    alignItems: "stretch",
    justifyContent: "flex-start",
  },
  profileBox: {
    border: "1px solid #eee",
    borderRadius: 10,
    padding: 10,
    background: "#fafafa",
    minWidth: 220,
    maxWidth: 260,
  },
  control: { display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 12, opacity: 0.8 },
  input: { padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", minWidth: 220 },
  select: { padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", minWidth: 180 },
  hoverCard: {
    position: "absolute",
    left: 0,
    top: "100%",
    marginTop: 8,
    zIndex: 50,
    width: 360,
    background: "white",
    border: "1px solid #eee",
    borderRadius: 10,
    padding: 10,
    boxShadow: "0 10px 30px rgba(0,0,0,0.10)",
    color: "#111",
  },
  kvGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "6px 10px",
    fontSize: 12,
    padding: 8,
    borderRadius: 10,
    background: "#fafafa",
    border: "1px solid #eee",
  },
  k: { opacity: 0.75 },
  v: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 },
  explain: { marginTop: 6, fontSize: 12, opacity: 0.9, lineHeight: 1.3 },
  linkBtn: {
    background: "transparent",
    border: "none",
    padding: 0,
    margin: 0,
    cursor: "pointer",
    color: "inherit",
  },
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    zIndex: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
  },
  modalCard: {
    width: "min(980px, 100%)",
    maxHeight: "85vh",
    overflow: "auto",
    background: "white",
    borderRadius: 14,
    border: "1px solid #eee",
    padding: 14,
    boxShadow: "0 18px 60px rgba(0,0,0,0.25)",
  },
  btn: {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #ddd",
    background: "#fafafa",
    cursor: "pointer",
  },
  modalGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(120px, 1fr))",
    gap: 10,
  },
};

const thBase = { padding: "10px 10px", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" };
const thLeft = { ...thBase, textAlign: "left" };
const thCenter = { ...thBase, textAlign: "center" };

const thFilterLeft = { textAlign: "left", padding: "6px 10px", whiteSpace: "nowrap" };
const thFilterCenter = { textAlign: "center", padding: "6px 10px", whiteSpace: "nowrap" };

const tdLeft = { padding: "10px 10px", verticalAlign: "top", textAlign: "left", whiteSpace: "nowrap" };
const tdCenter = { padding: "10px 10px", textAlign: "center", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

const filterInput = { width: "100%", padding: "6px 8px", borderRadius: 8, border: "1px solid #ddd", fontSize: 12, textAlign: "center" };

const miniTh = { textAlign: "center", padding: 8, whiteSpace: "nowrap" };
const miniTd = { textAlign: "center", padding: 8, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
