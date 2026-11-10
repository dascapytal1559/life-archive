// The demo on the page (demoMode.ts): the note on every one of its pages, so
// it is never mistaken for the real map.

import "./demoMode.css";

/** At the top of the map on the demo's pages (Demos.tsx), saying everyone in it is made up; it takes no clicks. */
export function DemoModeMark() {
  return (
    <div className="demo-mode" role="note">
      Demo · everyone here is made up
    </div>
  );
}
