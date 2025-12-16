// src/App.jsx
import React, { useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  ScatterChart,
  Scatter,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  LineChart,
  Line,
  Legend,
} from "recharts";


function quantile(arr, q) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}


// Kleine helper om veilig naar number te casten
const toNum = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(",", ".").trim();
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

// Format helper
const fmt = (v, digits = 2) => {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return Number(v).toFixed(digits);
};

// ----------------------------
// SCOUTING CLASSIFICATIE (DYNAMISCH)
// ----------------------------
const classifyProfile = (p, cut) => {
  const mins = p.mins ?? 0;
  const imp = p.impactScore ?? 0;
  const conf = p.confidence ?? 0;
  const fss = p.finalScore ?? 0;

  if (imp <= cut.impact_p25 && conf >= cut.conf_p75 && mins >= cut.mins_p60) return "Low-impact but reliable"; // optioneel

  // 1) Elite: top FSS + voldoende sample
  if (fss >= cut.fss_p85 && conf >= cut.conf_p75 && mins >= cut.mins_p60) return "Elite";

  // 2) High-upside: hoge impact+confidence maar weinig minuten
  if (imp >= cut.impact_p75 && conf >= cut.conf_p75 && mins < cut.mins_p60) return "High-upside";

  // 3) Reliable regular: zeer betrouwbaar, veel minuten, maar niet top-impact
  if (conf >= cut.conf_p90 && mins >= cut.mins_p75 && imp < cut.impact_p75) return "Reliable regular";

  // 4) High risk/high reward: top impact maar lage confidence
  if (imp >= cut.impact_p90 && conf < cut.conf_p75) return "High risk / high reward";

  return "Other";
};

const classifyListABC = (p, cut) => {
  const mins = p.mins ?? 0;
  const imp = p.impactScore ?? 0;
  const conf = p.confidence ?? 0;
  const fss = p.finalScore ?? 0;

  // NEG: duidelijk negatief met genoeg sample
  if (imp <= cut.impact_p10 && conf >= cut.conf_p60 && mins >= cut.mins_p60) return "NEG";

  // A: elite (prioriteit)
  if (fss >= cut.fss_p85 && conf >= cut.conf_p75 && mins >= cut.mins_p60) return "A";

  // B: shortlist (upside of reliable regular)
  if (
    (imp >= cut.impact_p75 && conf >= cut.conf_p75) ||
    (conf >= cut.conf_p90 && mins >= cut.mins_p75)
  ) return "B";

  // C: monitoren (sterke impact maar onzeker)
  if (imp >= cut.impact_p75 && conf < cut.conf_p75) return "C";

  return "OTH";
};

const listBadge = (t) => {
  if (t === "A") return { label: "A-lijst", cls: "bg-emerald-600 text-white" };
  if (t === "B") return { label: "B-lijst", cls: "bg-lime-500 text-white" };
  if (t === "C") return { label: "C-lijst", cls: "bg-amber-400 text-black" };
  if (t === "NEG") return { label: "NEG", cls: "bg-rose-600 text-white" };
  return { label: "—", cls: "bg-gray-200 text-gray-700" };
};

