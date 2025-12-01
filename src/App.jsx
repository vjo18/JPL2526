// src/App.jsx
import React, { useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  LineChart, Line,
  ScatterChart, Scatter,
  BarChart, Bar, LabelList,
  PieChart, Pie,
  Cell, ReferenceArea, ReferenceLine,
  CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer
} from "recharts";


const ALLOWED_TEAMS = [
  "K. Eendr. Wervik A","K.S.C. Wielsbeke","K.R.C. Waregem A","Zwevegem Sport",
  "K. FC Marke A","K. RC Bissegem","S.V. Wevelgem City A","FC Sp. Heestert A",
  "Club Roeselare","K. WS Oudenburg","K. VC Ardooie A","KFC Aalbeke Sport A",
  "K. SV Moorsele A","K. FC Varsenare A","K. FC Heist A","K. SV Bredene A",
];
const DEFAULT_TEAM = "K. VC Ardooie A";
const BINS = ["0-14","15-30","31-45","46-59","60-75","76-90"];
const fmt = (v) => (v === 0 || Number.isFinite(v)) ? v : "—";

const median = (values) => {
  const arr = (values || [])
    .map(v => Number(v))
    .filter(v => Number.isFinite(v))
    .sort((a, b) => a - b);

  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2
    ? arr[mid]
    : (arr[mid - 1] + arr[mid]) / 2;
};


/* ------------------ UI helpers ------------------ */
const ResultBadge = React.memo(({ value, res }) => {
  const base = "px-2 py-1 rounded-lg text-center text-sm font-medium";
  if (!value) return <span className="text-gray-400">—</span>;
  if (!res) return <span className={`${base} bg-gray-50 ring-1 ring-gray-200 text-gray-700`}>{value}</span>;
  if (res === "W") return <span className={`${base} bg-green-100`}>{value}</span>;
  if (res === "G") return <span className={`${base} bg-gray-200`}>{value}</span>;
  return <span className={`${base} bg-red-100`}>{value}</span>;
});

const Last5Strip = React.memo(function Last5Strip({ seq }) {
  // seq: array zoals ["W","G","V","W","W"]
  const vals = Array.isArray(seq) ? seq.slice(-5) : [];

  const base =
    "inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold";

  const color = (r) =>
    r === "W"
      ? "bg-green-500 text-white"
      : r === "G"
      ? "bg-gray-400 text-white"
      : "bg-red-500 text-white";

  if (!vals.length) return <span className="text-xs text-gray-400">—</span>;

  return (
    <div className="flex justify-center gap-1">
      {vals.map((r, i) => (
        <span key={i} className={`${base} ${color(r)}`} title={r}>
          {r}
        </span>
      ))}
    </div>
  );
});


/* ------------------ ELO Ranking table ----------------*/
const EloRankingTable = ({ teamName, teamsStats }) => {
  const rows = React.useMemo(
    () => (teamsStats || [])
      .filter(t => ALLOWED_TEAMS.includes(t.Team))
      .map(t => ({ Team: t.Team, ELO: Number(t.ELO ?? 0) }))
      .sort((a, b) => (b.ELO - a.ELO) || a.Team.localeCompare(b.Team)),
    [teamsStats]
  );

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-lg font-semibold">Ranking — ELO</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="table-auto text-sm border-collapse">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left w-10">#</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">Team</th>
              <th className="px-3 py-2 text-right whitespace-nowrap w-0">ELO</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.Team} className={r.Team === teamName ? "bg-amber-50" : "hover:bg-gray-50"}>
                <td className="px-3 py-2 text-left">{i + 1}</td>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{r.Team}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap w-0">{Math.round(r.ELO)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};



