// Friend map's page half (sdk/viewer.ts): the Friend Map aspect, the console's place for people and anything social,
// and its one view: friend-map's page, whole, in a frame (viewer/FriendMapView.tsx; the core's server serves it under
// /friend-map/, the module's page). With one view the page has no tabs of its own, so friend-map's own title and view
// switcher are the top of it (the captain: "Fredmap just becomes one view. I don't like this top nav"). Its tables
// (Messages, Calls, Hangouts, People, Tags; server/tabs/) are shown and edited on the Events page's Tables, never here; Messages
// was a tab of this page until 9 November 2026, and its old address opens that table there (`moved`). A tag renamed in
// Tags keeps its switch in the map's Hide (`saved`: viewer/hide.ts).
// The core's page finds this file by its place (viewer/modules.ts) and shows the aspect where the captain put it in
// the rail (the registry's RAIL names its key), while the module is on.

import { defineViewer } from "../../sdk/viewer.ts";
import { FriendMapView } from "./viewer/FriendMapView.tsx";
import { followRename } from "./viewer/hide.ts";

/** The Friend Map aspect's key. */
export const FRIEND_MAP_ASPECT = "friend-map";

export default defineViewer({
  aspects: [
    {
      key: FRIEND_MAP_ASPECT, label: "Friend Map", icon: "friends",
      blurb: "friend-map: who you know and how close, from every message, call and hangout, embedded as it runs; the place for people and anything social.",
    },
  ],
  views: [
    {
      key: "friend-map",
      label: "friend-map",
      aspects: [FRIEND_MAP_ASPECT],
      section: "friend-map",
      blurb: "The map views and every person's panel, as friend-map runs: embedded, not rewritten.",
      fill: true,
      component: () => <FriendMapView />,
    },
  ],
  // The Messages tab's address (/life-archive/dev/friend-map/messages?person=3) opens the Messages table on the Events
  // page's Tables, its view (the query) kept: events/messages is an address Tables answers to.
  moved: { "friend-map/messages": "events/messages" },
  saved: (edit) => followRename(edit),
});
