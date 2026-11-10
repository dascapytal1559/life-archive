// What the page shows in place of the app when no backend answers its handshake (src/contract/handshake.ts, `down`):
// a clone run with none yet, or a backend stopped or starting again. It points at the public demo (in a new tab, so this page
// keeps asking) and the demo backend, and
// opens the app by itself once a backend answers.

import { useEffect } from "react";
import "./app.css";
import { archiveApi, ArchiveDown } from "./archiveApi.ts";
import { PUBLIC_DEMO } from "./views.ts";

/** How often the page asks again whether a backend answers, in milliseconds. */
export const ASK_AGAIN_MS = 5000;

export function NoBackend({ why }: { why: string }) {
  useEffect(() => {
    const timer = setInterval(() => {
      archiveApi.contract().then(
        () => window.location.reload(),
        (error: unknown) => {
          if (!(error instanceof ArchiveDown)) window.location.reload();
        },
      );
    }, ASK_AGAIN_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <main className="backend-refused">
      <h1>friend-map has no backend running</h1>
      <p>friend-map draws your people and messages from a backend, and none answers yet.</p>
      <p>
        <a href={PUBLIC_DEMO} target="_blank" rel="noopener noreferrer">Open the public demo</a> to look around a made-up crowd now.
      </p>
      <p>
        To run friend-map on made-up people, make the life archive's testing data with{" "}
        <code>npm run testing-data -- /tmp/life-archive-testing</code>, run its server on it with{" "}
        <code>LIFE_ARCHIVE_DATA=/tmp/life-archive-testing LIFE_ARCHIVE_URL=http://127.0.0.1:4651 npm start</code>, and open{" "}
        /friend-map/ there. To bring your own backend, the data contract, the life archive's <code>src/archive.ts</code>, says
        what it serves.
      </p>
      <p className="backend-refused__why">This page opens the map by itself once a backend answers. friend-map's server says: {why}.</p>
    </main>
  );
}
