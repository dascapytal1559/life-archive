// The Health page's Records tab: what the archive keeps that is no lab result, each a table newest first, as the
// runs' table is drawn: what the immunisations protect against and how fresh each is (Protection.tsx), the vaccines
// given (each disease by its everyday name too: "Pertussis (whooping cough)"), the medicines prescribed and dispensed,
// and Medicare's services (MBS items, with what each cost where a claims statement says) and medicines supplied under
// the PBS. A row read only from someone's transcription of a portal, never from the platform's own print, carries a
// Transcribed tag, and its section says which file that is and why. Everything comes from the server
// (../server/judge.ts's recordsOf), from by-hand.json; this only draws it.

import type { ReactNode } from "react";
import type { HealthRecords } from "../wire.ts";
import { dayText } from "./format.ts";
import { Protection } from "./Protection.tsx";
import { diseaseText } from "./freshness.ts";

/** A file's own name, without its folders. */
const fileName = (source: string) => source.split("/").at(-1)!;

/** Dollars as a statement prints them: "$43.90". */
const dollars = (n: number) => `$${n.toFixed(2)}`;

export function Records({ records, today }: { records: HealthRecords; today: string }) {
  const { immunisations, protection, medicines, services, pbs, transcriptions } = records;
  if (immunisations.length + medicines.length + services.length + pbs.length === 0) {
    return <p className="health__none">No immunisations, medicines or Medicare records yet: they are transcribed in the health records' by-hand.json.</p>;
  }
  const note = (rows: ReadonlyArray<{ transcribed: boolean }>) =>
    rows.some((r) => r.transcribed) && (
      <div className="records__note">
        {transcriptions.map((t) => (
          <p key={t.file}>
            <Transcribed /> Read only from {fileName(t.file)}: {t.why} Every other row was read from the platform's own print.
          </p>
        ))}
      </div>
    );
  return (
    <>
      {protection.length > 0 && (
        <Section title="What I'm protected against" count={protection.length}>
          <Protection rows={protection} today={today} />
        </Section>
      )}
      {immunisations.length > 0 && (
        <Section title="Immunisations" count={immunisations.length}>
          {note(immunisations)}
          <table className="runs records">
            <thead>
              <tr>
                <th>Given</th>
                <th>Against</th>
                <th>Vaccine</th>
              </tr>
            </thead>
            <tbody>
              {immunisations.map((r, i) => (
                <tr key={i} title={r.sources.join("\n")}>
                  <td>
                    {dayText(r.date)}
                    {r.transcribed && <Transcribed />}
                  </td>
                  <td title={`Printed: ${r.against}`}>{r.diseases.map(diseaseText).join(", ")}</td>
                  <td>{r.vaccine}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {medicines.length > 0 && (
        <Section title="Medicines prescribed and dispensed" count={medicines.length}>
          {note(medicines)}
          <table className="runs records">
            <thead>
              <tr>
                <th>Date</th>
                <th>Medicine</th>
                <th>Directions</th>
                <th>Supply</th>
              </tr>
            </thead>
            <tbody>
              {medicines.map((r, i) => (
                <tr key={i} title={r.sources.join("\n")}>
                  <td>
                    {dayText(r.date)}
                    <div className="runs__device">{r.record === "prescribed" ? "Prescribed" : "Dispensed"}</div>
                    {r.transcribed && <Transcribed />}
                  </td>
                  <td>
                    {r.medicine}
                    {r.brand && <div className="runs__device">{r.brand}</div>}
                  </td>
                  <td>{r.directions ?? "—"}</td>
                  <td>{r.supply ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {services.length > 0 && (
        <Section title="Medicare services (MBS)" count={services.length}>
          {note(services)}
          <table className="runs records">
            <thead>
              <tr>
                <th>Date</th>
                <th>Item</th>
                <th>Service</th>
                <th>Fee, benefit, gap</th>
              </tr>
            </thead>
            <tbody>
              {services.map((r, i) => (
                <tr key={i} title={r.sources.join("\n")}>
                  <td>
                    {dayText(r.date)}
                    {r.transcribed && <Transcribed />}
                  </td>
                  <td>{r.item}</td>
                  <td>
                    {r.description}
                    {r.provider && <div className="runs__device">{r.provider}</div>}
                  </td>
                  <td>
                    {r.fee ? (
                      <>
                        {dollars(r.fee.charged)}, {dollars(r.fee.benefit)}, {dollars(r.fee.gap)}
                        <div className="runs__device">{r.fee.paid}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {pbs.length > 0 && (
        <Section title="Medicines supplied under the PBS" count={pbs.length}>
          {note(pbs)}
          <table className="runs records">
            <thead>
              <tr>
                <th>Supplied</th>
                <th>Medicine</th>
                <th>Form and strength</th>
                <th>Quantity</th>
                <th>Repeats</th>
              </tr>
            </thead>
            <tbody>
              {pbs.map((r, i) => (
                <tr key={i} title={r.sources.join("\n")}>
                  <td>
                    {dayText(r.supplied)}
                    <div className="runs__device">prescribed {dayText(r.prescribed)}</div>
                    {r.transcribed && <Transcribed />}
                  </td>
                  <td>
                    {r.medicine}
                    <div className="runs__device">
                      {r.brand} · PBS {r.code}
                    </div>
                  </td>
                  <td>{r.form}</td>
                  <td>{r.quantity}</td>
                  <td>{r.repeats}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="health__group">
      <h2>
        {title} <span>{count}</span>
      </h2>
      <div className="fitness__card">{children}</div>
    </section>
  );
}

function Transcribed() {
  return <span className="tag tag--transcribed">Transcribed</span>;
}