/* ------------------ NIEUW: Bar chart component ------------------ */
const BarListChart = ({ title, rows, selected, fixedMaxAbs, leftLabel, rightLabel }) => {
  const autoMax = React.useMemo(
    () => Math.max(1, ...rows.map(r => Math.abs(Number(r.value) || 0))),
    [rows]
  );
  const maxAbs = Number.isFinite(fixedMaxAbs) && fixedMaxAbs > 0 ? fixedMaxAbs : autoMax;

  const pct = (v) => Math.min(100, Math.max(0, (Math.abs(Number(v) || 0) / maxAbs) * 100));
  const pos = (v) => (Number(v) > 0 ? pct(v) : 0);
  const neg = (v) => (Number(v) < 0 ? pct(v) : 0);

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>

      <div className="p-4">
        <ul className="space-y-2">
          {rows.map(({ team, value }, i) => (
            <li key={team} className={`rounded-md ${team === selected ? "bg-amber-50" : ""}`}>
              <div className="flex items-center gap-3 px-2 py-1">
                {/* Teamnaam (vaste kolom, geen overlap) */}
                <div className="w-56 shrink-0 pr-2">
  <div className="flex items-center gap-2 justify-end text-sm">
    <span className="w-6 text-gray-500 text-right">{i + 1}</span>
    <span className="truncate text-right" title={team}>{team}</span>
  </div>
</div>


                {/* Bartrack (50/50 split, geen nul-lijn) */}
                <div className="relative h-3 flex-1 overflow-hidden">
                  <div className="grid grid-cols-2 h-3">
                    <div className="pr-1">
                      <div
                        className="h-3 bg-blue-500 rounded-sm float-right"
                        style={{ width: `${neg(value)}%` }}
                        aria-hidden
                      />
                    </div>
                    <div className="pl-1">
                      <div
                        className="h-3 bg-blue-500 rounded-sm"
                        style={{ width: `${pos(value)}%` }}
                        aria-hidden
                      />
                    </div>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>

        {/* X-as labels: uitgelijnd met bartrack en begrensd binnen het bargebied */}
        {(leftLabel || rightLabel) && (
          <div className="mt-3 ml-52 px-2">
            <div className="grid grid-cols-2">
              <div className="text-xs text-gray-500 text-left pr-1 truncate">{leftLabel}</div>
              <div className="text-xs text-gray-500 text-right pl-1 truncate">{rightLabel}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------ NIEUW: Team RAPM boxplots ------------------ */
const TeamRapmBoxplots = ({ dataRapm, dataXppm, selectedTeam, minMinutes }) => {
  const [metric, setMetric] = React.useState("RAPM"); // "RAPM" of "xPPM"

  const data = metric === "RAPM" ? dataRapm : dataXppm;
  if (!data?.length) return null;

  // sorteren: sterkste teams (hoogste mediane waarde) bovenaan
  const sorted = [...data].sort(
    (a, b) => (b.median - a.median) || a.team.localeCompare(b.team)
  );

  const globalMin = Math.min(...sorted.map((d) => d.min));
  const globalMax = Math.max(...sorted.map((d) => d.max));
  const span = globalMax - globalMin || 1;
  const scale = (v) => ((v - globalMin) / span) * 100;

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold">
            Teamsterkte &amp; diepte — {metric}
          </h3>
          <div className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-1 py-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setMetric("RAPM")}
              className={
                "px-2 py-[2px] rounded-full " +
                (metric === "RAPM"
                  ? "bg-white shadow text-gray-900"
                  : "text-gray-500")
              }
            >
              RAPM
            </button>
            <button
              type="button"
              onClick={() => setMetric("xPPM")}
              className={
                "px-2 py-[2px] rounded-full " +
                (metric === "xPPM"
                  ? "bg-white shadow text-gray-900"
                  : "text-gray-500")
              }
            >
              xPPM
            </button>
          </div>
        </div>
        <span className="text-xs text-gray-500">
          Boxplots per team ({metric}_per90, min. {Math.round(minMinutes ?? 0)}{" "}
          min)
        </span>
      </div>

      <div className="px-4 pt-3 pb-4">
        <div className="text-[11px] text-gray-500 mb-2">
          Whiskers = min/max, box = Q1–Q3, streep = mediaan
        </div>

        <ul className="space-y-1.5">
          {sorted.map((row, i) => (
            <li
              key={row.team}
              className={`flex items-center gap-3 px-2 py-1 rounded-md ${
                row.team === selectedTeam ? "bg-amber-50" : ""
              }`}
            >
              {/* # + teamnaam */}
              <div className="w-60 shrink-0 pr-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="w-5 text-right text-gray-500">
                    {i + 1}
                  </span>
                  <span className="truncate">{row.team}</span>
                </div>
              </div>

              {/* boxplot-balk */}
              <div className="flex-1 relative h-6">
                {/* volledige range */}
                <div className="absolute inset-y-2 left-0 right-0 bg-gray-100 rounded-full" />

                {/* whiskers */}
                <div
                  className="absolute inset-y-[7px]"
                  style={{
                    left: `${scale(row.min)}%`,
                    right: `${100 - scale(row.max)}%`,
                  }}
                >
                  <div className="h-[2px] bg-gray-400" />
                </div>

                {/* box: Q1–Q3 */}
                <div
                  className="absolute inset-y-1"
                  style={{
                    left: `${scale(row.q1)}%`,
                    right: `${100 - scale(row.q3)}%`,
                  }}
                >
                  <div className="h-full bg-blue-200 rounded-md border border-blue-300" />
                </div>

                {/* median */}
                <div
                  className="absolute inset-y-[6px] w-[2px] bg-blue-700"
                  style={{ left: `${scale(row.median)}%` }}
                />
              </div>

              {/* mediane waarde */}
              <div className="w-14 text-xs text-right text-gray-700">
                {row.median.toFixed(2)}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};




/* ------------------ Tabellen ------------------ */
const HeadToHeadTable = React.memo(function HeadToHeadTable({
  teamName,
  teamsStats,
  h2h,
  last5Map,
}) {
  const rows = useMemo(() => {
  const r = (teamsStats || [])
    .filter((ts) => ALLOWED_TEAMS.includes(ts.Team))
    .map((ts) => ({
      Team: ts.Team,
      Played: ts.Played ?? ts.Matches ?? 0, // fallback als kolom anders heet
      W: ts.W ?? 0,
      G: ts.G ?? 0,
      V: ts.V ?? 0,
      GF: ts.GF ?? 0,
      GA: ts.GA ?? 0,
      GD: ts.GD ?? 0,
      Points: ts.Points ?? 0,
    }))
    .sort((a, b) => (b.Points - a.Points) || (b.GD - a.GD) || a.Team.localeCompare(b.Team));
  return r;
}, [teamsStats]);


  const my = h2h?.[teamName] || {};
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-lg font-semibold">League ladder</h3>
        <span className="text-xs text-gray-500">Thuis / Uit — datum of uitslag</span>
      </div>
      <div className="overflow-x-auto">
        <table className="table-auto text-sm h2h-table border-collapse table-fixed w-full">
  <colgroup>
    <col className="w-10" />       {/* # */}
    <col className="w-48" />       {/* Team */}
    <col className="w-12" />       {/* Pld */}
    <col className="w-10" />       {/* W */}
    <col className="w-10" />       {/* D */}
    <col className="w-10" />       {/* L */}
    <col className="w-12" />       {/* GF */}
    <col className="w-12" />       {/* GA */}
    <col className="w-12" />       {/* +/- */}
    <col className="w-14" />       {/* Pts */}
    <col className="w-28" />       {/* Last 5 (5 bolletjes) */}
    <col className="w-24" />       {/* Thuis */}
    <col className="w-24" />       {/* Uit */}
  </colgroup>

          <thead className="bg-gray-50 text-gray-500">
  <tr>
    <th className="px-3 py-2 text-left w-10">#</th>
    <th className="!text-left px-3 py-2 whitespace-nowrap">Team</th>
    <th className="px-3 py-2 text-center whitespace-nowrap">Pld</th>
    <th className="px-3 py-2 text-center whitespace-nowrap">W</th>
    <th className="px-3 py-2 text-center whitespace-nowrap">D</th>
    <th className="px-3 py-2 text-center whitespace-nowrap">L</th>
    <th className="px-3 py-2 text-center whitespace-nowrap">GF</th>
    <th className="px-3 py-2 text-center whitespace-nowrap">GA</th>
    <th className="px-3 py-2 text-center whitespace-nowrap">+/-</th>
    <th className="px-3 py-2 text-center whitespace-nowrap">Pts</th>
    <th className="px-3 py-2 text-center whitespace-nowrap">Last 5</th>
    <th className="px-3 py-2 text-center whitespace-nowrap w-0">Thuis</th>
    <th className="px-3 py-2 text-center whitespace-nowrap w-0">Uit</th>
  </tr>
</thead>

          <tbody>
            {rows.map((r, i) => {
  const h = my?.[r.Team]?.home || { text: null, res: null };
  const a = my?.[r.Team]?.away || { text: null, res: null };
  const self = r.Team === teamName;
  const last5 = last5Map?.[r.Team] || [];

  return (
    <tr key={r.Team} className={self ? "bg-amber-50" : "hover:bg-gray-50"}>
      <td className="px-3 py-2 text-left">{i + 1}</td>
      <td className="px-3 py-2 !text-left font-medium whitespace-nowrap">
        {r.Team}
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        {fmt(r.Played)}
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        {fmt(r.W)}
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        {fmt(r.G)}
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        {fmt(r.V)}
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        {fmt(r.GF)}
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        {fmt(r.GA)}
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        {fmt(r.GD)}
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        {fmt(r.Points)}
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        <Last5Strip seq={last5} />
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        <ResultBadge value={h.text} res={h.res} />
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        <ResultBadge value={a.text} res={a.res} />
      </td>
    </tr>
  );
})}

          </tbody>
        </table>
      </div>
    </div>
  );
});

const HomeAwayBars = ({ data }) => {
  const home = data?.home || {};
  const away = data?.away || {};

  const rows = [
    { name: "Matchen",  Home: home.matches ?? 0, Uit: away.matches ?? 0 },
    { name: "Winst",    Home: home.W ?? 0,       Uit: away.W ?? 0 },
    { name: "Gelijk",   Home: home.G ?? 0,       Uit: away.G ?? 0 },
    { name: "Verlies",  Home: home.V ?? 0,       Uit: away.V ?? 0 },
    { name: "Punten",   Home: home.points ?? 0,  Uit: away.points ?? 0 },
    { name: "Goals +",  Home: home.GF ?? 0,      Uit: away.GF ?? 0 },
    { name: "Goals -",  Home: home.GA ?? 0,      Uit: away.GA ?? 0 },
  ];

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-lg font-semibold">Thuis vs Uit</h3>
      </div>
      <div className="h-72 px-2 py-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 28 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" interval={0} angle={-25} textAnchor="end" height={40} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="Home" name="Thuis" fill="#3b82f6" radius={[4,4,0,0]} />
<Bar dataKey="Uit"  name="Uit"   fill="#080007ff" radius={[4,4,0,0]} />

          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};


const HomeAwayBlock = React.memo(function HomeAwayBlock({ data }) {
  const home = data?.home || {}, away = data?.away || {};
  const Row = ({label,h,a}) => (
    <tr>
      <td className="px-3 py-2 text-left whitespace-nowrap">{label}</td>
      <td className={`px-3 py-2 text-center whitespace-nowrap w-0 font-semibold ${h > a ? "bg-amber-50 rounded-md" : ""}`}>{fmt(h)}</td>
      <td className={`px-3 py-2 text-center whitespace-nowrap w-0 font-semibold ${a > h ? "bg-amber-50 rounded-md" : ""}`}>{fmt(a)}</td>
    </tr>
  );
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100"><h3 className="text-lg font-semibold">Thuis vs Uit</h3></div>
      <div className="overflow-x-auto">
        <table className="table-auto text-sm homeaway-table table-fixed w-full">
  <colgroup>
    <col className="w-40" />  {/* labels */}
    <col className="w-20" />  {/* Thuis */}
    <col className="w-20" />  {/* Uit */}
  </colgroup>

          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="text-left px-3 py-2 whitespace-nowrap"></th>
              <th className="px-3 py-2 text-center whitespace-nowrap w-0">Thuis</th>
              <th className="px-3 py-2 text-center whitespace-nowrap w-0">Uit</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Matchen" h={home.matches} a={away.matches} />
            <Row label="Winst"   h={home.W} a={away.W} />
            <Row label="Gelijk"  h={home.G} a={away.G} />
            <Row label="Verlies" h={home.V} a={away.V} />
            <Row label="Punten"  h={home.points} a={away.points} />
            <tr><td colSpan={3}><div className="h-px bg-gray-100 my-2" /></td></tr>
            <Row label="Goals +" h={home.GF} a={away.GF} />
            <Row label="Goals -" h={home.GA} a={away.GA} />
          </tbody>
        </table>
      </div>
    </div>
  );
});

function LeagueTimingScatter({ data, selectedTeam }) {
  if (!data?.length) {
    return (
      <div className="rounded-2xl p-4 bg-white shadow-sm ring-1 ring-black/5">
        <div className="text-sm text-gray-500">Geen timing-data beschikbaar.</div>
      </div>
    );
  }

  const main = data.filter((d) => !d.isSelected);
  const selected = data.filter((d) => d.isSelected);

  // Alle punten met geldige waarden
  const valid = data.filter(
    (d) => Number.isFinite(d.avgFor) && Number.isFinite(d.avgAgainst)
  );

  const medianX = median(valid.map((d) => d.avgFor)); // mediane goalminute voor
  const medianY = median(valid.map((d) => d.avgAgainst)); // mediane tegengoalminute

  // Dynamische assen (met beetje marge, maar begrensd tussen 0 en 95)
  let minX = 0,
    maxX = 95,
    minY = 0,
    maxY = 95;

  if (valid.length) {
    const xs = valid.map((d) => d.avgFor);
    const ys = valid.map((d) => d.avgAgainst);

    const rawMinX = Math.min(...xs);
    const rawMaxX = Math.max(...xs);
    const rawMinY = Math.min(...ys);
    const rawMaxY = Math.max(...ys);

    const pad = 5; // marge in minuten

    minX = Math.max(0, Math.floor(rawMinX - pad));
    maxX = Math.min(95, Math.ceil(rawMaxX + pad));
    minY = Math.max(0, Math.floor(rawMinY - pad));
    maxY = Math.min(95, Math.ceil(rawMaxY + pad));
  }

  // Custom tooltip — toont teamnaam + gemiddelde & mediaan, afgerond
  const renderTooltip = ({ active, payload }) => {
    if (!active || !payload || !payload.length) return null;

    // Als er zowel ster + bol overlappen, pak dan de ster (isSelected)
    const item =
      payload.find((p) => p?.payload?.isSelected) ?? payload[0];

    const d = item?.payload;
    if (!d) return null;

    const roundMin = (v) =>
      v == null || !Number.isFinite(v) ? "—" : `${Math.round(v)}'`;

    return (
      <div className="bg-white text-xs shadow-md border border-gray-200 rounded-lg px-3 py-2">
        <div className="font-semibold mb-1">{d.team}</div>
        <div>Gem. goals voor: <strong>{roundMin(d.avgFor)}</strong></div>
        <div>Mediaan goals voor: <strong>{roundMin(d.medianFor)}</strong></div>
        <div>Gem. goals tegen: <strong>{roundMin(d.avgAgainst)}</strong></div>
        <div>Mediaan goals tegen: <strong>{roundMin(d.medianAgainst)}</strong></div>
      </div>
    );
  };

  return (
    <div className="rounded-2xl p-4 bg-white shadow-sm ring-1 ring-black/5">
      <h3 className="text-lg font-semibold mb-2">
        Gem. goalminute vs tegengoalminute (league)
      </h3>
      <p className="text-xs text-gray-600 mb-3">
        X-as = gemiddelde minuut van eigen goals, Y-as = gemiddelde minuut van
        tegengoals.
      </p>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart
            margin={{ top: 10, right: 20, left: 50, bottom: 40 }} // meer marge links & onderaan
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="avgFor"
              name="Goals voor"
              unit="'"
              label={{
                value: "Goals voor",
                position: "bottom",
                offset: 0,
              }}
              domain={[minX, maxX]}
            />
            <YAxis
              type="number"
              dataKey="avgAgainst"
              name="Goals tegen"
              unit="'"
              label={{
                value: "Goals tegen",
                angle: -90,
                position: "insideLeft",
                offset: 10,
              }}
              domain={[minY, maxY]}
            />

            {/* kwadranten via mediaan-lijnen — duidelijkere lijn, geen tekstlabel */}
            {Number.isFinite(medianX) && (
              <ReferenceLine
                x={medianX}
                stroke="#4b5563"
                strokeWidth={1.5}
                strokeDasharray="6 4"
              />
            )}
            {Number.isFinite(medianY) && (
              <ReferenceLine
                y={medianY}
                stroke="#4b5563"
                strokeWidth={1.5}
                strokeDasharray="6 4"
              />
            )}

            <Tooltip cursor={{ strokeDasharray: "3 3" }} content={renderTooltip} />

            {/* Alle andere teams */}
            <Scatter
              name="Andere teams"
              data={main}
              fill="#9ca3af"
              shape="circle"
            />

            {/* Geselecteerd team (sterretje) */}
            {selected.length > 0 && (
              <Scatter
                name={selectedTeam}
                data={selected}
                fill="#111827"
                shape="star"
              />
            )}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-gray-400 mt-2">
        Verticale lijn = league-mediaan van goalminute; horizontale lijn =
        league-mediaan van tegengoalminute. Zo ontstaan 4 kwadranten
        (vroeg/laat scoren vs vroeg/laat tegengoals).
      </p>
    </div>
  );
}





function HeatmapLegendBar() {
  return (
    <div className="px-4 py-2 border-t border-gray-200 bg-gray-50 text-[11px] text-gray-700">
      
      {/* Titel + extra uitleg */}
      
      <div className="mb-2 text-gray-600">
        Kleurenlegende toont de <strong>afwijking t.o.v. het competitiegemiddelde (L) </strong>
        via z-scores (standaardafwijkingen).
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">

        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-gray-50 border"></div>
          <span>|z| &lt; 0.5 — normaal</span>
        </div>

        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-green-100 border"></div>
          <span>0.5–1σ boven gemiddelde</span>
        </div>

        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-green-200 border"></div>
          <span>1–2σ boven gemiddelde</span>
        </div>

        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-green-300 border"></div>
          <span>&gt; 2σ boven gemiddelde</span>
        </div>

        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-red-100 border"></div>
          <span>0.5–1σ onder gemiddelde</span>
        </div>

        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-red-200 border"></div>
          <span>1–2σ onder gemiddelde</span>
        </div>

        <div className="flex items-center gap-1">
          <div className="w-4 h-3 rounded bg-red-300 border"></div>
          <span>&gt; 2σ onder gemiddelde</span>
        </div>
      </div>
    </div>
  );
}


const HeatCell = React.memo(function HeatCell({
  pct,
  count,
  leaguePct,
  leagueCount,
  stdPct,
}) {
  const hasTeam =
    pct !== null && pct !== undefined && !Number.isNaN(pct);
  const hasLeague =
    leaguePct !== null && leaguePct !== undefined && !Number.isNaN(leaguePct);
  const hasStd =
    stdPct !== null && stdPct !== undefined && stdPct > 0;

  const pTeam = hasTeam ? Number(pct) : 0;
  const pLeague = hasLeague ? Number(leaguePct) : 0;
  const pStd = hasStd ? Number(stdPct) : 0;

  const z =
    hasTeam && hasLeague && hasStd ? (pTeam - pLeague) / pStd : null;
  const absZ = z !== null ? Math.abs(z) : null;

  // ───────────────
  // Kleuren (z-score)
  // ───────────────
  let tone = "bg-gray-200";
  if (z !== null) {
    if (absZ < 0.5) {
      tone = "bg-gray-50";
    } else if (absZ < 1.0) {
      tone = z > 0 ? "bg-green-100" : "bg-red-100";
    } else if (absZ < 2.0) {
      tone = z > 0 ? "bg-green-200" : "bg-red-200";
    } else {
      tone = z > 0 ? "bg-green-300" : "bg-red-300";
    }
  }

  // ───────────────
  // Randen: >1σ en >2σ
  // ───────────────
  let borderClass = "";
  if (absZ !== null) {
    if (absZ >= 2) {
      borderClass = "ring-2 ring-black/90";      // dikke ring voor extreme outliers
    } else if (absZ >= 1) {
      borderClass = "ring-1 ring-black/40";      // subtiele ring voor matige afwijking
    }
  }

  const displayTeam = hasTeam ? `${Math.round(pTeam)}% (${count ?? 0})` : "—";
  const displayLeague = hasLeague
    ? `${Math.round(pLeague)}% (${leagueCount ?? 0})`
    : null;

  return (
    <div
      className={
        `rounded-xl px-3 py-2 text-center ${tone} ${borderClass}`
      }
    >
      <div className="text-sm font-semibold">{displayTeam}</div>

      {displayLeague && (
        <div className="mt-1 text-[10px] leading-tight text-gray-600">
          L: {displayLeague}
        </div>
      )}
    </div>
  );
});





const EventHeatmap = React.memo(function EventHeatmap({ rec }) {
  if (!rec) return null;

  const row = (label, key) => {
    const bins = rec?.bins?.[key] || {};
    const stat = rec?.leagueStats?.[key] || {};
    const leagueBins = rec?.leagueBins?.[key] || {};

    return (
      <tr>
        <th className="text-left px-3 py-3 align-top">
          <div className="font-medium">{label}</div>
          <div className="text-xs text-gray-500">
            totaal: {fmt(rec?.totals?.[key])}
          </div>
        </th>
        {BINS.map((bin) => (
          <td key={bin} className="px-2 py-2">
            <HeatCell
              pct={bins?.[bin]?.pct}
              count={bins?.[bin]?.count}
              leaguePct={leagueBins?.[bin]?.pct}
              leagueCount={leagueBins?.[bin]?.count}
              stdPct={leagueBins?.[bin]?.stdPct}
            />
          </td>
        ))}
        <td className="px-3 py-2 text-center">{fmt(stat.min)}</td>
        <td className="px-3 py-2 text-center">{fmt(stat.avg)}</td>
        <td className="px-3 py-2 text-center">{fmt(stat.max)}</td>
        <td className="px-3 py-2 text-center">{fmt(stat.rank)}</td>
      </tr>
    );
  };

  return (
  <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">

    {/* HEADER */}
    <div className="px-4 py-3 border-b border-gray-100">
      <h3 className="text-lg font-semibold">Momentverdeling</h3>
    </div>

    {/* TABEL */}
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="text-left px-3 py-2"> </th>
            {BINS.map((b) => (
              <th key={b} className="text-center px-2 py-2">{b}</th>
            ))}
            <th className="text-center px-3 py-2">MIN</th>
            <th className="text-center px-3 py-2">GEM</th>
            <th className="text-center px-3 py-2">MAX</th>
            <th className="text-center px-3 py-2">RANK</th>
          </tr>
        </thead>
        <tbody>
          {row("Goals +", "goalsFor")}
          {row("Goals -", "goalsAgainst")}
          {row("Gele kaarten", "yellowFor")}
          {row("Geel tegenst.", "yellowAgainst")}
        </tbody>
      </table>
    </div>

    {/* LEGENDE-BALK */}
    <HeatmapLegendBar />

  </div>
);

});

function FirstScorerCard({ teamName, rec }) {
  if (!rec) return null;

  const m = rec.matches || 0;
  const sf = rec.scoredFirst || {};
  const cf = rec.concededFirst || {};

  const sfTot = sf.total || { count: 0, pctOfMatches: 0 };
  const sfFH  = sf.firstHalf || { count: 0, pctOfMatches: 0 };
  const sfSH  = sf.secondHalf || { count: 0, pctOfMatches: 0 };

  const cfTot = cf.total || { count: 0, pctOfMatches: 0 };
  const cfFH  = cf.firstHalf || { count: 0, pctOfMatches: 0 };
  const cfSH  = cf.secondHalf || { count: 0, pctOfMatches: 0 };

  const donutData = [
    { name: `${teamName} scoort eerst`, value: sfTot.count || 0 },
    { name: "Tegenstander scoort eerst", value: cfTot.count || 0 },
  ];


  const rSF = rec.resultsWhenScoredFirst || {};
  const rCF = rec.resultsWhenConcededFirst || {};

  const rSF_overall = rSF.overall || null;
  const rCF_overall = rCF.overall || null;

  // data voor horizontale stacked bar (in %)
  const barData = [
  {
    scenario: `${teamName} scoort eerst`,
    total: rSF_overall?.count ?? 0,
    W: rSF_overall?.pctW ?? 0,
    D: rSF_overall?.pctD ?? 0,
    L: rSF_overall?.pctL ?? 0,
    Wn: rSF_overall?.W ?? 0,
    Dn: rSF_overall?.D ?? 0,
    Ln: rSF_overall?.L ?? 0,
  },
  {
    scenario: `Tegenstander scoort eerst`,
    total: rCF_overall?.count ?? 0,
    W: rCF_overall?.pctW ?? 0,
    D: rCF_overall?.pctD ?? 0,
    L: rCF_overall?.pctL ?? 0,
    Wn: rCF_overall?.W ?? 0,
    Dn: rCF_overall?.D ?? 0,
    Ln: rCF_overall?.L ?? 0,
  },
];



  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-lg font-semibold">First scorer & impact op resultaat</h3>
        <p className="mt-1 text-xs text-gray-600">
          Gebaseerd op {m} wedstrijden. First scorer = ploeg die het eerste doelpunt maakt.
        </p>
      </div>

      <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
  
  {/* Linker tekst */}
  <div>
    <h4 className="font-medium mb-1">{teamName} scoort eerst</h4>
    <p className="text-xs text-gray-700">
      In <strong>{sfTot.count}</strong> van de <strong>{m}</strong> wedstrijden (
      <strong>{sfTot.pctOfMatches?.toFixed?.(1) ?? sfTot.pctOfMatches}%</strong>) scoort {teamName} als eerste.
    </p>
    <p className="mt-1 text-xs text-gray-600">
      1e helft: {sfFH.count}x ({sfFH.pctOfMatches?.toFixed?.(1) ?? sfFH.pctOfMatches}%)
      {" · "}
      2e helft: {sfSH.count}x ({sfSH.pctOfMatches?.toFixed?.(1) ?? sfSH.pctOfMatches}%)
    </p>
  </div>

  {/* Midden: donut chart */}
  <div className="flex items-center justify-center">
    <div className="w-40 h-40">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={donutData}
            dataKey="value"
            nameKey="name"
            innerRadius="60%"
            outerRadius="100%"
            paddingAngle={3}
            startAngle={90}
            endAngle={450}
          >
            <Cell fill="#22c55e" />
            <Cell fill="#ef4444" />
          </Pie>
          <Tooltip formatter={(v, n) => [`${v}x`, n]} />
          
        </PieChart>
      </ResponsiveContainer>
    </div>
  </div>

  {/* Rechter tekst */}
  <div>
    <h4 className="font-medium mb-1">Tegenstander scoort eerst</h4>
    <p className="text-xs text-gray-700">
      In <strong>{cfTot.count}</strong> van de <strong>{m}</strong> wedstrijden (
      <strong>{cfTot.pctOfMatches?.toFixed?.(1) ?? cfTot.pctOfMatches}%</strong>) scoort de tegenstander eerst.
    </p>
    <p className="mt-1 text-xs text-gray-600">
      1e helft: {cfFH.count}x ({cfFH.pctOfMatches?.toFixed?.(1) ?? cfFH.pctOfMatches}%)
      {" · "}
      2e helft: {cfSH.count}x ({cfSH.pctOfMatches?.toFixed?.(1) ?? cfSH.pctOfMatches}%)
    </p>
  </div>

</div>


      <div className="px-4 pb-4">
        <h4 className="font-medium mb-2 text-sm">Eindresultaat per scenario</h4>
        <div style={{ width: "100%", height: 140 }}>
          <ResponsiveContainer>
            <BarChart
  data={barData}
  layout="vertical"
  margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
>
  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
  <XAxis type="number" domain={[0, 100]} hide />
  <YAxis type="category" dataKey="scenario" width={160} />
  {/* W / D / L stacked op elkaar, in % */}
  <Bar dataKey="L" stackId="a" name="Verlies" fill="#ef4444">
    <LabelList
      dataKey="Ln"
      position="center"
      formatter={(v) => (v > 0 ? v : "")}
      className="text-[12px] fill-black font-semibold"
    />
  </Bar>  {/* rood */}
  <Bar dataKey="D" stackId="a" name="Gelijk" fill="#9ca3af">
    <LabelList
      dataKey="Dn"
      position="center"
      formatter={(v) => (v > 0 ? v : "")} // toon niets bij 0
      className="text-[12px] fill-black font-semibold"
    />
  </Bar>   {/* grijs */}
  <Bar dataKey="W" stackId="a" name="Winst" fill="#22c55e">
    <LabelList
      dataKey="Wn"
      position="center"
      formatter={(v) => (v > 0 ? v : "")}
      className="text-[12px] fill-black font-semibold"
    />
  </Bar>    {/* groen */}
  <Tooltip
  formatter={(value, _name, props) => {
    const payload = props?.payload || {};
    const dataKey = props?.dataKey;

    let count = 0;
    if (dataKey === "W") count = payload.Wn ?? 0;
    if (dataKey === "D") count = payload.Dn ?? 0;
    if (dataKey === "L") count = payload.Ln ?? 0;

    const pct =
      typeof value === "number" ? value.toFixed(1) : (value ?? 0);

    return `${count} (${pct}%)`;
  }}
/>


  <Legend />

</BarChart>

          </ResponsiveContainer>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          Balken tonen verdeling van W / G / V (in %) gegeven het scenario
          wie eerst scoort.
        </p>
      </div>
    </div>
  );
}

function HalftimeFulltimeCard({ teamName, rec }) {
  if (!rec) return null;

  const totalMatches = rec.matches || 0;
  const scenarios = rec.scenarios || {};

  const order = [
    { key: "W-W", label: "W → W" },
    { key: "W-D", label: "W → G" },
    { key: "W-L", label: "W → V" },
    { key: "D-W", label: "G → W" },
    { key: "D-D", label: "G → G" },
    { key: "D-L", label: "G → V" },
    { key: "L-W", label: "V → W" },
    { key: "L-D", label: "V → G" },
    { key: "L-L", label: "V → V" },
  ];

  const data = order.map((s) => {
    const obj = scenarios[s.key] || { count: 0, pctOfMatches: 0 };
    return {
      key: s.key,
      label: s.label,
      count: obj.count || 0,
      pct: obj.pctOfMatches || 0,
    };
  });

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-lg font-semibold">Rust–eindstand scenario&apos;s</h3>
        <p className="mt-1 text-xs text-gray-600">
          Hoe vaak komt elk scenario voor voor <strong>{teamName}</strong>? Rust = stand na 45&apos;,
          eindstand = score na 90&apos;.
        </p>
      </div>

      <div className="px-4 py-3">
        <p className="text-xs text-gray-700 mb-2">
          Gebaseerd op {totalMatches} wedstrijden. Balkhoogte = aantal keer, label = aantal (met % t.o.v. alle
          wedstrijden).
        </p>

        <div style={{ width: "100%", height: 260 }}>
          <ResponsiveContainer>
            <BarChart
              data={data}
              margin={{ top: 10, right: 20, left: 0, bottom: 40 }}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <ReferenceArea
  x1="W → W"
  x2="W → V"
  fill="#22c55e"
  fillOpacity={0.1}
/>

<ReferenceArea
  x1="G → W"
  x2="G → V"
  fill="#9ca3af"
  fillOpacity={0.1}
/>

<ReferenceArea
  x1="V → W"
  x2="V → V"
  fill="#ef4444"
  fillOpacity={0.1}
/>

              <XAxis
                dataKey="label"
                angle={-35}
                textAnchor="end"
                interval={0}
                height={60}
              />
              <YAxis allowDecimals={false} />
              <Tooltip
  formatter={(value, _name, props) => {
    const payload = props?.payload || {};
    const cnt = payload.count ?? 0;
    const pct = payload.pct ?? 0;
    return `${cnt} (${Number(pct).toFixed(1)}%)`;
  }}
/>

              <Bar dataKey="count">
  {data.map((d, idx) => {
    const end = d.key.split("-")[1]; // W, G, of L
    const color =
      end === "W" ? "#22c55e" :
      end === "D" ? "#9ca3af" :
      "#ef4444";

    return <Cell key={idx} fill={color} />;
  })}

  <LabelList
    dataKey="count"
    position="top"
    formatter={(v) => (v > 0 ? `${v}` : "")}
    className="text-[12px] fill-black font-semibold"
  />
</Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="px-1 pb-1 pt-1 text-[11px] text-gray-500">
          Voorbeeld: &quot;Rust W → Einde V&quot; = ploeg staat voor aan de rust maar verliest uiteindelijk.
        </div>
      </div>
    </div>
  );
}


function PlayerStatsTable({ rows }) {
  const [sortKey, setSortKey] = useState("Speelminuten");
  const [sortDir, setSortDir] = useState("desc");
  const cols = useMemo(()=>[
    { key:"Speler", label:"Speler", align:"left" },
    { key:"Type", label:"Type", align:"left" },
    { key:"Selecties", label:"Selec." },{ key:"Gestart", label:"Gestart" },
    { key:"Ingevallen", label:"Inv." },{ key:"Vervangen", label:"Verv." },
    { key:"Speelminuten", label:"Min." },{ key:"Goals", label:"Goals" },
    { key:"Penalties", label:"Pen" },{ key:"Own Goals", label:"OG" },
    { key:"Geel", label:"Geel" },{ key:"Dubbelgeel", label:"DblG" },
    { key:"Rood", label:"Rood" },{ key:"Clean sheets", label:"CleanS" },
    { key:"Kapitein", label:"Capt" },
  ],[]);
  const sorted = useMemo(()=>{
    const arr = rows||[];
    return [...arr].sort((a,b)=>{
      const va=a[sortKey]??0, vb=b[sortKey]??0;
      return (typeof va==="string")
        ? (sortDir==="asc" ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va)))
        : (sortDir==="asc" ? va - vb : vb - va);
    });
  },[rows,sortKey,sortDir]);
  
  const onSort = (k) => {
    if (sortKey === k) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  if (!rows?.length) return null;
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Spelerstatistieken — alle wedstrijden</h3>
        <span className="text-xs text-gray-500">Klik op kolomkop om te sorteren</span>
      </div>
      <div className="ps-scroll">
        <table className="player-stats-table">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              {cols.map(c=>(
                <th key={c.key}
                    onClick={()=>onSort(c.key)}
                    className={`px-3 py-2 cursor-pointer select-none ${c.align==="left"?"text-left":"text-right"}`}>
                  {c.label} {sortKey===c.key?(sortDir==="asc"?"▲":"▼"):""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r,i)=>(
              <tr key={r.Speler+"_"+i} className="hover:bg-gray-50">
                {cols.map(c=>(
                  <td key={c.key}
                      className={`px-3 py-2 ${c.align==="left"?"text-left":"text-right"} ${c.key==="Speler"?"font-medium":""}`}>
                    {r[c.key] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlayerStatsTableLast5({ rows }) {
  const [sortKey, setSortKey] = useState("Min_L5");
  const [sortDir, setSortDir] = useState("desc");

  const cols = useMemo(()=>[
    { key:"Speler",       label:"Speler",   align:"left" },
    { key:"Type",         label:"Type",     align:"left" },
    { key:"Selecties_L5", label:"Selec." },
    { key:"Gestart_L5",   label:"Gest." },
    { key:"Ingevallen_L5",label:"Inv." },
    { key:"Vervangen_L5", label:"Verv." },
    { key:"Min_L5",       label:"Min." },
    { key:"Goals_L5",     label:"Goals" },
    { key:"Pens_L5",      label:"Pen" },
    { key:"OG_L5",        label:"OG" },
    { key:"Geel_L5",      label:"Geel" },
    { key:"DblG_L5",      label:"DblG" },
    { key:"Rood_L5",      label:"Rood" },
    { key:"CS_L5",        label:"CleanS" },
    { key:"Kapitein_L5",  label:"Capt" },
  ],[]);

  const sorted = useMemo(()=>{
    const arr = rows||[];
    return [...arr].sort((a,b)=>{
      const va=a[sortKey]??0, vb=b[sortKey]??0;
      return (sortDir==="asc") ? (va - vb) : (vb - va);
    });
  },[rows,sortKey,sortDir]);

  const onSort = (k) => {
    if (sortKey === k) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  if (!rows?.length) return null;

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Spelerstatistieken — laatste 5 wedstrijden</h3>
        <span className="text-xs text-gray-500">Klik op kolomkop om te sorteren</span>
      </div>
      <div className="ps-scroll">
        <table className="player-stats-table">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              {cols.map(c=>(
                <th key={c.key}
                    onClick={()=>onSort(c.key)}
                    className={`px-3 py-2 cursor-pointer select-none ${c.align==="left"?"text-left":"text-right"}`}>
                  {c.label} {sortKey===c.key?(sortDir==="asc"?"▲":"▼"):""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r,i)=>(
              <tr key={r.Speler+"_l5_"+i} className="hover:bg-gray-50">
                {cols.map(c=>(
                  <td key={c.key}
                      className={`px-3 py-2 ${c.align==="left"?"text-left":"text-right"} ${c.key==="Speler"?"font-medium":""}`}>
                    {r[c.key] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlayerRapmTable({ rows, minMinutes }) {
  const [sortKey, setSortKey] = React.useState("rapm");
  const [sortDir, setSortDir] = React.useState("desc");

  const toNum = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().replace(",", ".");
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : null;
  };

  // Verrijk spelers + sortering
  const memo = React.useMemo(() => {
    const enriched = (rows || []).map((r) => {
      const rapm    = toNum(r.RAPM_per90);
      const rapmSe  = toNum(r.RAPM_SE_per90 ?? r.RAPM_SE);
      const rapmZ   = toNum(r.RAPM_z);

      const xppm    = toNum(r["xPPM_per90"] ?? r["XPPM_per90"]);
      const xppmSe  = toNum(r["xPPM_SE"] ?? r["xPPM_SE_per90"] ?? r["XPPM_SE"]);
      const xppmZ   = toNum(r["xPPM_z"] ?? r["XPPM_z"]);

      const mins    = toNum(r.Speelminuten ?? r.Minutes);

      return {
        raw: r,
        name: r.Speler,
        type: r.Type,
        mins,
        rapm,
        rapmSe,
        rapmZ,
        xppm,
        xppmSe,
        xppmZ,
      };
    })
    // alleen spelers met minstens één van de twee metrics
    .filter((p) => p.rapm !== null || p.xppm !== null);

    const sorted = [...enriched].sort((a, b) => {
      const getVal = (obj) => {
        switch (sortKey) {
          case "name":   return obj.name || "";
          case "mins":   return obj.mins ?? -1;
          case "rapm":   return obj.rapm ?? 0;
          case "rapmSe": return obj.rapmSe ?? 0;
          case "rapmZ":  return obj.rapmZ ?? 0;
          case "xppm":   return obj.xppm ?? 0;
          case "xppmSe": return obj.xppmSe ?? 0;
          case "xppmZ":  return obj.xppmZ ?? 0;
          default:       return obj.rapm ?? 0;
        }
      };

      const va = getVal(a);
      const vb = getVal(b);

      if (typeof va === "string" || typeof vb === "string") {
        const cmp = String(va).localeCompare(String(vb));
        return sortDir === "asc" ? cmp : -cmp;
      }
      const diff = (va ?? 0) - (vb ?? 0);
      return sortDir === "asc" ? diff : -diff;
    });

    return { enriched, sorted };
  }, [rows, sortKey, sortDir]);

  const { enriched, sorted } = memo;
  if (!enriched.length) return null;

  const onSort = (k) => {
    if (sortKey === k) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      // namen standaard oplopend, rest aflopend
      setSortDir(k === "name" ? "asc" : "desc");
    }
  };

  const sortArrow = (k) =>
    sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "";

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          Spelersimpact (RAPM & xPPM) + betrouwbaarheid
        </h3>
        <div className="text-xs text-gray-500">
          Min. minuten voor “stabiel”: {Math.round(minMinutes ?? 0)} min
        </div>
      </div>

      <div className="ps-scroll">
        <table className="player-stats-table text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th
                className="px-2 py-1 text-left cursor-pointer select-none"
                onClick={() => onSort("name")}
              >
                Speler {sortArrow("name")}
              </th>
              <th className="px-2 py-1 text-left">Type</th>
              <th
                className="px-2 py-1 text-right cursor-pointer select-none"
                onClick={() => onSort("mins")}
              >
                Min. {sortArrow("mins")}
              </th>

              <th
                className="px-2 py-1 text-right cursor-pointer select-none"
                onClick={() => onSort("rapm")}
              >
                RAPM / 90 {sortArrow("rapm")}
              </th>
              <th
                className="px-2 py-1 text-right cursor-pointer select-none"
                onClick={() => onSort("rapmSe")}
              >
                SE {sortArrow("rapmSe")}
              </th>
              <th
                className="px-2 py-1 text-right cursor-pointer select-none"
                onClick={() => onSort("rapmZ")}
              >
                z-score {sortArrow("rapmZ")}
              </th>

              <th
                className="px-2 py-1 text-right cursor-pointer select-none"
                onClick={() => onSort("xppm")}
              >
                xPPM / 90 {sortArrow("xppm")}
              </th>
              <th
                className="px-2 py-1 text-right cursor-pointer select-none"
                onClick={() => onSort("xppmSe")}
              >
                SE {sortArrow("xppmSe")}
              </th>
              <th
                className="px-2 py-1 text-right cursor-pointer select-none"
                onClick={() => onSort("xppmZ")}
              >
                z-score {sortArrow("xppmZ")}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, idx) => (
              <tr
                key={p.name + "_rapm_xppm_" + idx}
                className="hover:bg-gray-50"
              >
                <td className="px-2 py-1 text-left font-medium">
                  {p.name}
                </td>
                <td className="px-2 py-1 text-left text-xs text-gray-600">
                  {p.type}
                </td>
                <td className="px-2 py-1 text-right">
                  {p.mins !== null ? Math.round(p.mins) : "—"}
                </td>

                <td className="px-2 py-1 text-right">
                  {p.rapm !== null ? p.rapm.toFixed(2) : "—"}
                </td>
                <td className="px-2 py-1 text-right">
                  {p.rapmSe !== null ? p.rapmSe.toFixed(2) : "—"}
                </td>
                <td className="px-2 py-1 text-right">
                  {p.rapmZ !== null ? p.rapmZ.toFixed(2) : "—"}
                </td>

                <td className="px-2 py-1 text-right">
                  {p.xppm !== null ? p.xppm.toFixed(2) : "—"}
                </td>
                <td className="px-2 py-1 text-right">
                  {p.xppmSe !== null ? p.xppmSe.toFixed(2) : "—"}
                </td>
                <td className="px-2 py-1 text-right">
                  {p.xppmZ !== null ? p.xppmZ.toFixed(2) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-4 pb-2 pt-2 text-[11px] text-gray-500 space-y-1">
        <p>• RAPM = impact op doelpuntensaldo per 90 min.</p>
        <p>• xPPM = impact op expected points per 90 min (meer datapunten, vaak stabieler).</p>
        <p>• z-score ≈ aantal standaardafwijkingen verschil met 0 (|z| ≥ 2 = sterk signaal).</p>
        <p>• SE = standaardfout van de schatting (lager = betrouwbaarder).</p>
      </div>
    </div>
  );
}




function RapmSegmentsHeatmap({ data, team }) {
  const players = data?.players || [];
  const segments = data?.segments || [];

  if (!players.length || !segments.length) return null;

  // constante voor celbreedte in px
  const CELL_PX = 5;

  // unieke match-volgorde
  const matchOrder = [];
  segments.forEach((s) => {
    if (!matchOrder.includes(s.match)) matchOrder.push(s.match);
  });

  // index van eerste segment per match
  const firstIndexByMatch = new Map();
  segments.forEach((s, idx) => {
    if (!firstIndexByMatch.has(s.match)) {
      firstIndexByMatch.set(s.match, idx);
    }
  });

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Segment-impact (RAPM-context)</h3>
        <span className="text-xs text-gray-500">
          Groen = +, rood = -, grijs = 0, wit = niet op het veld
        </span>
      </div>

      <div className="px-4 pt-2 pb-1 text-xs text-gray-500">
        Segmenten over alle competitiewedstrijden van{" "}
        <span className="font-medium">{team}</span>. Elke blok = periode tussen
        events (goal/wissel/rode kaart). Bovenaan zie je het wedstrijdnummer.
      </div>

      <div className="px-4 pb-4 overflow-x-auto">
        <div className="inline-block">
          {/* HEADER: alleen “lege” cellen, nummers als overlay */}
          <div className="flex text-[9px] text-gray-500 mb-1">
            <div className="w-32" />
            <div className="flex relative">
              {/* lege cellen om breedte gelijk te houden */}
              {segments.map((_, idx) => (
                <div
                  key={idx}
                  style={{ width: CELL_PX, height: 12 }}
                />
              ))}

              {/* overlay met matchnummers op eerste segment van elke match */}
              {matchOrder.map((matchId, mIdx) => {
                const firstIdx = firstIndexByMatch.get(matchId);
                if (firstIdx == null) return null;
                return (
                  <div
                    key={matchId}
                    className="absolute top-0 text-[9px] leading-none"
                    style={{
                      left: firstIdx * CELL_PX,
                      transform: "translateX(0)", // netjes links boven de grens
                    }}
                  >
                    {mIdx + 1}
                  </div>
                );
              })}
            </div>
          </div>

          {/* BODY: rijen per speler, border-l bij start nieuwe match */}
          {players.map((p) => (
            <div
              key={p.name}
              className="flex items-center mb-[2px]"
            >
              <div className="w-32 pr-2 flex items-center gap-1 text-[11px] truncate">
                <span className="font-medium truncate">{p.name}</span>
                {typeof p.rapm_per90 === "number" && (
                  <span className="text-[10px] text-gray-400">
                    {p.rapm_per90.toFixed(2)}
                  </span>
                )}
              </div>

              <div className="flex">
                {segments.map((seg, idx) => {
                  const prev = idx > 0 ? segments[idx - 1] : null;
                  const isNewMatch = !prev || prev.match !== seg.match;
                  const isOn = (seg.players || []).includes(p.name);

                  // kleur per segment
                  let bg = "transparent";
                  if (isOn) {
                    if (seg.gd > 0) bg = "#10b981"; // emerald-500
                    else if (seg.gd < 0) bg = "#ef4444"; // red-500
                    else bg = "#d1d5db"; // gray-300
                  }

                  const matchIdx = matchOrder.indexOf(seg.match) + 1;
                  const datePart = seg.date ? ` – ${seg.date}` : "";
                  const homeAway = seg.isHome ? "thuis" : "uit";
                  const opp = seg.opp || "onbekende tegenstander";
                  const title = `Match ${matchIdx}${datePart} (${homeAway} vs ${opp})`;

                  return (
                    <div
                      key={idx}
                      title={title}
                      style={{
                        width: CELL_PX,
                        height: 12,
                        backgroundColor: bg,
                        borderLeft: isNewMatch ? "1px solid #9ca3af" : "none", // gray-400
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}



function PointsChart({ seriesCurrent, seriesPrev, showPrev }) {
  const data = useMemo(() => {
    const len = Math.max(seriesCurrent?.rounds?.length ?? 0, showPrev ? (seriesPrev?.rounds?.length ?? 0) : 0);
    const rows = [];
    for (let i = 0; i < len; i++) {
      rows.push({
        R: i + 1,
        cur: seriesCurrent?.cum?.[i] ?? null,
        prev: showPrev ? (seriesPrev?.cum?.[i] ?? null) : null,
      });
    }
    return rows;
  }, [seriesCurrent, seriesPrev, showPrev]);

  if (!data.length) return null;

  return (
    <div className="rounded-2xl p-4 bg-white shadow-sm ring-1 ring-black/5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">Punten evolutie</h3>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="R" />
            <YAxis allowDecimals={false} domain={[0, 'auto']} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="cur" name="Huidig seizoen" strokeWidth={2} dot={false} />
            {showPrev && 
              <Line
                type="monotone"
                dataKey="prev"
                name="Vorig seizoen"
                stroke="#6B7280"
                strokeDasharray="5 5"
                strokeWidth={2}
                dot={false}
              />
            }
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ===== Leaderboards helpers =====
function makeLeaderboards(rows = []) {
  const num = (v) => (Number.isFinite(+v) ? +v : 0);

  const mins   = [...rows].map(r => ({ Speler:r.Speler, Team:r.Team, val:num(r["Speelminuten"]) }));
  const gpp    = [...rows].map(r => ({ Speler:r.Speler, Team:r.Team, val:num(r["Goals"]) + num(r["Penalties"]) })); // Goals(+pens)
  const pens   = [...rows].map(r => ({ Speler:r.Speler, Team:r.Team, val:num(r["Penalties"]) }));
  const geel   = [...rows].map(r => ({ Speler:r.Speler, Team:r.Team, val:num(r["Geel"]) }));
  const dblg   = [...rows].map(r => ({ Speler:r.Speler, Team:r.Team, val:num(r["Dubbelgeel"]) }));
  const rood   = [...rows].map(r => ({ Speler:r.Speler, Team:r.Team, val:num(r["Rood"]) }));
  const cs     = [...rows].map(r => ({ Speler:r.Speler, Team:r.Team, val:num(r["Clean sheets"]) }));

  const top10 = (arr) =>
    arr.filter(x => x.val > 0)
       .sort((a,b)=> (b.val - a.val) || a.Speler.localeCompare(b.Speler))
       .slice(0,10);

  return {
    minutes:       top10(mins),
    goalsPlusPens: top10(gpp),
    pens:          top10(pens),
    yellow:        top10(geel),
    doubleYellow:  top10(dblg),
    red:           top10(rood),
    cleanSheets:   top10(cs),
  };
}

function Leaderboards({ data, selectedTeam }) {
  if (!data) return null;
  const Box = ({ title, items }) => (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-100">
        <h4 className="font-semibold">{title}</h4>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-3 py-2 text-left w-10">#</th>
              <th className="px-3 py-2 text-left">Speler</th>
              <th className="px-3 py-2 text-left">Team</th>
              <th className="px-3 py-2 text-right">Waarde</th>
            </tr>
          </thead>
          <tbody>
            {(items||[]).map((r,i)=>(
              <tr key={r.Speler+"_"+r.Team} className={r.Team === selectedTeam ? "bg-amber-50" : "hover:bg-gray-50"}>
                <td className="px-3 py-2">{i+1}</td>
                <td className="px-3 py-2">{r.Speler}</td>
                <td className="px-3 py-2">{r.Team}</td>
                <td className="px-3 py-2 text-right">{r.val}</td>
              </tr>
            ))}
            {!items?.length && (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-400">Geen data</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
      <Box title="Top 10 — Speelminuten"         items={data.minutes} />
      <Box title="Top 10 — Goals (+penalties)"   items={data.goalsPlusPens} />
      <Box title="Top 10 — Penalties"            items={data.pens} />
      <Box title="Top 10 — Geel"                  items={data.yellow} />
      <Box title="Top 10 — Dubbel geel"          items={data.doubleYellow} />
      <Box title="Top 10 — Rood"                 items={data.red} />
      <Box title="Top 10 — Clean sheets"         items={data.cleanSheets} />
    </div>
  );
}

function PlayersScatter({ data, metricLabel }) {
  if (!data?.length) {
    return (
      <div className="rounded-2xl p-4 bg-white shadow-sm ring-1 ring-black/5">
        <div className="text-sm text-gray-500">Geen data beschikbaar voor deze selectie.</div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl p-4 bg-white shadow-sm ring-1 ring-black/5">
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" dataKey="minutes" name="Minuten" />
            <YAxis type="number" dataKey="value" name={metricLabel} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload || !payload.length) return null;
                const d = payload[0].payload;
                return (
                  <div
                    style={{
                      background: 'white',
                      border: '1px solid rgba(0,0,0,0.1)',
                      borderRadius: 8,
                      padding: '8px 10px',
                      boxShadow: '0 4px 10px rgba(0,0,0,0.08)',
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.name}</div>
                    <div>{metricLabel}: {Number(d.value).toFixed(2)}</div>
                    <div>Minuten: {d.minutes}</div>
                  </div>
                );
              }}
            />
            <Scatter name="Spelers" data={data} fill="#111827" />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}


function EloChart({ data, showOpp }) {
  if (!data?.length) {
    return (
      <div className="rounded-2xl p-4 bg-white shadow-sm ring-1 ring-black/5">
        <div className="text-sm text-gray-500">Geen ELO-data beschikbaar.</div>
      </div>
    );
  }

  // Dot op kleur per resultaat, grootte lichtjes op basis van doelpuntenverschil
  const ResultDot = (props) => {
    const { cx, cy, payload } = props;
    const res = payload?.res;
    const gd  = Math.abs(payload?.gd || 0);
    const color = res === "W" ? "#16a34a" : res === "G" ? "#6b7280" : "#dc2626";
    const r = Math.min(8 + gd*1.5, 15);
    return <circle cx={cx} cy={cy} r={r/2} fill={color} stroke="white" strokeWidth={1} />;
  };


  return (
    <div className="rounded-2xl p-4 bg-white shadow-sm ring-1 ring-black/5">
      <h3 className="text-lg font-semibold mb-3">Vorm evolutie</h3>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="r" name="Speeldag" />
            <YAxis domain={['auto','auto']} />
            <Tooltip
              formatter={(val, key) => {
                if (key === "elo") return [Math.round(Number(val)), "ELO"];
                if (key === "opp") return [Math.round(Number(val)), "ELO tegenst."];
                return [val, key];
              }}
              labelFormatter={(label, items) => {
                const p = items?.[0]?.payload;
                const res = p?.res ? ` (${p.res})` : "";
                const diff = Number.isFinite(+p?.gd) ? ` | DG: ${p.gd}` : "";
                const oppLine = p?.oppName ? `\nvs ${p.oppName}` : "";
                return `Speeldag ${label}${res}${diff}${oppLine}`;
              }}
            />
            <Legend />
            {/* Eigen ELO */}
            <Line
              type="monotone"
              dataKey="elo"
              name="ELO"
              stroke="#0ea5e9"
              strokeWidth={2}
              dot={<ResultDot />}
              connectNulls
            />
            {/* Tegenstander-ELO (optioneel) */}
            {showOpp && (
              <Line
                type="monotone"
                dataKey="opp"
                name="ELO tegenstander"
                stroke="#111827"
                strokeDasharray="5 5"
                dot={{ r: 2 }}
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-gray-400 mt-2">
        Marker kleur = resultaat (groen winst, grijs gelijk, rood verlies). Grootte ~ doelpuntenverschil.
      </p>
    </div>
  );
}

/* ------------------ Main App ------------------ */
export default function App() {
  const [team, setTeam] = useState(DEFAULT_TEAM);
  const [teamStats, setTeamStats] = useState([]);
  const [h2h, setH2H] = useState(null);
  const [homeAway, setHomeAway] = useState(null);
  const [eventBins, setEventBins] = useState(null);
  const [playerStats, setPlayerStats] = useState(null);
  const [showPlayers, setShowPlayers] = useState(true);
  const [showKeepers, setShowKeepers] = useState(true);
  const [teamPoints, setTeamPoints] = useState(null);
  const [showPrevSeason, setShowPrevSeason] = useState(true);
  const [scatterMetric, setScatterMetric] = useState("RAPM_per90"); // default
  const [eloMap, setEloMap] = useState(null);
  const [showOppElo, setShowOppElo] = useState(true);
  const [firstScorer, setFirstScorer] = useState(null);
  const [htFt, setHtFt] = useState(null);
  const [rapmSegments, setRapmSegments] = useState(null);



  useEffect(() => {
    let alive = true;
    (async () => {
      const [
        ts, h, ha, eb, fs, hf, ps, tp, te, rs,
      ] = await Promise.all([
        fetch("data/team_stats.json").then(r => r.json()),
        fetch("data/h2h.json").then(r => r.json()),
        fetch("data/team_homeaway.json").then(r => r.json()),
        fetch("data/team_event_bins.json").then(r => r.json()),
        fetch("data/team_first_scorer.json").then(r => r.json()),
        fetch("data/team_halftime_fulltime.json").then(r => r.json()),
        fetch("data/player_stats.json").then(r => r.json()),
        fetch("data/team_points.json").then(r => r.json()),
        fetch("data/team_elo.json").then(r => r.json()),
        fetch("data/team_rapm_segments.json").then(r => r.json()),
      ]);

      if (!alive) return;
      setTeamStats(ts);
      setH2H(h);
      setHomeAway(ha);
      setEventBins(eb);
      setFirstScorer(fs);
      setHtFt(hf);
      setPlayerStats(ps);
      setTeamPoints(tp);
      setEloMap(te);
      setRapmSegments(rs);
    })();
    return () => { alive = false; };
  }, []);




  const teams = useMemo(()=> ALLOWED_TEAMS.slice().sort((a,b)=>a.localeCompare(b)), []);
  const myHomeAway = homeAway?.[team];
  const myEvent = eventBins?.[team];
  const myFirstScorer = firstScorer?.[team];
  const myHtFt = htFt?.[team];
  const myPlayers = playerStats?.[team] ?? [];
  const myRapmSegments = rapmSegments?.[team] || null;
  const myPts = teamPoints?.[team];
  const curSeries = myPts?.current;
  const prevSeries = myPts?.prev;
  const prevAvailable = (prevSeries?.rounds?.length ?? 0) > 0;

  // filters: spelers / keepers (beide/geen mogelijk) — werkt voor beide tabellen
  const myPlayersFiltered = useMemo(()=>{
    const isK = (t)=> String(t??"").toLowerCase()==="keeper";
    const isP = (t)=> !isK(t);
    return (myPlayers||[]).filter(r => (showPlayers && isP(r.Type)) || (showKeepers && isK(r.Type)));
  },[myPlayers,showPlayers,showKeepers]);

  // Opties voor Y-as metric
  const SCATTER_METRICS = [
    { key: "RAPM_per90",      label: "Impact totaal (RAPM) / 90min" },
   // { key: "RAPM_off_per90",  label: "Impact offensief (RAPM_off) / 90min" },
   // { key: "RAPM_def_per90",  label: "Impact defensief (RAPM_def) / 90min" },
    { key: "Goals/90min",     label: "Goals (excl. pen) / 90min" },
    { key: "Geel/90min",      label: "Geel / 90min" },
  ];


  // --- tolerant kolom-matchen voor JSON headers ---
  const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const findCol = (row, aliases) => {
    if (!row) return null;
    const map = new Map(Object.keys(row).map(k => [normKey(k), k]));
    for (const a of aliases) {
      const hit = map.get(normKey(a));
      if (hit) return hit;
    }
    return null;
  };

  // Aliassen voor mogelijke header-varianten
  const MIN_ALIASES = ["Speelminuten","Minuten","Min","Minutes"];
  const METRIC_ALIASES = {
    // totaal-Impact: we accepteren zowel RAPM_per90 als de oude MVP-kolom
    "RAPM_per90":     ["RAPM_per90","MVP p>20/90min","MVP >20/90min","MVP p>20 per 90min"],
    "RAPM_off_per90": ["RAPM_off_per90","RAPM off per90","RAPM_off"],
    "RAPM_def_per90": ["RAPM_def_per90","RAPM def per90","RAPM_def"],
    "Goals/90min":    ["Goals/90min","Goals per 90min","Goals p/90","Goals p90"],
    "Geel/90min":     ["Geel/90min","Yellow/90min","Geel p90"]
  };


const timingScatterData = useMemo(() => {
  if (!eventBins) return [];

  const out = [];

  for (const t of ALLOWED_TEAMS) {
    const rec = eventBins[t];
    if (!rec?.timing) continue;

    out.push({
      team: t,
      avgFor: rec.timing.goalsFor.avgMinute,
      avgAgainst: rec.timing.goalsAgainst.avgMinute,
      medianFor: rec.timing.goalsFor.medianMinute,
      medianAgainst: rec.timing.goalsAgainst.medianMinute,
      isSelected: t === team,
    });
  }
  return out;
}, [eventBins, team]);



  // Data voor de scatterplot
  const scatterData = useMemo(() => {
    const rows = myPlayersFiltered || [];
    if (!rows.length) return [];
    const minutesKey = findCol(rows[0], MIN_ALIASES) || "Speelminuten";
    const metricKey  =
      findCol(rows[0], METRIC_ALIASES[scatterMetric] || [scatterMetric]) ||
      scatterMetric;
    const toNum = (v) => {
      if (v === null || v === undefined) return 0;
      const s = String(v).trim().replace(',', '.');
      const n = Number.parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    };
    const pts = rows.map(r => ({
      name: r.Speler,
      minutes: toNum(r[minutesKey]),
      value: toNum(r[metricKey]),
      type: r.Type,
    })).filter(p => p.minutes > 0 || p.value > 0);
    return pts;
  }, [myPlayersFiltered, scatterMetric]);

  const rapmOffDefData = useMemo(() => {
    const rows = myPlayersFiltered || [];
    if (!rows.length) return [];

    const toNum = (v) => {
      if (v === null || v === undefined) return 0;
      const s = String(v).trim().replace(',', '.');
      const n = Number.parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    };

    const offKey =
      findCol(rows[0], METRIC_ALIASES["RAPM_off_per90"] || ["RAPM_off_per90","RAPM_off"]) ||
      "RAPM_off_per90";
    const defKey =
      findCol(rows[0], METRIC_ALIASES["RAPM_def_per90"] || ["RAPM_def_per90","RAPM_def"]) ||
      "RAPM_def_per90";

    return rows.map(r => ({
      name: r.Speler,
      off: toNum(r[offKey]),
      def: toNum(r[defKey]),
      type: r.Type,
    })).filter(p => p.off !== 0 || p.def !== 0);
  }, [myPlayersFiltered]);


  // Alle spelers over alle teams (met Team-tag), met dezelfde type-filters (speler/keeper)
  const allPlayers = useMemo(() => {
    const src = playerStats || {};
    return Object.entries(src).flatMap(([team, arr]) =>
      (arr || []).map(r => ({ ...r, Team: team }))
    );
  }, [playerStats]);

  const allPlayersFiltered = useMemo(() => {
    const isK = (t)=> String(t??"").toLowerCase()==="keeper";
    const isP = (t)=> !isK(t);
    return (allPlayers||[]).filter(r => (showPlayers && isP(r.Type)) || (showKeepers && isK(r.Type)));
  }, [allPlayers, showPlayers, showKeepers]);

  const leaderboards = useMemo(() => makeLeaderboards(allPlayers), [allPlayers]);

  const eloSeries = useMemo(() => {
    if (!eloMap || !team) return [];
    const rec = eloMap[team];
    if (!rec) return [];
    const rounds = rec.rounds || [];
    const elo    = rec.elo   || [];
    const opp    = rec.opp   || [];
    const res    = rec.res   || [];
    const gd     = rec.gd    || [];
    const oppNm  = rec.oppName || [];
    return rounds.map((r, i) => ({
      r,
      elo: Number.isFinite(+elo[i]) ? Math.round(+elo[i]) : null,
      opp: Number.isFinite(+opp[i]) ? Math.round(+opp[i]) : null,
      res: res[i] || null,
      gd : Number.isFinite(+gd[i])  ? +gd[i]  : 0,
      oppName: oppNm[i] || null,
    }));
  }, [eloMap, team]);

  const last5Map = useMemo(() => {
  if (!eloMap) return {};
  const out = {};
  for (const t of ALLOWED_TEAMS) {
    const seq = eloMap?.[t]?.res || [];
    out[t] = seq.slice(-5); // laatste 5, in volgorde zoals in JSON
  }
  return out;
}, [eloMap]);


  // -------- NIEUW: data voor bar charts uit teamStats ----------
  const rowsForm = useMemo(
    () => (teamStats || [])
      .filter(t => ALLOWED_TEAMS.includes(t.Team))
      .map(t => ({ team: t.Team, value: t["ELO +/- L5"] ?? 0 }))
      .sort((a, b) => (b.value - a.value) || a.team.localeCompare(b.team)),
    [teamStats]
  );

  const rowsOpp = useMemo(
    () => (teamStats || [])
      .filter(t => ALLOWED_TEAMS.includes(t.Team))
      .map(t => ({ team: t.Team, value: t["ELO opp diff tot"] ?? 0 }))
      .sort((a, b) => (b.value - a.value) || a.team.localeCompare(b.team)),
    [teamStats]
  );

// bv. 40% van max speelminuten
const RAPM_MIN_MINUTES_RATIO = 0.4;

const minMinutesForRapm = useMemo(() => {
  if (!playerStats) return 0;

  let maxMinutes = 0;

  for (const teamName of ALLOWED_TEAMS) {
    const arr = playerStats[teamName] || [];
    for (const p of arr) {
      const mins = Number(p.Speelminuten ?? p["Minutes"] ?? 0);
      if (Number.isFinite(mins) && mins > maxMinutes) {
        maxMinutes = mins;
      }
    }
  }

  return maxMinutes * RAPM_MIN_MINUTES_RATIO;
}, [playerStats]);


    // RAPM-boxplotdata per team (alleen spelers met >=600 min)
const teamRapmBoxData = useMemo(() => {
  if (!playerStats) return [];

  const out = [];

  for (const teamName of ALLOWED_TEAMS) {
    const arr = playerStats[teamName] || [];

    const rapms = arr
      .filter(p => {
        const mins = Number(p.Speelminuten ?? p["Minutes"] ?? 0);
        const rapm = Number(p.RAPM_per90 ?? 0);
        return (
          Number.isFinite(mins) &&
          mins >= minMinutesForRapm &&   // <-- hier ipv 600
          Number.isFinite(rapm)
        );
      })
        .map(p => Number(p.RAPM_per90))
        .sort((a, b) => a - b);

      if (!rapms.length) continue;

      const q = (p) => {
        const pos = (rapms.length - 1) * p;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return rapms[lo];
        const w = pos - lo;
        return rapms[lo] * (1 - w) + rapms[hi] * w;
      };

      out.push({
        team: teamName,
        min: rapms[0],
        q1: q(0.25),
        median: q(0.5),
        q3: q(0.75),
        max: rapms[rapms.length - 1],
      });
    }

    return out;
    }, [playerStats]);

const teamXppmBoxData = useMemo(() => {
  if (!playerStats) return [];

  const out = [];

  for (const teamName of ALLOWED_TEAMS) {
    const arr = playerStats[teamName] || [];

    const vals = arr
      .filter((p) => {
        const mins = Number(p.Speelminuten ?? p["Minutes"] ?? 0);
        const xppm = Number(p.xPPM_per90 ?? p["xPPM_per90"] ?? 0);
        return (
          Number.isFinite(mins) &&
          mins >= minMinutesForRapm &&
          Number.isFinite(xppm)
        );
      })
      .map((p) => Number(p.xPPM_per90 ?? p["xPPM_per90"]))
      .sort((a, b) => a - b);

    if (!vals.length) continue;

    const q = (p) => {
      const pos = (vals.length - 1) * p;
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      if (lo === hi) return vals[lo];
      const w = pos - lo;
      return vals[lo] * (1 - w) + vals[hi] * w;
    };

    out.push({
      team: teamName,
      min: vals[0],
      q1: q(0.25),
      median: q(0.5),
      q3: q(0.75),
      max: vals[vals.length - 1],
    });
  }

  return out;
}, [playerStats, minMinutesForRapm]);



  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white text-gray-900">
      <div className="max-w-screen-2xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-3xl font-semibold">P1 West-Vlaanderen 2025-2026</h1>
          <p className="text-gray-500">Selecteer een team om het overzicht te tonen.</p>
        </header>

        <section className="mb-6">
          <div className="rounded-2xl p-4 bg-white shadow-sm ring-1 ring-black/5">
            <label className="text-sm text-gray-500">Team</label>
            <select className="mt-2 w-full rounded-xl border border-gray-200 p-3 focus:outline-none focus:ring-2 focus:ring-black/10"
                    value={team} onChange={(e)=>setTeam(e.target.value)}>
              {teams.map(t=> <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </section>

       {/* League ladder over volledige breedte */}
<section className="mb-8">
  <HeadToHeadTable
    teamName={team}
    teamsStats={teamStats}
    h2h={h2h}
    last5Map={last5Map}
  />
</section>


{/* Rij 1: Moeilijkheid & vorm laatste 5 wedstrijden */}
<section className="mb-8">
  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
    {/* 1. Moeilijkheid resterend programma */}
    <BarListChart
      title="Moeilijkheid resterend programma"
      rows={rowsOpp}
      selected={team}
      fixedMaxAbs={20}
      leftLabel="Makkelijk"
      rightLabel="Moeilijk"
    />

    {/* 2. Vorm laatste 5 wedstrijden */}
    <BarListChart
      title="Vorm laatste 5 wedstrijden"
      rows={rowsForm}
      selected={team}
      fixedMaxAbs={150}
      leftLabel="Slechte vorm"
      rightLabel="Goede vorm"
    />
  </div>
</section>

{/* Rij 2: ELO-ranking + RAPM-teamsterkte */}
<section className="mb-8">
  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
    <EloRankingTable teamName={team} teamsStats={teamStats} />
    <TeamRapmBoxplots
      dataRapm={teamRapmBoxData}
      dataXppm={teamXppmBoxData}
      selectedTeam={team}
      minMinutes={minMinutesForRapm}
    />


  </div>
</section>


{/* League-level timing scatter */}
<section className="mb-8">
  <LeagueTimingScatter
    data={timingScatterData}
    selectedTeam={team}
  />
</section>



        <section className="mb-8"><div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
  <HomeAwayBlock data={myHomeAway} />
  <HomeAwayBars data={myHomeAway} />
</div>
</section>
        <section className="mb-10"><EventHeatmap rec={myEvent} /></section>

        <section className="mb-10">
  <FirstScorerCard teamName={team} rec={myFirstScorer} />
</section>

<section className="mb-10">
  <HalftimeFulltimeCard teamName={team} rec={myHtFt} />
</section>



        <section className="mb-8">
          <div className="mb-2">
            <label className="inline-flex items-center gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={showPrevSeason}
                onChange={(e)=>setShowPrevSeason(e.target.checked)}
                disabled={!prevAvailable}
              />
              <span className={!prevAvailable ? "text-gray-400" : ""}>Toon vorig seizoen</span>
            </label>
          </div>
          <PointsChart
            seriesCurrent={curSeries}
            seriesPrev={prevSeries}
            showPrev={showPrevSeason && prevAvailable}
          />
          {!prevAvailable && (
            <p className="text-xs text-gray-400 mt-2">Geen data van vorig seizoen beschikbaar voor dit team.</p>
          )}
        </section>

        <section className="mb-10">
          <div className="flex items-center justify-start mb-2">
            <label className="text-sm text-gray-700 flex items-center gap-2">
              <input
                type="checkbox"
                className="rounded border-gray-300"
                checked={showOppElo}
                onChange={(e)=>setShowOppElo(e.target.checked)}
              />
              Toon tegenstander-ELO
            </label>
          </div>
          <EloChart data={eloSeries} showOpp={showOppElo} />
        </section>

        {/* Filters voor beide spelerstabellen */}
        <section className="mb-3">
          <div className="flex items-center gap-6">
            <label className="inline-flex items-center gap-2 text-sm text-gray-800">
              <input type="checkbox" className="h-4 w-4" checked={showPlayers} onChange={e=>setShowPlayers(e.target.checked)} />
              <span>Toon spelers</span>
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-gray-800">
              <input type="checkbox" className="h-4 w-4" checked={showKeepers} onChange={e=>setShowKeepers(e.target.checked)} />
              <span>Toon keepers</span>
            </label>
          </div>
        </section>

        <section className="mb-8">
          <PlayerStatsTable rows={myPlayersFiltered} />
        </section>

        <section className="mb-10">
          <PlayerStatsTableLast5 rows={myPlayersFiltered} />
        </section>

        {/* NIEUW: RAPM-tabel met betrouwbaarheidsinterval */}
        <section className="mb-10">
          <PlayerRapmTable rows={myPlayersFiltered} minMinutes={minMinutesForRapm} />
        </section>

        {/* NIEUW: RAPM segment-visualisatie */}
        <section className="mb-10">
          <RapmSegmentsHeatmap data={myRapmSegments} team={team} />
        </section>


        <section className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold">Speelminuten & efficiëntie</h3>
            <label className="text-sm text-gray-700 flex items-center gap-2">
              Y-as:
              <select
                className="rounded-lg border border-gray-200 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-black/10"
                value={scatterMetric}
                onChange={(e)=>setScatterMetric(e.target.value)}
              >
                {SCATTER_METRICS.map(opt => (
                  <option key={opt.key} value={opt.key}>{opt.label}</option>
                ))}
              </select>
            </label>
          </div>
          <PlayersScatter
            data={scatterData}
            metricLabel={SCATTER_METRICS.find(o => o.key === scatterMetric)?.label || scatterMetric}
          />
          <p className="text-xs text-gray-400 mt-2">
            Punten = spelers van <span className="font-medium">{team}</span>. Filters “Toon spelers/keepers” zijn van toepassing.
          </p>
        </section>

        <section className="mb-10">
          <h3 className="text-lg font-semibold mb-3">Top 10 — spelersstatistieken (alle ploegen)</h3>
          <Leaderboards data={leaderboards} selectedTeam={team} />
        </section>

      </div>
    </div>
  );
}
