// What the page shows in place of the app when it cannot use its backend (src/contract/handshake.ts, refusal): why,
// and where the contract is written, so whoever runs the backend knows what to change.

import "./app.css";

export function BackendRefused({ why }: { why: string }) {
  return (
    <main className="backend-refused">
      <h1>friend-map cannot use this backend</h1>
      <p>The backend friend-map is set to answers at /api/archive, but {why}.</p>
      <p>
        What a backend serves, and how, is the data contract: the life archive's <code>src/archive.ts</code>, whose answers
        the page holds to the shapes in <code>src/contract/schema.ts</code>.
      </p>
    </main>
  );
}
