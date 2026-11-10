// Friend Map in the console: friend-map's page, embedded as the archive's server serves it (frame.ts says where), sized to the console's content area,
// with friend-map unchanged: its own header, its map views, its person panel, its settings, all inside the frame,
// its own address kept inside it. One view under the Friend Map aspect, the console's place for people and anything social, which fills the area (View.fill), so on a phone it
// has the whole screen above the dock.

import { useContext, useEffect, useRef, useState } from "react";
import { LookContext } from "../../../sdk/viewer.ts";
import { atPerson, FRIEND_MAP_PATH, postTheme, withTheme } from "./frame.ts";

export function FriendMapView() {
  const src = FRIEND_MAP_PATH;
  const look = useContext(LookContext);
  // The frame opens in the look the console had then and is never reloaded for a flip: later looks are posted to it,
  // on each flip and once more when it has loaded (a flip while it was loading would otherwise be lost). An address
  // naming a person (?person=, the Events calendar's Friend Map) opens the frame at their panel.
  const [opened] = useState(() => withTheme(atPerson(src, location.search), look));
  const origin = new URL(src, location.href).origin;
  const frame = useRef<HTMLIFrameElement>(null);
  const lookNow = useRef(look);
  lookNow.current = look;
  useEffect(() => postTheme(frame.current?.contentWindow, look, origin), [look, origin]);
  // Until friend-map draws, the frame shows the console's own ground (.embed__frame's --c-page), not white: the frame
  // takes the console's color-scheme, and friend-map's page declares its scheme before anything loads (its index.html),
  // so the two agree and the browser keeps the frame clear. A page with no scheme in a frame of another is painted
  // opaque in its own, white on a dark console, which was the white flash on opening Friend Map at night.
  return (
    <iframe
      ref={frame}
      className="embed__frame"
      src={opened}
      title="friend-map"
      allow="clipboard-write"
      onLoad={() => postTheme(frame.current?.contentWindow, lookNow.current, origin)}
    />
  );
}
