// Events' Sources tab, the captain's ("a status table ... what each Source, how it synced, how often it synced and when
// was it last synced"): every connector the archive has, in a card for each way it syncs (live in the server, a
// scheduled job on this Mac, the Cua Space's exports, by hand), each with how often, when it last synced well, how it
// stands (overdue, failing and since when, its live state) and what it has brought. KPIs above count the sources, the
// overdue and the failing. Everything is the server's (GET /life-archive/api/sources, viewer/sourcesWire.ts), read on
// opening and on coming back into view; the page keeps no schedule of its own.

import { useCallback, useEffect, useState } from "react";
import { SOURCES_API, SYNC_WAY_NAMES, SYNC_WAYS, type SourceRow, type SourcesAnswer } from "../sourcesWire.ts";
import { agoText, broughtParts, cadenceText, instantText, standing } from "../sources/format.ts";
import { Card, Kpi, Kpis, Table, type Column } from "./blocks.tsx";

const COLUMNS: readonly Column[] = [
  { label: "Source", width: "minmax(180px, 1.6fr)" },
  { label: "How often", width: "minmax(140px, 1.2fr)" },
  { label: "Last synced", width: "minmax(110px, 0.9fr)" },
  { label: "Status", width: "minmax(150px, 1.2fr)" },
  { label: "Brought", width: "minmax(130px, 1.1fr)", phone: "hide" },
];

/** The latest answer, asked on opening and again on coming back into view. */
function useSources() {
  const [answer, setAnswer] = useState<SourcesAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ask = useCallback(() => {
    fetch(SOURCES_API, { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as SourcesAnswer & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        setAnswer(body);
        setProblem(null);
      })
      .catch((error: Error) => setProblem(error.message));
  }, []);
  useEffect(() => {
    ask();
    const back = () => document.hidden || ask();
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [ask]);
  return { answer, problem };
}

export function SourcesView() {
  const { answer, problem } = useSources();
  if (!answer) return <p className="viewer__message">{problem ? `The archive is unavailable: ${problem}` : "Loading…"}</p>;
  const { rows, at } = answer;
  const overdue = rows.filter((r) => r.overdue);
  const failing = rows.filter((r) => r.failing);
  const scheduled = rows.filter((r) => r.overdueAfterMs !== null);
  const latest = Math.max(0, ...rows.map((r) => r.lastOkAt ?? 0));
  return (
    <div className="sources">
      {problem && <p className="sources__problem">Could not refresh: {problem}</p>}
      <Kpis label="Sources">
        <Kpi label="Sources" value={rows.length} note={`${scheduled.length} on a schedule`} />
        <Kpi label="Overdue" value={overdue.length} tone={overdue.length > 0 ? "out" : "muted"} note={overdue.map((r) => r.label).join(", ") || "none late"} />
        <Kpi label="Failing" value={failing.length} tone={failing.length > 0 ? "out" : "muted"} note={failing.map((r) => r.label).join(", ") || "no failures"} />
        <Kpi label="Last sync" value={latest ? agoText(latest, at) : "never"} note={latest ? instantText(latest) : undefined} />
      </Kpis>
      {SYNC_WAYS.map((way) => {
        const these = rows.filter((r) => r.way === way);
        if (these.length === 0) return null;
        return (
          <Card key={way} title={SYNC_WAY_NAMES[way]} aside={`${these.length}`} flush>
            <Table label={SYNC_WAY_NAMES[way]} columns={COLUMNS} rows={these.map((row) => sourceRow(row, at))} />
          </Card>
        );
      })}
    </div>
  );
}

function sourceRow(row: SourceRow, now: number) {
  const stand = standing(row, now);
  const brought = broughtParts(row.brought);
  return {
    key: row.connector,
    alert: stand.tone === "alert",
    cells: [
      <span className="sources__what" title={row.description}>
        <span>{row.label}</span>
        <small className="sources__id">{row.connector}{row.runner && row.runner !== "the archive's server" ? ` · ${row.runner}` : ""}</small>
        {row.note && <small className="sources__note">{row.note}</small>}
      </span>,
      <span className="sources__what">
        <span>{cadenceText(row.cadence)}</span>
        {row.cadence.kind === "off" && <small className="sources__note">{row.cadence.why}</small>}
      </span>,
      row.lastOkAt === null ? <span>never</span> : <span title={instantText(row.lastOkAt)}>{agoText(row.lastOkAt, now)}</span>,
      <span className={`sources__status sources__status--${stand.tone}`} title={statusTitle(row)}>{stand.text}</span>,
      <span title={brought.join(", ")}>{brought.slice(0, 2).join(", ")}{brought.length > 2 ? ", …" : ""}</span>,
    ],
  };
}

/** What the status's hover says: the failure's time and why, the live state's detail, or why it is off. */
function statusTitle(row: SourceRow): string | undefined {
  const lines: string[] = [];
  if (row.failing) lines.push(`Failing since ${instantText(row.failing.since)}${row.failing.error ? `: ${row.failing.error}` : ""}`);
  if (row.live) lines.push(`${row.live.state} since ${instantText(row.live.since)}${row.live.detail ? `: ${row.live.detail}` : ""}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}