const profileBadge = (p) => {
  if (p === "Elite") return { label: "Elite", cls: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" };
  if (p === "High-upside") return { label: "High-upside", cls: "bg-sky-50 text-sky-700 ring-1 ring-sky-200" };
  if (p === "Reliable regular") return { label: "Reliable", cls: "bg-amber-50 text-amber-800 ring-1 ring-amber-200" };
  if (p === "High risk / high reward") return { label: "High-risk", cls: "bg-rose-50 text-rose-700 ring-1 ring-rose-200" };
  return { label: "Other", cls: "bg-gray-50 text-gray-700 ring-1 ring-gray-200" };
};


// Classificeer spelers in A/B/C/NEG/OTHER op basis van impact, betrouwbaarheid en minuten
const classifyTier = (impactScore, reliability, mins) => {
  const imp = Number(impactScore ?? 0);
  const rel = Number(reliability ?? 0);
  const m   = Number(mins ?? 0);

  // Negatieve outliers (no-go)
  if (imp <= -0.15 && rel >= 0.5 && m >= 500) return "NEG";

  // A-lijst: bewezen topimpact
  if (imp >= 0.20 && rel >= 0.5 && m >= 700) return "A";

  // B-lijst: high upside, degelijke maar minder grote sample
  if (imp >= 0.15 && rel >= 0.35 && m >= 400) return "B";

  // C-lijst: interessante prospects
  if (imp >= 0.10 && rel >= 0.25 && m >= 200) return "C";

  return "OTHER";
};

// Labels voor UI
const TIER_LABELS = {
  ALL:   "Alle spelers",
  A:     "A-lijst (directe versterking)",
  B:     "B-lijst (high-upside targets)",
  C:     "C-lijst (prospects)",
  NEG:   "Negatief (mijden)",
  OTHER: "Overige",
};



// -------- Tooltip voor scatter --------
const ScatterTooltip = ({ active, payload }) => {
  if (!active || !payload || !payload.length) return null;

  const d = payload[0].payload;
  if (!d) return null;

  const relPct =
    d.reliability != null && !Number.isNaN(d.reliability)
      ? Math.round(d.reliability * 100)
      : null;

  return (
    <div className="bg-white text-xs shadow-md border border-gray-200 rounded-lg px-3 py-2">
      <div className="font-semibold mb-1">
        {d.name} <span className="text-gray-500">({d.team})</span>
      </div>
      <div>
        Type: <strong>{d.type || "?"}</strong>
      </div>
      <div>
        Minuten: <strong>{fmt(d.mins, 0)}</strong>
      </div>
      <div>
        ImpactScore: <strong>{fmt(d.impactScore)}</strong>
      </div>
      <div>
        Confidence: <strong>{fmt(d.confidence, 2)}</strong>
      </div>
      <div>
        Scout score: <strong>{fmt(d.finalScore, 2)}</strong>
      </div>

      <div>
        RAPM / 90: <strong>{fmt(d.rapm)}</strong>{" "}
        <span className="text-gray-500">(S/N {fmt(d.rapmSnr)})</span>
      </div>
      <div>
        xPPM / 90: <strong>{fmt(d.xppm)}</strong>{" "}
        <span className="text-gray-500">(S/N {fmt(d.xppmSnr)})</span>
      </div>
      <div>
        Betrouwbaarheid:{" "}
        <strong>{relPct != null ? `${relPct}%` : "—"}</strong>
      </div>
      <div>
        Stabiliteitsscore: <strong>{fmt(d.stability)}</strong>
      </div>
      {(d.explainImpact || d.explainReliability || d.explainStability) && (
        <div className="mt-2 text-[10px] text-gray-600 space-y-0.5">
          {d.explainImpact && <div>• {d.explainImpact}</div>}
          {d.explainReliability && <div>• {d.explainReliability}</div>}
          {d.explainStability && <div>• {d.explainStability}</div>}
        </div>
      )}
      <div className="mt-1 text-[10px] text-gray-500">
        Betrouwbaarheid combineert minuten + signaal/ruis (S/N). 
        Stabiliteit is op dezelfde schaal (0–1): hoger = robuuster profiel.
      </div>
    </div>
  );
};


function extractR2ByRound(playerStats) {
  if (!playerStats) return { overallR2: null, series: [] };

  const teamArrays = Object.values(playerStats);
  if (!teamArrays.length) return { overallR2: null, series: [] };

  let rowWithR2 = null;

  for (const teamRows of teamArrays) {
    if (!Array.isArray(teamRows)) continue;
    for (const r of teamRows) {
      if (r && (r.RAPM_R2_overall !== undefined || r.RAPM_R2_by_round)) {
        rowWithR2 = r;
        break;
      }
    }
    if (rowWithR2) break;
  }

  if (!rowWithR2) return { overallR2: null, series: [] };

  const overallR2 =
    typeof rowWithR2.RAPM_R2_overall === "number"
      ? rowWithR2.RAPM_R2_overall
      : Number(rowWithR2.RAPM_R2_overall ?? 0);

  let series = [];
  if (rowWithR2.RAPM_R2_by_round) {
    try {
      const raw = rowWithR2.RAPM_R2_by_round;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      series = (parsed || []).map((d) => ({
        round: d.round,
        R2: d.R2,
      }));
    } catch (e) {
      console.error("Kon RAPM_R2_by_round niet parsen:", e);
    }
  }

  return { overallR2, series };
}


// -------- Overzicht globale betrouwbaarheid / stabiliteit --------
function ReliabilitySummary({ players }) {
  if (!players || !players.length) return null;

  // Gebruik confidence (0–1) als globale “betrouwbaarheid” voor scouting
  const vals = players
    .map((p) => p.confidence ?? 0)
    .filter((v) => Number.isFinite(v));

  if (!vals.length) return null;

  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];

  // Dynamische cutoff: top 25% = "betrouwbaar", top 10% = "zeer betrouwbaar"
  const highCutoff = sorted[Math.floor(sorted.length * 0.75)];
  const veryHighCutoff = sorted[Math.floor(sorted.length * 0.90)];

  const nHigh = vals.filter((v) => v >= highCutoff).length;
  const nVeryHigh = vals.filter((v) => v >= veryHighCutoff).length;


  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-4">
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Modelstabiliteit (league breed)
        </h3>
        <p className="mt-2 text-2xl font-semibold">
          {(median * 100).toFixed(0)}%
        </p>
        <p className="mt-1 text-xs text-gray-500">
          Mediaan confidence (minuten × betrouwbaarheid × stabiliteit) over alle spelers met minuten.
        </p>
      </div>

      <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-4">
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Bovenste kwartiel
        </h3>
        <p className="mt-2 text-2xl font-semibold">
          {(p75 * 100).toFixed(0)}%
        </p>
        <p className="mt-1 text-xs text-gray-500">
          75% van de spelers zit onder deze stabiliteit. Alles daarboven zijn
          doorgaans zeer betrouwbare schattingen.
        </p>
      </div>

      <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-4">
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Aantal betrouwbare spelers
        </h3>
        <p className="mt-2 text-2xl font-semibold">
          {nHigh}
          <span className="text-sm text-gray-400 ml-1">({nVeryHigh} 85%+)</span>
        </p>
        <p className="mt-1 text-xs text-gray-500">
          Spelers met confidence in het hoogste kwartiel (cutoff {highCutoff.toFixed(2)}) (en tussen haakjes hoogste 10%: {veryHighCutoff.toFixed(2)}).
          <br />
          Dit is ruwweg de populatie waar je met redelijk vertrouwen kan
          scouten.
        </p>
      </div>
    </div>
  );
}

