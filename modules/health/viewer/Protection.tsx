// The Records tab's summary above the doses: what the immunisations protect against, one row per disease (a combined
// vaccine's split into its diseases), its latest dose, and a bar from that dose to the end of the interval the
// Australian Immunisation Handbook sets for adults, today marked on it, so it shows how much is left. A lifelong
// protection, or one with no booster set, is a full bar; a course short of its doses is a hatched bar to its next dose;
// a disease with no set interval, or one the lookup does not know, has no bar. Calm colours only: an interval that has
// ended is drawn grey, never red. The rows and their words come from the server (../server/immunisations.ts).

import { IMMUNISATION_HANDBOOK, type ProtectionRow } from "../wire.ts";
import { dayText } from "./format.ts";
import { diseaseText, elapsed, spanText } from "./freshness.ts";

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

export function Protection({ rows, today }: { rows: readonly ProtectionRow[]; today: string }) {
  return (
    <>
      <p className="records__note protection__about">
        General information, not medical advice. Each bar runs from the latest dose on record to the end of the interval the{" "}
        <a href={IMMUNISATION_HANDBOOK} target="_blank" rel="noreferrer">
          Australian Immunisation Handbook
        </a>{" "}
        sets for adults, with today marked; many intervals apply only to some adults (travel, some work, an age), as each row says.
      </p>
      <table className="runs records protection">
        <thead>
          <tr>
            <th>Against</th>
            <th>Latest dose</th>
            <th>How fresh</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.disease.name}>
              <td>{diseaseText(r.disease)}</td>
              <td>
                {dayText(r.latest.date)}
                <div className="runs__device">
                  {r.latest.vaccine}
                  {r.doses > 1 && ` · ${r.doses} doses`}
                </div>
              </td>
              <td className="protection__fresh">
                <Bar row={r} today={today} />
                <div>{spanText(r.span, today, r.handbook !== null)}</div>
                {r.handbook && (
                  <div className="runs__device">
                    {r.handbook.says}{" "}
                    <a href={r.handbook.url} target="_blank" rel="noreferrer">
                      Handbook
                    </a>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Bar({ row, today }: { row: ProtectionRow; today: string }) {
  const { span } = row;
  if (span === null) return null;
  if (span.kind === "lasting") {
    return <div className="fresh fresh--lasting" role="img" aria-label={spanText(span, today, true)} />;
  }
  const done = elapsed(row.latest.date, span.until, today);
  return (
    <div className="fresh__wrap">
      <div className={`fresh${span.kind === "course" ? " fresh--course" : ""}${done >= 1 ? " fresh--ended" : ""}`} role="img" aria-label={spanText(span, today, true)}>
        <div className="fresh__left" style={{ left: percent(done), width: percent(1 - done) }} />
        <div className="fresh__today" style={{ left: percent(done) }} title={`Today, ${dayText(today)}`} />
      </div>
      <div className="fresh__ends runs__device">
        <span>{dayText(row.latest.date)}</span>
        <span>{dayText(span.until)}</span>
      </div>
    </div>
  );
}
