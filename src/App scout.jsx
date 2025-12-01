import React, { useEffect, useMemo, useState } from "react";
import "./App.css";

/** Helpers */
const toNumber = (v) => {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const formatNumber = (v, decimals = 2) => {
  if (v === null || v === undefined) return "—";
  const n = toNumber(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
};

function App() {
  const [rawData, setRawData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // globale filters (voor alle tabellen)
  const [selectedTeams, setSelectedTeams] = useState(new Set());

  // sandbox-filters
  const [minMinutes, setMinMinutes] = useState(0);
  const [maxMinutes, setMaxMinutes] = useState(null);
  const [minStarts, setMinStarts] = useState(0);
  const [maxStarts, setMaxStarts] = useState(null);
  const [minSubsIn, setMinSubsIn] = useState(0);
  const [maxSubsIn, setMaxSubsIn] = useState(null);

  const [includePlayers, setIncludePlayers] = useState(true);
  const [includeKeepers, setIncludeKeepers] = useState(false);

  // sortering voor sandbox-tabel
  const [sortKey, setSortKey] = useState("RAPM");
  const [sortDir, setSortDir] = useState("desc");

  // ---------------------- Data laden ----------------------

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch("data/player_stats.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!alive) return;
        setRawData(json);
      } catch (e) {
        if (!alive) return;
        console.error(e);
        setError("Kon spelerstatistieken niet laden (data/player_stats.json).");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  // ---------------------- Flatten JSON -> spelerslijst ----------------------

  const allPlayers = useMemo(() => {
    if (!rawData) return [];

    const rows = [];

    // verwacht structuur: { "Teamnaam": [ {Speler, Speelminuten, ...}, ... ], ... }
    Object.entries(rawData).forEach(([teamKey, arr]) => {
      (arr || []).forEach((p) => {
        const minutes = toNumber(p.Speelminuten ?? p["Speelminuten"]);
        const started = toNumber(p.Gestart ?? p["Gestart"]);
        const subIn = toNumber(p.Ingevallen ?? p["Ingevallen"]);
        const subOut = toNumber(p.Vervangen ?? p["Vervangen"]);
        const goals90 = toNumber(p["Goals/90min"]);
        const rapm = toNumber(p.RAPM_per90 ?? p["RAPM_per90"] ?? p["MVP p>20/90min"]);
        const type = p.Type ?? p["Type"] ?? "";

        rows.push({
          Team: p.Team ?? teamKey,
          Speler: p.Speler ?? p["Speler"],
          Type: type,
          minutes,
          started,
          subIn,
          subOut,
          goals90,
          rapm,
          selecties: toNumber(p.Selecties ?? p["Selecties"]),
        });
      });
    });

    return rows.filter((r) => r.Speler && r.Team);
  }, [rawData]);

  // ---------------------- Teams voor checkbox-lijst ----------------------

  const allTeams = useMemo(() => {
    const set = new Set(allPlayers.map((p) => p.Team));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allPlayers]);

  // Initieel: alle teams geselecteerd
  useEffect(() => {
    if (allTeams.length && selectedTeams.size === 0) {
      setSelectedTeams(new Set(allTeams));
    }
  }, [allTeams, selectedTeams.size]);

  const toggleTeam = (team) => {
    setSelectedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(team)) next.delete(team);
      else next.add(team);
      return next;
    });
  };

  const selectAllTeams = () => {
    setSelectedTeams(new Set(allTeams));
  };

  const clearTeams = () => {
    setSelectedTeams(new Set());
  };

  // ---------------------- Rol-drempels dynamisch uit minuut-data ----------------------

  const roleThresholds = useMemo(() => {
    const minutesArr = allPlayers.map((p) => p.minutes).filter((v) => v > 0);
    if (!minutesArr.length) return null;

    const maxMinutes = Math.max(...minutesArr);
    const fixedMin = Math.max(600, 0.6 * maxMinutes); // vaste waarde
    const subMin = Math.max(180, 0.2 * maxMinutes);   // supersub min
    const subMax = fixedMin - 1;
    const talentMin = 90;                             // minstens ~1 match
    const talentMax = subMin - 1;

    return { maxMinutes, fixedMin, subMin, subMax, talentMin, talentMax };
  }, [allPlayers]);

  // ---------------------- Basisfilter (teams + type) ----------------------

  const basePlayers = useMemo(() => {
    return allPlayers.filter((p) => {
      if (selectedTeams.size > 0 && !selectedTeams.has(p.Team)) return false;
      if (!includePlayers && p.Type !== "Keeper") return false;
      if (!includeKeepers && p.Type === "Keeper") return false;
      return true;
    });
  }, [allPlayers, selectedTeams, includePlayers, includeKeepers]);

  // ---------------------- 3 lijsten: vaste waarden / supersubs / talenten ----------------------

  const { fixedCore, superSubs, talents } = useMemo(() => {
    const empty = { fixedCore: [], superSubs: [], talents: [] };
    if (!roleThresholds) return empty;

    const { fixedMin, subMin, subMax, talentMin, talentMax } = roleThresholds;

    const isOutfield = (p) => p.Type !== "Keeper";

    // 1) vaste waarden: veel minuten, sorteer op RAPM
    const fixedCore = basePlayers
      .filter((p) => isOutfield(p) && p.minutes >= fixedMin)
      .sort((a, b) => b.rapm - a.rapm)
      .slice(0, 10);

    // 2) supersubs: middelhoge minuten, weinig gestart, vaak ingevallen
    const superSubs = basePlayers
      .filter((p) => {
        if (!isOutfield(p)) return false;
        if (p.minutes < subMin || p.minutes > subMax) return false;
        const sel = p.selecties || p.started + p.subIn; // fallback
        if (sel <= 0) return false;
        const maxStarts = 0.5 * sel;
        return p.started <= maxStarts && p.subIn >= 3;
      })
      .sort((a, b) => b.rapm - a.rapm)
      .slice(0, 10);

    // 3) talenten: weinig minuten, hoge RAPM
    const talents = basePlayers
      .filter(
        (p) =>
          isOutfield(p) &&
          p.minutes >= talentMin &&
          p.minutes <= talentMax
      )
      .sort((a, b) => b.rapm - a.rapm)
      .slice(0, 10);

    return { fixedCore, superSubs, talents };
  }, [basePlayers, roleThresholds]);

  // ---------------------- Sandbox-tabel: filters + sort ----------------------

  const filteredSandboxPlayers = useMemo(() => {
    let data = [...basePlayers];

    data = data.filter((p) => {
      if (p.minutes < minMinutes) return false;
      if (maxMinutes !== null && p.minutes > maxMinutes) return false;
      if (p.started < minStarts) return false;
      if (maxStarts !== null && p.started > maxStarts) return false;
      if (p.subIn < minSubsIn) return false;
      if (maxSubsIn !== null && p.subIn > maxSubsIn) return false;
      return true;
    });

    const key = sortKey;

    data.sort((a, b) => {
      let va;
      let vb;

      switch (key) {
        case "Speler":
          va = a.Speler;
          vb = b.Speler;
          break;
        case "Team":
          va = a.Team;
          vb = b.Team;
          break;
        case "Minutes":
          va = a.minutes;
          vb = b.minutes;
          break;
        case "Starts":
          va = a.started;
          vb = b.started;
          break;
        case "SubsIn":
          va = a.subIn;
          vb = b.subIn;
          break;
        case "Goals90":
          va = a.goals90;
          vb = b.goals90;
          break;
        case "RAPM":
        default:
          va = a.rapm;
          vb = b.rapm;
          break;
      }

      if (typeof va === "string" || typeof vb === "string") {
        const sa = String(va ?? "");
        const sb = String(vb ?? "");
        return sortDir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
      }

      const na = toNumber(va);
      const nb = toNumber(vb);
      return sortDir === "asc" ? na - nb : nb - na;
    });

    return data.slice(0, 20); // safety
  }, [
    basePlayers,
    minMinutes,
    maxMinutes,
    minStarts,
    maxStarts,
    minSubsIn,
    maxSubsIn,
    sortKey,
    sortDir,
  ]);

  const handleSort = (key) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((prevDir) => (prevDir === "asc" ? "desc" : "asc"));
        return prevKey;
      } else {
        setSortDir("desc");
        return key;
      }
    });
  };

  // ---------------------- Render helpers ----------------------

  const renderPlayerTable = (rows, title, subtitle = "") => {
    return (
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: "12px",
          marginBottom: "1.5rem",
          background: "#fff",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "0.75rem 1rem",
            borderBottom: "1px solid #eee",
          }}
        >
          <div style={{ fontWeight: 600 }}>{title}</div>
          {subtitle && (
            <div style={{ fontSize: "0.8rem", color: "#666", marginTop: "0.15rem" }}>
              {subtitle}
            </div>
          )}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.85rem",
            }}
          >
            <thead style={{ background: "#f7f7f7" }}>
              <tr>
                <th style={{ padding: "0.35rem 0.6rem", textAlign: "left" }}>Speler</th>
                <th style={{ padding: "0.35rem 0.6rem", textAlign: "left" }}>Team</th>
                <th style={{ padding: "0.35rem 0.6rem", textAlign: "right" }}>Min.</th>
                <th style={{ padding: "0.35rem 0.6rem", textAlign: "right" }}>Basis</th>
                <th style={{ padding: "0.35rem 0.6rem", textAlign: "right" }}>Inv.</th>
                <th style={{ padding: "0.35rem 0.6rem", textAlign: "right" }}>Goals/90</th>
                <th style={{ padding: "0.35rem 0.6rem", textAlign: "right" }}>
                  RAPM / 90
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, idx) => (
                <tr
                  key={`${title}_${p.Team}_${p.Speler}_${idx}`}
                  style={{
                    background: idx % 2 === 0 ? "#fff" : "#fafafa",
                    borderBottom: "1px solid #f0f0f0",
                  }}
                >
                  <td style={{ padding: "0.35rem 0.6rem", fontWeight: 500 }}>
                    {p.Speler}
                  </td>
                  <td style={{ padding: "0.35rem 0.6rem" }}>{p.Team}</td>
                  <td style={{ padding: "0.35rem 0.6rem", textAlign: "right" }}>
                    {Math.round(p.minutes)}
                  </td>
                  <td style={{ padding: "0.35rem 0.6rem", textAlign: "right" }}>
                    {p.started}
                  </td>
                  <td style={{ padding: "0.35rem 0.6rem", textAlign: "right" }}>
                    {p.subIn}
                  </td>
                  <td style={{ padding: "0.35rem 0.6rem", textAlign: "right" }}>
                    {formatNumber(p.goals90, 2)}
                  </td>
                  <td style={{ padding: "0.35rem 0.6rem", textAlign: "right" }}>
                    {formatNumber(p.rapm, 2)}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      padding: "0.5rem",
                      textAlign: "center",
                      color: "#777",
                    }}
                  >
                    Geen spelers gevonden voor deze categorie.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // ---------------------- Render main ----------------------

  return (
    <div
      className="app-root"
      style={{ padding: "1.5rem", fontFamily: "system-ui, sans-serif" }}
    >
      <h1 style={{ fontSize: "1.6rem", marginBottom: "0.3rem" }}>
        Competitiebrede spelersscouting — RAPM dashboard
      </h1>
      <p style={{ fontSize: "0.9rem", color: "#555", marginBottom: "1rem" }}>
        Drie automatische shortlists (vaste waarden, supersubs, talenten) op basis van
        RAPM (impact op doelsaldo / 90min), plus een volledige tabel met filters om zelf
        te spelen met de data.
      </p>

      {loading && <p>Data laden…</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {/* Team- en type-filters (globaal) */}
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: "12px",
          padding: "1rem",
          marginBottom: "1.5rem",
          background: "#fff",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: "1.5rem" }}>
          <div style={{ minWidth: "220px" }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.3rem" }}>
              Teams (aan/uit)
            </div>
            <div style={{ marginBottom: "0.3rem", fontSize: "0.8rem" }}>
              <button type="button" onClick={selectAllTeams} style={{ marginRight: "0.4rem" }}>
                alles
              </button>
              <button type="button" onClick={clearTeams}>
                geen
              </button>
            </div>
            <div
              style={{
                maxHeight: "120px",
                overflowY: "auto",
                border: "1px solid #eee",
                borderRadius: "6px",
                padding: "0.3rem",
                fontSize: "0.8rem",
              }}
            >
              {allTeams.map((team) => (
                <label
                  key={team}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    marginBottom: "0.1rem",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedTeams.has(team)}
                    onChange={() => toggleTeam(team)}
                  />
                  <span>{team}</span>
                </label>
              ))}
              {!allTeams.length && (
                <span style={{ color: "#888" }}>Geen teams geladen</span>
              )}
            </div>
          </div>

          <div>
            <div style={{ fontSize: "0.8rem", fontWeight: 600 }}>Spelertype</div>
            <label style={{ display: "block", fontSize: "0.85rem" }}>
              <input
                type="checkbox"
                checked={includePlayers}
                onChange={(e) => setIncludePlayers(e.target.checked)}
              />{" "}
              Spelers (veldspelers)
            </label>
            <label style={{ display: "block", fontSize: "0.85rem" }}>
              <input
                type="checkbox"
                checked={includeKeepers}
                onChange={(e) => setIncludeKeepers(e.target.checked)}
              />{" "}
              Keepers
            </label>
          </div>

          {roleThresholds && (
            <div style={{ fontSize: "0.8rem", color: "#555", maxWidth: "260px" }}>
              <div style={{ fontWeight: 600, marginBottom: "0.2rem" }}>
                Dynamische profielen (op basis van minuten)
              </div>
              <ul style={{ paddingLeft: "1.1rem", margin: 0 }}>
                <li>
                  <strong>Vaste waarde</strong> ≈ min.{" "}
                  {Math.round(roleThresholds.fixedMin)} min.
                </li>
                <li>
                  <strong>Supersub</strong> ≈ {Math.round(roleThresholds.subMin)}–{" "}
                  {Math.round(roleThresholds.subMax)} min, weinig basis, veel invallen.
                </li>
                <li>
                  <strong>Talent</strong> ≈ {Math.round(roleThresholds.talentMin)}–{" "}
                  {Math.round(roleThresholds.talentMax)} min.
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Drie shortlists */}
      {renderPlayerTable(
        fixedCore,
        "Top vaste waarden (competitiebreed)",
        "Spelers met veel speelminuten en hoge RAPM — echte dragende krachten bij hun club."
      )}

      {renderPlayerTable(
        superSubs,
        "Supersubs met impact",
        "Spelers met middelhoge minuten, weinig basis maar veel invalbeurten en hoge RAPM."
      )}

      {renderPlayerTable(
        talents,
        "Talenten met beperkte minuten",
        "Jonge of weinig gebruikte spelers met beperkte minuten maar opvallend hoge RAPM."
      )}

      {/* Sandbox-tabel */}
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: "12px",
          background: "#fff",
          marginBottom: "1.5rem",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "0.75rem 1rem",
            borderBottom: "1px solid #eee",
          }}
        >
          <div style={{ fontWeight: 600 }}>Alle spelers — eigen filters</div>
          <div style={{ fontSize: "0.8rem", color: "#666", marginTop: "0.2rem" }}>
            Filter op minuten, basisplaatsen en invalbeurten. Sorteer via kolomtitels om
            bijvoorbeeld de beste RAPM-spelers binnen een bepaalde rol te vinden.
          </div>
        </div>

        {/* Filterbalk sandbox */}
        <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid #eee" }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "1.5rem",
              alignItems: "flex-end",
              fontSize: "0.8rem",
            }}
          >
            <div>
              <div style={{ fontWeight: 600, marginBottom: "0.2rem" }}>
                Speelminuten (range)
              </div>
              <div style={{ display: "flex", gap: "0.4rem" }}>
                <label>
                  Min{" "}
                  <input
                    type="number"
                    value={minMinutes}
                    min={0}
                    onChange={(e) =>
                      setMinMinutes(Number(e.target.value) || 0)
                    }
                    style={{ width: "80px" }}
                  />
                </label>
                <label>
                  Max{" "}
                  <input
                    type="number"
                    value={maxMinutes ?? ""}
                    min={0}
                    placeholder="geen"
                    onChange={(e) => {
                      const v = e.target.value;
                      setMaxMinutes(v === "" ? null : Number(v) || 0);
                    }}
                    style={{ width: "80px" }}
                  />
                </label>
              </div>
            </div>

            <div>
              <div style={{ fontWeight: 600, marginBottom: "0.2rem" }}>
                Basisselecties
              </div>
              <div style={{ display: "flex", gap: "0.4rem" }}>
                <label>
                  Min{" "}
                  <input
                    type="number"
                    value={minStarts}
                    min={0}
                    onChange={(e) =>
                      setMinStarts(Number(e.target.value) || 0)
                    }
                    style={{ width: "80px" }}
                  />
                </label>
                <label>
                  Max{" "}
                  <input
                    type="number"
                    value={maxStarts ?? ""}
                    min={0}
                    placeholder="geen"
                    onChange={(e) => {
                      const v = e.target.value;
                      setMaxStarts(v === "" ? null : Number(v) || 0);
                    }}
                    style={{ width: "80px" }}
                  />
                </label>
              </div>
            </div>

            <div>
              <div style={{ fontWeight: 600, marginBottom: "0.2rem" }}>
                Ingevallen (selecties)
              </div>
              <div style={{ display: "flex", gap: "0.4rem" }}>
                <label>
                  Min{" "}
                  <input
                    type="number"
                    value={minSubsIn}
                    min={0}
                    onChange={(e) =>
                      setMinSubsIn(Number(e.target.value) || 0)
                    }
                    style={{ width: "80px" }}
                  />
                </label>
                <label>
                  Max{" "}
                  <input
                    type="number"
                    value={maxSubsIn ?? ""}
                    min={0}
                    placeholder="geen"
                    onChange={(e) => {
                      const v = e.target.value;
                      setMaxSubsIn(v === "" ? null : Number(v) || 0);
                    }}
                    style={{ width: "80px" }}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Tabel sandbox */}
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.85rem",
            }}
          >
            <thead style={{ background: "#f7f7f7" }}>
              <tr>
                {[
                  { key: "Speler", label: "Speler" },
                  { key: "Team", label: "Team" },
                  { key: "Minutes", label: "Min." },
                  { key: "Starts", label: "Basis" },
                  { key: "SubsIn", label: "Inv." },
                  { key: "Goals90", label: "Goals/90" },
                  { key: "RAPM", label: "RAPM / 90" },
                ].map((col) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    style={{
                      padding: "0.4rem 0.6rem",
                      textAlign:
                        col.key === "Speler" || col.key === "Team"
                          ? "left"
                          : "right",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      borderBottom: "1px solid #e0e0e0",
                    }}
                  >
                    {col.label}{" "}
                    {sortKey === col.key
                      ? sortDir === "asc"
                        ? "▲"
                        : "▼"
                      : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredSandboxPlayers.map((p, idx) => (
                <tr
                  key={`sandbox_${p.Team}_${p.Speler}_${idx}`}
                  style={{
                    background: idx % 2 === 0 ? "#fff" : "#fafafa",
                    borderBottom: "1px solid #f0f0f0",
                  }}
                >
                  <td
                    style={{
                      padding: "0.35rem 0.6rem",
                      textAlign: "left",
                      fontWeight: 500,
                    }}
                  >
                    {p.Speler}
                  </td>
                  <td
                    style={{
                      padding: "0.35rem 0.6rem",
                      textAlign: "left",
                    }}
                  >
                    {p.Team}
                  </td>
                  <td
                    style={{
                      padding: "0.35rem 0.6rem",
                      textAlign: "right",
                    }}
                  >
                    {Math.round(p.minutes)}
                  </td>
                  <td
                    style={{
                      padding: "0.35rem 0.6rem",
                      textAlign: "right",
                    }}
                  >
                    {p.started}
                  </td>
                  <td
                    style={{
                      padding: "0.35rem 0.6rem",
                      textAlign: "right",
                    }}
                  >
                    {p.subIn}
                  </td>
                  <td
                    style={{
                      padding: "0.35rem 0.6rem",
                      textAlign: "right",
                    }}
                  >
                    {formatNumber(p.goals90, 2)}
                  </td>
                  <td
                    style={{
                      padding: "0.35rem 0.6rem",
                      textAlign: "right",
                    }}
                  >
                    {formatNumber(p.rapm, 2)}
                  </td>
                </tr>
              ))}
              {!filteredSandboxPlayers.length && (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      padding: "0.5rem",
                      textAlign: "center",
                      color: "#777",
                    }}
                  >
                    Geen spelers gevonden met deze filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* kleine uitleg */}
      <div
        style={{
          fontSize: "0.8rem",
          color: "#555",
          maxWidth: "900px",
          lineHeight: 1.4,
        }}
      >
        <strong>Wat betekent RAPM?</strong> RAPM (Regularized Adjusted Plus-Minus) schat
        hoeveel het doelsaldo van de ploeg verandert per 90 minuten wanneer een speler
        op het veld staat, gecorrigeerd voor ploegmaats en tegenstanders. Waarden &gt; 0
        = positieve impact, &lt; 0 = eerder negatieve impact. Gebruik de drie vaste
        lijsten als startpunt, en verfijn dan met de filters in de onderste tabel.
      </div>
    </div>
  );
}

export default App;