// -------- Evolutie van betrouwbaarheid vs. speelminuten --------
function ReliabilityEvolutionChart({ buckets }) {
  if (!buckets || !buckets.length) return null;

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            Evolutie stabiliteit vs. speelminuten
          </h2>
          <p className="text-xs text-gray-500">
            Median stabiliteitsscore per minuten-bucket. Rond de buckets waar de
            curve boven ~0.7 komt, kan je spelers met meer vertrouwen beoordelen.
          </p>
        </div>
      </div>

      <div className="h-64 px-3 pb-4 pt-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={buckets}
            margin={{ top: 10, right: 20, left: 40, bottom: 30 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="midMinutes"
              name="Minuten"
              tick={{ fontSize: 11 }}
              label={{
                value: "Speelminuten (midden van bucket)",
                position: "insideBottom",
                offset: -20,
                fontSize: 12,
              }}
            />
            <YAxis
              domain={[0, 1]}
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => `${Math.round(v * 100)}%`}
              label={{
                value: "Median stabiliteitsscore",
                angle: -90,
                position: "insideLeft",
                offset: 10,
                fontSize: 12,
              }}
            />
            <Tooltip
              formatter={(value, name) => {
                if (name === "medianReliability") {
                  return [`${(value * 100).toFixed(1)}%`, "Median stabiliteit"];
                }
                if (name === "pctHigh") {
                  return [`${(value * 100).toFixed(1)}%`, "≥ 0.55"];
                }
                if (name === "count") {
                  return [value, "# spelers in bucket"];
                }
                return [value, name];
              }}
              labelFormatter={(label, payload) => {
                if (!payload || !payload.length) return "";
                const b = payload[0].payload;
                return `Bucket: ${b.label}`;
              }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="medianReliability"
              name="Median stabiliteit"
              dot={false}
              strokeWidth={2}
            />
            <Line
              type="monotone"
              dataKey="pctHigh"
              name="Aandeel spelers ≥ 0.55"
              dot={false}
              strokeDasharray="4 4"
              strokeWidth={2}
            />
            <ReferenceLine
              y={0.55}
              strokeDasharray="3 3"
              strokeOpacity={0.6}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="px-4 pb-3 text-[11px] text-gray-500 space-y-1">
        <p>
          • Elke punt is een minuten-range (bijv. 0–90, 91–180, …).
        </p>
        <p>
          • Boven de horizontale lijn op 0.55 zijn de schattingen gemiddeld
          vrij stabiel; daar kan je impactscore ranglijsten met meer
          vertrouwen gebruiken.
        </p>
      </div>
    </div>
  );
}

// -------- Evolutie van R² per speeldag (RAPM) --------
function R2EvolutionChart({ data, overallR2 }) {
  if (!data || !data.length) return null;

  const chartData = data.map((d) => ({
    round: d.round,
    R2: d.R2,
    baseline: overallR2 ?? null,
  }));

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-4">
      <h3 className="text-sm font-semibold mb-2">
        Evolutie van model-R² per speeldag (RAPM)
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Hoe meer speeldagen, hoe meer verklarende variantie het RAPM-model
        normaal gezien oppikt. Dit toont de verklarende kracht (R²) per
        speeldag.
      </p>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="round"
              label={{ value: "Speeldag", position: "insideBottom", offset: -4 }}
            />
            <YAxis
              domain={[0, 1]}
              tickFormatter={(v) => `${Math.round(v * 100)}%`}
            />
            <Tooltip
              formatter={(v, name) =>
                name === "R2"
                  ? [`${(v * 100).toFixed(1)}%`, "R²"]
                  : [`${(v * 100).toFixed(1)}%`, "R² over volledige dataset"]
              }
              labelFormatter={(lbl) => `Speeldag ${lbl}`}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="R2"
              dot={false}
              strokeWidth={2}
              name="R² per speeldag"
            />
            {overallR2 != null && (
              <Line
                type="monotone"
                dataKey="baseline"
                dot={false}
                strokeDasharray="4 4"
                strokeWidth={1.5}
                name="R² volledige seizoen"
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}


function TeamInternalRanking({ players, team }) {
  if (!team || team === "ALL" || !players || !players.length) return null;

  const positives = [...players]
    .filter((p) => (p.impactScore ?? 0) > 0)
    .sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0))
    .slice(0, 5);

  const negatives = [...players]
    .filter((p) => (p.impactScore ?? 0) < 0)
    .sort((a, b) => (a.impactScore ?? 0) - (b.impactScore ?? 0))
    .slice(0, 5);

  if (!positives.length && !negatives.length) return null;

  const fmt = (v, d = 2) =>
    v === null || v === undefined || Number.isNaN(v)
      ? "—"
      : Number(v).toFixed(d);

  return (
    <div className="mb-6 rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-semibold">
            Interne ranking — {team}
          </h2>
          <p className="text-xs text-gray-500">
            Top 5 dragers (links) en top 5 negatieve impactspelers (rechts),
            op basis van ImpactScore.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <h3 className="text-xs font-semibold text-emerald-700 uppercase mb-1">
            Positieve impact
          </h3>
          {positives.length ? (
            <ul className="space-y-1.5">
              {positives.map((p, i) => (
                <li
                  key={p.name + "_pos_" + i}
                  className="flex items-center justify-between"
                >
                  <span>
                    <span className="text-xs text-gray-400 mr-1">
                      #{i + 1}
                    </span>
                    <span className="font-medium">{p.name}</span>
                    {p.type && (
                      <span className="ml-1 text-[11px] text-gray-500">
                        ({p.type})
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-gray-700">
                    ImpactScore{" "}
                    <span className="font-semibold">
                      {fmt(p.impactScore, 3)}
                    </span>
                    {" · "}
                    stab{" "}
                    <span className="font-semibold">
                      {fmt(p.stability, 2)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-500">
              Geen duidelijke positieve outliers.
            </p>
          )}
        </div>

        <div>
          <h3 className="text-xs font-semibold text-red-700 uppercase mb-1">
            Negatieve impact
          </h3>
          {negatives.length ? (
            <ul className="space-y-1.5">
              {negatives.map((p, i) => (
                <li
                  key={p.name + "_neg_" + i}
                  className="flex items-center justify-between"
                >
                  <span>
                    <span className="text-xs text-gray-400 mr-1">
                      #{i + 1}
                    </span>
                    <span className="font-medium">{p.name}</span>
                    {p.type && (
                      <span className="ml-1 text-[11px] text-gray-500">
                        ({p.type})
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-gray-700">
                    ImpactScore{" "}
                    <span className="font-semibold">
                      {fmt(p.impactScore, 3)}
                    </span>
                    {" · "}
                    stab{" "}
                    <span className="font-semibold">
                      {fmt(p.reliability, 2)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-500">
              Geen duidelijke negatieve outliers.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}



// -------- Tabel met ranglijst --------
// -------- Tabel met ranglijst --------
function RankingTable({ rows }) {
  const [sortKey, setSortKey] = useState("finalScore");
  const [sortDir, setSortDir] = useState("desc");

  // helper om kleur te kiezen op basis van betrouwbaarheid
  const reliabilityColor = (r) => {
    if (r == null || Number.isNaN(r)) {
      return "bg-gray-200 text-gray-700";
    }
    if (r >= 0.8) return "bg-emerald-500 text-white";       // groen
    if (r >= 0.6) return "bg-lime-400 text-gray-900";       // lichtgroen/geel
    if (r >= 0.4) return "bg-amber-400 text-gray-900";      // oranje
    return "bg-red-500 text-white";                         // rood
  };

  const sorted = useMemo(() => {
    const arr = rows || [];

    const getVal = (p, key) => {
      switch (key) {
        case "name":
          return p.name || "";
        case "team":
          return p.team || "";
        case "mins":
          return p.mins ?? -1;
        case "impactScore":
          return p.impactScore ?? -999;
        case "rapm":
          return p.rapm ?? 0;
        case "rapmSnr":
          return p.rapmSnr ?? 0;
        case "xppm":
          return p.xppm ?? 0;
        case "xppmSnr":
          return p.xppmSnr ?? 0;
        case "reliability":
          return p.reliability ?? 0;
        case "stability":
          return p.stability ?? 0;
        case "finalScore":
          return p.finalScore ?? -1;
        case "confidence":
          return p.confidence ?? 0;
        default:
          return 0;
      }
    };

    const copy = [...arr];
    copy.sort((a, b) => {
      const va = getVal(a, sortKey);
      const vb = getVal(b, sortKey);

      if (typeof va === "string" || typeof vb === "string") {
        const cmp = String(va).localeCompare(String(vb));
        return sortDir === "asc" ? cmp : -cmp;
      }
      const diff = (va ?? 0) - (vb ?? 0);
      return sortDir === "asc" ? diff : -diff;
    });

    return copy;
  }, [rows, sortKey, sortDir]);

  const onSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const arrow = (key) => {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? "▲" : "▼";
  };

  if (!rows?.length) return null;

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Ranglijst — impactvolle spelers</h2>
          <p className="text-xs text-gray-500">
            Sorteer op impactscore, S/N, stabiliteit of betrouwbaarheid. 
            Kleuren tonen betrouwbaarheid: rood &lt; oranje &lt; geelgroen &lt; groen.
          </p>
        </div>
        <span className="text-xs text-gray-400">
          Klik op kolomkop om te sorteren
        </span>
      </div>

      <div className="ps-scroll">
        <table className="min-w-full text-xs">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-2 py-2 text-left">#</th>
              <th
                className="px-2 py-2 text-left cursor-pointer select-none"
                onClick={() => onSort("name")}
              >
                Speler {arrow("name")}
              </th>
              <th
                className="px-2 py-2 text-left cursor-pointer select-none"
                onClick={() => onSort("team")}
              >
                Team {arrow("team")}
              </th>
              <th className="px-2 py-2 text-left">Type</th>
              <th
                className="px-2 py-2 text-right cursor-pointer select-none"
                onClick={() => onSort("mins")}
              >
                Min. {arrow("mins")}
              </th>
              <th
                className="px-2 py-2 text-right cursor-pointer select-none"
                onClick={() => onSort("impactScore")}
              >
                Impactscore {arrow("impactScore")}
              </th>
              <th
                className="px-2 py-2 text-right cursor-pointer select-none"
                onClick={() => onSort("rapm")}
              >
                RAPM / 90 {arrow("rapm")}
              </th>
              <th
                className="px-2 py-2 text-right cursor-pointer select-none"
                onClick={() => onSort("rapmSnr")}
              >
                S/N RAPM {arrow("rapmSnr")}
              </th>
              <th
                className="px-2 py-2 text-right cursor-pointer select-none"
                onClick={() => onSort("xppm")}
              >
                xPPM / 90 {arrow("xppm")}
              </th>
              <th
                className="px-2 py-2 text-right cursor-pointer select-none"
                onClick={() => onSort("xppmSnr")}
              >
                S/N xPPM {arrow("xppmSnr")}
              </th>
              {/* NIEUW: Stabiliteit-kolom */}
              <th
                className="px-2 py-2 text-right cursor-pointer select-none"
                onClick={() => onSort("stability")}
              >
                Stabiliteit {arrow("stability")}
              </th>
              {/* NIEUW: Betrouwbaarheid in kleur */}
              <th
                className="px-2 py-2 text-right cursor-pointer select-none"
                onClick={() => onSort("reliability")}
              >
                Betrouwbaarheid {arrow("reliability")}
              </th>
              <th
                className="px-2 py-2 text-right cursor-pointer select-none"
                onClick={() => onSort("finalScore")}
              >
                Scout score {arrow("finalScore")}
              </th>
              <th className="px-2 py-2">Lijst</th>
              <th className="px-2 py-2">Profiel</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((p, idx) => (
              <tr key={`${p.team}-${p.name}-${idx}`} className="hover:bg-gray-50">
                <td className="px-2 py-1 text-left text-gray-400">
                  {idx + 1}
                </td>
                <td className="px-2 py-1 text-left font-medium">
                  {p.name}
                </td>
                <td className="px-2 py-1 text-left text-gray-600">
                  {p.team}
                </td>
                <td className="px-2 py-1 text-left text-gray-600">
                  {p.type}
                </td>
                <td className="px-2 py-1 text-right">
                  {fmt(p.mins, 0)}
                </td>
                <td className="px-2 py-1 text-right font-semibold">
                  {fmt(p.impactScore, 3)}
                </td>
                <td className="px-2 py-1 text-right">
                  {fmt(p.rapm, 3)}
                </td>
                <td className="px-2 py-1 text-right">
                  {fmt(p.rapmSnr, 2)}
                </td>
                <td className="px-2 py-1 text-right">
                  {fmt(p.xppm, 3)}
                </td>
                <td className="px-2 py-1 text-right">
                  {fmt(p.xppmSnr, 2)}
                </td>
                {/* Stabiliteit: mini-bar + waarde */}
                <td className="px-2 py-1 text-right text-xs">
                  <div className="flex items-center justify-end gap-1">
                    <div className="w-12 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-1.5 rounded-full bg-sky-500"
                        style={{
                          width: `${Math.max(
                            0,
                            Math.min(1, p.stability ?? 0)
                          ) * 100}%`,
                        }}
                      />
                    </div>
                    <span>{fmt(p.stability, 2)}</span>
                  </div>
                </td>
                {/* Betrouwbaarheid als gekleurde pill */}
                <td className="px-2 py-1 text-right text-xs">
                  <span
                    className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full font-medium ${reliabilityColor(
                      p.reliability
                    )}`}
                    title={`Betrouwbaarheid ${fmt(p.reliability, 2)}`}
                  >
                    {fmt(p.reliability, 2)}
                  </span>
                </td>
                <td className="px-2 py-1 text-right font-semibold">
                  {fmt(p.finalScore, 2)}
                </td>
                <td className="px-2 py-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs ${listBadge(p.list).cls}`}>
                    {listBadge(p.list).label}
                  </span>
                </td>

                <td className="px-2 py-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs ${profileBadge(p.profile).cls}`}>
                    {profileBadge(p.profile).label}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


// -------- Scatter-plot --------
function ImpactScatter({ rows, yMetric }) {
  const data = useMemo(
    () =>
      (rows || []).map((p) => ({
        ...p,
        // grootte van de dot: 50–250 afhankelijk van reliability
        size: 50 + 200 * Math.max(0, Math.min(1, p.reliability || 0)),
      })),
    [rows]
  );

  if (!data.length) return null;

  const yKey = yMetric === "xPPM" ? "xppm" : "rapm";
  const yLabel = yMetric === "xPPM" ? "xPPM per 90" : "RAPM per 90";

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Impact vs speelminuten</h2>
          <p className="text-xs text-gray-500">
            Grote, donkere punten = betrouwbaardere schattingen.
          </p>
        </div>
      </div>

      <div className="h-80 px-3 pb-4 pt-3">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 20, left: 40, bottom: 30 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="mins"
              name="Minuten"
              tick={{ fontSize: 11 }}
              label={{
                value: "Speelminuten",
                position: "insideBottom",
                offset: -20,
                fontSize: 12,
              }}
            />
            <YAxis
              type="number"
              dataKey={yKey}
              name={yLabel}
              tick={{ fontSize: 11 }}
              label={{
                value: yLabel,
                angle: -90,
                position: "insideLeft",
                offset: 10,
                fontSize: 12,
              }}
            />
            <Tooltip content={<ScatterTooltip />} />
            <ReferenceLine y={0} stroke="#9ca3af" strokeDasharray="3 3" />
            <Scatter
              name="Spelers"
              data={data}
              fill="#2563eb"
              fillOpacity={0.35}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ImpactStabilityScatter({ rows }) {
  const data = (rows || []).map((p) => ({
    ...p,
    // grootte van de dot op basis van betrouwbaarheid
    size: 40 + 160 * Math.max(0, Math.min(1, p.reliability ?? 0)),
  }));

  if (!data.length) return null;

  const confVals = data.map(d => d.confidence ?? 0).filter(v => Number.isFinite(v));
  const confSorted = [...confVals].sort((a,b)=>a-b);
  const q75 = confSorted.length ? confSorted[Math.floor(confSorted.length * 0.75)] : 0.55;

  const impVals = data.map(d => d.impactScore ?? 0).filter(v => Number.isFinite(v));
  const impSorted = [...impVals].sort((a,b)=>a-b);
  const imp75 = impSorted.length ? impSorted[Math.floor(impSorted.length * 0.75)] : 0;


  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Impact vs confidence</h2>
          <p className="text-xs text-gray-500">
            X-as = ImpactScore, Y-as = confidence (0–1).
            Rechtsboven = top targets, rechtsonder = high upside (impact maar onzeker).
          </p>

        </div>
      </div>

      <div className="h-80 px-3 pb-4 pt-3">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 20, left: 40, bottom: 30 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="impactScore"
              name="ImpactScore"
              tick={{ fontSize: 11 }}
              label={{
                value: "ImpactScore (RAPM + xPPM)",
                position: "insideBottom",
                offset: -20,
                fontSize: 12,
              }}
            />
            <YAxis
              type="number"
              dataKey="confidence"
              name="Confidence"
              domain={[0, 1]}
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => `${Math.round(v * 100)}%`}
              label={{
                value: "Confidence (0–1)",
                angle: -90,
                position: "insideLeft",
                offset: 10,
                fontSize: 12,
              }}
            />
            {/* Gebruik dezelfde tooltip als de andere scatter */}
            <Tooltip content={<ScatterTooltip />} />
            {/* Verticale lijn bij impact = 0 (neutraal) */}
            <ReferenceLine x={imp75} stroke="#22c55e" strokeDasharray="3 3" />
            {/* Horizontale lijn bij stabiliteit ≈ 0.7 (betrouwbaar) */}
            <ReferenceLine y={q75} stroke="#22c55e" strokeDasharray="3 3" />

            <Scatter
              name="Spelers"
              data={data}
              fill="#16a34a"
              fillOpacity={0.35}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ScoutingBlock({ title, subtitle, players }) {
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-4">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-xs text-gray-500 mb-2">{subtitle}</p>

      {(!players || players.length === 0) ? (
        <p className="text-xs text-gray-400 italic">Geen spelers in dit profiel</p>
      ) : (
        <ul className="space-y-1">
          {players.slice(0, 8).map((p, i) => (
            <li key={`${p.team}-${p.name}-${i}`} className="flex justify-between text-sm">
              <span className="truncate">
                {p.name} <span className="text-gray-400 text-xs">({p.team})</span>
              </span>
              <span className="font-mono text-xs">{fmt(p.finalScore, 2)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}




// -------- Hoofd-app (scouting tool) --------
function App() {
  const [playerStats, setPlayerStats] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [selectedTeam, setSelectedTeam] = useState("ALL");
  const [showPlayers, setShowPlayers] = useState(true);
  const [showKeepers, setShowKeepers] = useState(true);
  const [minMinutes, setMinMinutes] = useState(0);
  const [yMetric, setYMetric] = useState("RAPM"); // of "xPPM"
  const [targetTierFilter, setTargetTierFilter] = useState("ALL");


  useEffect(() => {
    const url = `${import.meta.env.BASE_URL}data/player_stats.json`;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Kon player_stats.json niet laden");
        return r.json();
      })
      .then((json) => {
        setPlayerStats(json);
        setLoading(false);
      })
      .catch((e) => {
        console.error(e);
        setError(e.message || String(e));
        setLoading(false);
      });
  }, []);

  // Alle spelers flattenen
  const allPlayers = useMemo(() => {
    if (!playerStats) return [];

    const out = [];

    for (const [teamName, players] of Object.entries(playerStats)) {
      if (!Array.isArray(players)) continue;

      players.forEach((row) => {
        const mins = toNum(row.Speelminuten) ?? 0;

        const rapm = toNum(row.RAPM_per90);
        const rapmSe = toNum(row.RAPM_SE_per90);
        const rapmZ = toNum(row.RAPM_z);

        const xppm = toNum(row.xPPM_per90);
        const xppmSe = toNum(row.xPPM_SE);
        const xppmZ = toNum(row.xPPM_z);

        // --- S/N initieel zelf berekenen ---
        let rapmSnr =
          rapm !== null && rapmSe !== null && rapmSe > 0
            ? Math.abs(rapm) / rapmSe
            : null;
        let xppmSnr =
          xppm !== null && xppmSe !== null && xppmSe > 0
            ? Math.abs(xppm) / xppmSe
            : null;

        // --- Backend-velden inlezen ---
        const reliabilityBackend = toNum(row.Reliability_overall);
        const impactScoreBackend = toNum(row.ImpactScore);
        const stabilityBackend = toNum(row.StabilityScore);

        // --- Final Scouting Score (backend) ---
        const finalScoreBackend = toNum(row.FinalScoutingScore);
        const confidenceBackend = toNum(row.Confidence);
        const impactNormBackend = toNum(row.Impact_norm);
        const minutesFactorBackend = toNum(row.Minutes_factor);

         // Fallbacks als backend (nog) geen FSS levert
          const impactNormComputed = (() => {
            // simple robust-ish scaling zonder percentielen: map impactScore naar 0..1 met clamp
            const x = impactScoreBackend ?? 0;
            // schaal: 0.0 -> 0.5; 0.25 -> ~0.75; -0.25 -> ~0.25 (tunable)
            const v = 0.5 + 2 * x;
            return Math.max(0, Math.min(1, v));
          })();

          const minutesFactorComputed = (() => {
            // logistic ~900 min midpoint
            const m = mins ?? 0;
            const v = 1 / (1 + Math.exp(-(m - 900) / 300));
            return Math.max(0, Math.min(1, v));
          })();

                  // --- fallback: reliability zelf berekenen als backend ontbreekt ---
          const minutesFactor = Math.max(
            0,
            Math.min(1, mins / (90 * 10)) // t.o.v. ~10 volledige matchen
          );
          const snrR = rapmSnr ? rapmSnr / (rapmSnr + 1) : 0;
          const snrX = xppmSnr ? xppmSnr / (xppmSnr + 1) : 0;
          const snrCombined =
            snrR && snrX ? 0.5 * (snrR + snrX) : snrR || snrX || 0;

          const reliabilityComputed =
            0.6 * minutesFactor + 0.4 * snrCombined;


          const confidenceComputed = (() => {
            const rel = reliabilityBackend ?? reliabilityComputed ?? 0;
            const stab = Number.isFinite(stabilityBackend) ? stabilityBackend : 0;
            return Math.max(0, Math.min(1, Math.sqrt(Math.max(0, rel) * Math.max(0, stab)) * Math.sqrt(minutesFactorComputed)));
          })();

          const finalScoreComputed = impactNormComputed * confidenceComputed;



        // Explainability (tekst)
        const explainImpact = row.Explain_Impact || "";
        const explainReliability = row.Explain_Reliability || "";
        const explainStability = row.Explain_Stability || "";


        const rapmSnrBackend = toNum(row.RAPM_SNR);
        const xppmSnrBackend = toNum(row.xPPM_SNR);

        // Als backend S/N beschikbaar is, die gebruiken (consistent met Python)
        if (Number.isFinite(rapmSnrBackend)) rapmSnr = rapmSnrBackend;
        if (Number.isFinite(xppmSnrBackend)) xppmSnr = xppmSnrBackend;



        // ✅ frontend vertrouwt nu op backend-betrouwbaarheid
        const reliability = reliabilityBackend ?? reliabilityComputed;

        // Stabiliteit: apart veld (geen fallback naar reliability, anders lijken ze altijd gelijk)
        const stability = Number.isFinite(stabilityBackend) ? stabilityBackend : 0;


        // Impactscore: combineer z-scores & weeg met reliability
        const zR = rapmZ ?? 0;
        const zX = xppmZ ?? 0;
        const impactBase = 0.6 * zR + 0.4 * zX;

        const impactScore =
          impactScoreBackend ?? impactBase * (reliability ?? 0);

        const tier = classifyTier(impactScore, reliability, mins);

        out.push({
          team: teamName,
          name: row.Speler || row.Player || "Onbekend",
          type: row.Type || "",
          mins,
          rapm,
          rapmSe,
          rapmZ,
          xppm,
          xppmSe,
          xppmZ,
          rapmSnr,
          xppmSnr,
          reliability,
          stability,
          snrCombined,
          impactScore,
          tier,
          finalScore: Number.isFinite(finalScoreBackend) ? finalScoreBackend : finalScoreComputed,
          confidence: Number.isFinite(confidenceBackend) ? confidenceBackend : confidenceComputed,
          impactNorm: Number.isFinite(impactNormBackend) ? impactNormBackend : impactNormComputed,
          minutesFactor: Number.isFinite(minutesFactorBackend) ? minutesFactorBackend : minutesFactorComputed,


         
          explainImpact,
          explainReliability,
          explainStability,

        });
      });
    }

    return out;
  }, [playerStats]);



  // Bepaal automatisch een redelijk minimum aantal minuten (40% van max)
  const autoMinMinutes = useMemo(() => {
    const maxMins = Math.max(
      0,
      ...allPlayers.map((p) => p.mins || 0)
    );
    if (!Number.isFinite(maxMins) || maxMins <= 0) return 0;
    return Math.round(maxMins * 0.4);
  }, [allPlayers]);

  useEffect(() => {
    if (autoMinMinutes > 0 && minMinutes === 0) {
      setMinMinutes(autoMinMinutes);
    }
  }, [autoMinMinutes, minMinutes]);

  const teams = useMemo(() => {
    const set = new Set();
    allPlayers.forEach((p) => {
      if (p.team) set.add(p.team);
    });
    return ["ALL", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [allPlayers]);

    // Buckets: evolutie stabiliteit vs. minuten
  const reliabilityBuckets = useMemo(() => {
    if (!allPlayers || !allPlayers.length) return [];

    // grootte van één bucket in minuten (bv. 90 = 1 volledige match)
    const BUCKET_SIZE = 90;

    const valid = allPlayers.filter(
      (p) =>
        Number.isFinite(p.mins) &&
        p.mins > 0 &&
        p.reliability !== null &&
        p.reliability !== undefined
    );

    if (!valid.length) return [];

    const maxMins = Math.max(...valid.map((p) => p.mins));
    const maxBucketIndex = Math.ceil(maxMins / BUCKET_SIZE);

    const buckets = [];

    for (let i = 1; i <= maxBucketIndex; i += 1) {
      const lower = (i - 1) * BUCKET_SIZE;
      const upper = i * BUCKET_SIZE;

      const inBucket = valid.filter(
        (p) => p.mins > lower && p.mins <= upper
      );
      if (!inBucket.length) continue;

      const rels = inBucket
        .map((p) => p.reliability ?? 0)
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);

      if (!rels.length) continue;

      const median = rels[Math.floor(rels.length / 2)];
      const highCutoff = 0.55;
      const pctHigh =
        inBucket.filter((p) => (p.reliability ?? 0) >= highCutoff).length /
        inBucket.length;

      buckets.push({
        label: `${lower + 1}–${upper} min`,
        midMinutes: lower + BUCKET_SIZE / 2,
        medianReliability: median,
        pctHigh,
        count: inBucket.length,
      });
    }

    return buckets;
  }, [allPlayers]);


    const modelDiagnostics = useMemo(
    () => extractR2ByRound(playerStats),
    [playerStats]
  );



  const filteredPlayers = useMemo(() => {
    let rows = allPlayers;

    if (selectedTeam !== "ALL") {
      rows = rows.filter((p) => p.team === selectedTeam);
    }

    rows = rows.filter((p) => (p.mins || 0) >= (minMinutes || 0));

    if (!showPlayers || !showKeepers) {
      rows = rows.filter((p) => {
        const isK =
          String(p.type || "").toLowerCase() === "keeper";
        if (isK && !showKeepers) return false;
        if (!isK && !showPlayers) return false;
        return true;
      });
    }

        // Filter op transfertarget-tier (A/B/C/NEG)
    if (targetTierFilter !== "ALL") {
      if (targetTierFilter === "NEG") {
        rows = rows.filter((p) => p.tier === "NEG");
      } else {
        rows = rows.filter((p) => p.tier === targetTierFilter);
      }
    }


    return rows;
  }, [allPlayers, selectedTeam, minMinutes, showPlayers, showKeepers, targetTierFilter]);


    const cutoffs = useMemo(() => {
    const minsArr = filteredPlayers.map(p => p.mins).filter(Number.isFinite);
    const confArr = filteredPlayers.map(p => p.confidence).filter(Number.isFinite);
    const impArr  = filteredPlayers.map(p => p.impactScore).filter(Number.isFinite);
    const fssArr  = filteredPlayers.map(p => p.finalScore).filter(Number.isFinite);

    return {
      mins_p60: quantile(minsArr, 0.60),
      mins_p75: quantile(minsArr, 0.75),

      conf_p75: quantile(confArr, 0.75),
      conf_p90: quantile(confArr, 0.90),

      impact_p75: quantile(impArr, 0.75),
      impact_p90: quantile(impArr, 0.90),

      fss_p85: quantile(fssArr, 0.85),

      conf_p60: quantile(confArr, 0.60),
      impact_p10: quantile(impArr, 0.10),
      impact_p25: quantile(impArr, 0.25),

    };
  }, [filteredPlayers]);

    const scoutedPlayers = useMemo(() => {
    const base = (filteredPlayers || []).map((p) => {
      const profile = classifyProfile(p, cutoffs);
      const list = classifyListABC(p, cutoffs);
      return { ...p, profile, list };
    });

    if (targetTierFilter === "ALL") return base;
    return base.filter((p) => p.list === targetTierFilter);
  }, [filteredPlayers, cutoffs, targetTierFilter]);



    const eliteTargets = filteredPlayers.filter(p =>
    p.finalScore >= cutoffs.fss_p85 &&
    p.confidence  >= cutoffs.conf_p75 &&
    p.mins        >= cutoffs.mins_p60
  );

    const highUpsideLowMinutes = filteredPlayers.filter(p =>
    p.impactScore >= cutoffs.impact_p75 &&
    p.confidence  >= cutoffs.conf_p75 &&
    p.mins        <  cutoffs.mins_p60
  );

    const reliableRegulars = filteredPlayers.filter(p =>
    p.confidence >= cutoffs.conf_p90 &&
    p.impactScore < cutoffs.impact_p75 &&
    p.mins >= cutoffs.mins_p75
  );

    const highRiskHighReward = filteredPlayers.filter(p =>
      p.impactScore >= cutoffs.impact_p90 &&
      p.confidence  <  cutoffs.conf_p75
    );




    const teamPlayersForRanking = useMemo(() => {
    if (selectedTeam === "ALL") return [];
    return (filteredPlayers || []).filter((p) => p.team === selectedTeam);
  }, [filteredPlayers, selectedTeam]);





  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500 text-sm">
          Data aan het laden...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-red-600 text-sm">
          Fout bij laden data: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white text-gray-900">
      <div className="max-w-screen-2xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-3xl font-semibold">
            JPL Scoutingtool — RAPM &amp; xPPM
          </h1>
          <p className="text-gray-500 mt-1 text-sm max-w-2xl">
            Gebruik de filters om impactvolle én betrouwbare spelers te vinden,
            competitiebreed. De impactscore combineert RAPM, xPPM en de
            betrouwbaarheid van de schatting.
          </p>
        </header>

              {/* Globale stabiliteit / betrouwbaarheid */}
      <ReliabilitySummary players={allPlayers} />


        {/* Filters */}
        <section className="mb-6 rounded-2xl bg-white shadow-sm ring-1 ring-black/5 px-4 py-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Team
              </label>
              <select
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10"
                value={selectedTeam}
                onChange={(e) => setSelectedTeam(e.target.value)}
              >
                {teams.map((t) => (
                  <option key={t} value={t}>
                    {t === "ALL" ? "Alle teams" : t}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Minimum speelminuten
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={Math.max(autoMinMinutes * 1.5, autoMinMinutes + 1)}
                  step={30}
                  value={minMinutes}
                  onChange={(e) =>
                    setMinMinutes(Number(e.target.value))
                  }
                  className="flex-1"
                />
                <div className="text-xs text-gray-700 w-20 text-right">
                  {fmt(minMinutes, 0)} min
                </div>
              </div>
              <div className="mt-1 text-[11px] text-gray-500">
                Richtwaarde (40% max): ± {fmt(autoMinMinutes, 0)} min
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-gray-600 mb-1">
                Spelertype
              </span>
              <div className="flex items-center gap-4 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={showPlayers}
                    onChange={(e) =>
                      setShowPlayers(e.target.checked)
                    }
                  />
                  <span>Spelers</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={showKeepers}
                    onChange={(e) =>
                      setShowKeepers(e.target.checked)
                    }
                  />
                  <span>Keepers</span>
                </label>
              </div>
            </div>

                        <div>
              <span className="block text-xs font-medium text-gray-600 mb-1">
                Transfertargets
              </span>
              <div className="flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setTargetTierFilter("ALL")}
                  className={
                    "px-2.5 py-1.5 rounded-full border " +
                    (targetTierFilter === "ALL"
                      ? "bg-black text-white border-black"
                      : "bg-white text-gray-700 border-gray-200")
                  }
                >
                  Alle
                </button>
                <button
                  type="button"
                  onClick={() => setTargetTierFilter("A")}
                  className={
                    "px-2.5 py-1.5 rounded-full border " +
                    (targetTierFilter === "A"
                      ? "bg-emerald-600 text-white border-emerald-600"
                      : "bg-white text-gray-700 border-gray-200")
                  }
                >
                  A-lijst
                </button>
                <button
                  type="button"
                  onClick={() => setTargetTierFilter("B")}
                  className={
                    "px-2.5 py-1.5 rounded-full border " +
                    (targetTierFilter === "B"
                      ? "bg-sky-600 text-white border-sky-600"
                      : "bg-white text-gray-700 border-gray-200")
                  }
                >
                  B-lijst
                </button>
                <button
                  type="button"
                  onClick={() => setTargetTierFilter("C")}
                  className={
                    "px-2.5 py-1.5 rounded-full border " +
                    (targetTierFilter === "C"
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-700 border-gray-200")
                  }
                >
                  C-lijst
                </button>
                <button
                  type="button"
                  onClick={() => setTargetTierFilter("NEG")}
                  className={
                    "px-2.5 py-1.5 rounded-full border " +
                    (targetTierFilter === "NEG"
                      ? "bg-red-600 text-white border-red-600"
                      : "bg-white text-gray-700 border-gray-200")
                  }
                >
                  Negatief
                </button>
              </div>
            </div>




          </div>
        </section>

              {/* Interne teamranking (alleen als een team is gekozen) */}
      <TeamInternalRanking
        players={teamPlayersForRanking}
        team={selectedTeam === "ALL" ? null : selectedTeam}
      />


        {/* Bovenste rij: Scatter + korte samenvatting */}
        <section className="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-800">
                Scatter — minuten vs impact
              </h2>
              <div className="flex items-center gap-2 text-xs">
                <span>Y-as:</span>
                <select
                  className="rounded-lg border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-black/10"
                  value={yMetric}
                  onChange={(e) => setYMetric(e.target.value)}
                >
                  <option value="RAPM">RAPM per 90</option>
                  <option value="xPPM">xPPM per 90</option>
                </select>
              </div>
            </div>
            <ImpactScatter rows={scoutedPlayers} yMetric={yMetric} />
          </div>

          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-4 text-xs text-gray-700 space-y-2">
            <h3 className="text-sm font-semibold">
              Hoe lees je deze scoutingtool?
            </h3>
            <ul className="list-disc list-inside space-y-1">
              <li>
                Zoek punten rechts (veel minuten) én ver weg van 0 op de Y-as
                (hoge impact).
              </li>
              <li>
                Grote, donkere punten = hoge betrouwbaarheid (veel minuten +
                scherp signaal).
              </li>
              <li>
                In de tabel beneden vind je de ranglijst op basis van een
                gecombineerde impactscore.
              </li>
              <li>
                Spelers die altijd spelen maar weinig van het model leren krijgen
                meestal een lagere S/N en dus lagere betrouwbaarheid.
              </li>
            </ul>
          </div>
        </section>


        {/* Tweede scatter: Impact vs stabiliteit */}
        <section className="mb-8">
          <ImpactStabilityScatter rows={scoutedPlayers} />
        </section>

        const eliteTargets = useMemo(
          () => scoutedPlayers.filter(p => p.profile === "Elite").sort((a,b)=> (b.finalScore??0)-(a.finalScore??0)),
          [scoutedPlayers]
        );

        const highUpsideLowMinutes = useMemo(
          () => scoutedPlayers.filter(p => p.profile === "High-upside").sort((a,b)=> (b.finalScore??0)-(a.finalScore??0)),
          [scoutedPlayers]
        );

        const reliableRegulars = useMemo(
          () => scoutedPlayers.filter(p => p.profile === "Reliable regular").sort((a,b)=> (b.confidence??0)-(a.confidence??0)),
          [scoutedPlayers]
        );

        const highRiskHighReward = useMemo(
          () => scoutedPlayers.filter(p => p.profile === "High risk / high reward").sort((a,b)=> (b.impactScore??0)-(a.impactScore??0)),
          [scoutedPlayers]
        );


        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-4 text-xs text-gray-700">
          <h3 className="text-sm font-semibold mb-2">Definities — Profielen vs A/B/C-lijsten</h3>
          <p className="mb-2">
            <strong>Profielen</strong> beschrijven het type speler (elite, upside, betrouwbaar, high-risk).
            <strong> A/B/C-lijst</strong> is de prioriteit: A = direct target, B = shortlist/opvolgen, C = monitoren.
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li><strong>Elite</strong>: top Final Scouting Score + voldoende minuten + hoge confidence → meestal <strong>A-lijst</strong>.</li>
            <li><strong>High-upside</strong>: hoge impact maar weinig minuten → meestal <strong>B-lijst</strong>.</li>
            <li><strong>Reliable regular</strong>: zeer betrouwbaar, veel minuten, beperkte upside → <strong>B-lijst</strong>.</li>
            <li><strong>High risk / high reward</strong>: top impact maar lage confidence → vaak <strong>C-lijst</strong>.</li>
          </ul>
          <p className="mt-2 text-gray-500">
            Alle drempels zijn <strong>dynamisch</strong> (percentielen) en schuiven mee met het seizoen.
          </p>
        </div>


        {/* =======================
            SCOUTING PROFIELEN
        ======================= */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ScoutingBlock
            title="Elite targets"
            subtitle="Hoge impact + hoge zekerheid + voldoende minuten (A-lijst kandidaten)"
            players={eliteTargets}
          />
          <ScoutingBlock
            title="High-upside (weinig minuten)"
            subtitle="Sterke impact, maar beperkte sample (meestal B-lijst)"
            players={highUpsideLowMinutes}
          />
          <ScoutingBlock
            title="Reliable regulars"
            subtitle="Zeer betrouwbaar profiel, veel minuten, minder upside (B-lijst/rotatie)"
            players={reliableRegulars}
          />
          <ScoutingBlock
            title="High risk / high reward"
            subtitle="Zeer hoge impact maar lage confidence (C-lijst/koopje/gok)"
            players={highRiskHighReward}
          />
        </div>



        {/* Ranglijst */}
        <section className="mb-10">
          <RankingTable rows={scoutedPlayers} />
        </section>

      {/* Evolutie van stabiliteit vs minuten */}
      <section className="mb-8">
        <ReliabilityEvolutionChart buckets={reliabilityBuckets} />
      </section>

      {/* NIEUW: evolutie van R² per speeldag */}
{modelDiagnostics.series.length > 0 && (
  <div className="mt-4">
    <R2EvolutionChart
      data={modelDiagnostics.series}
      overallR2={modelDiagnostics.overallR2}
    />
  </div>
)}


      </div>
    </div>
  );
}

export default App;
