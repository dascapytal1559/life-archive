// The journal module's page half (sdk/viewer.ts): the Journal aspect, second in the rail after Events (registry.ts's
// RAIL), and its one view, Days (viewer/JournalSection.tsx), which reads the vault's journals through the module's
// routes and leaves editing to Obsidian. The core's page finds this file by its place (viewer/modules.ts) and shows
// the aspect in the rail while the module is on.

import { defineViewer } from "../../sdk/viewer.ts";
import { JOURNAL_ASPECT, journalViews } from "./viewer/JournalSection.tsx";

export default defineViewer({
  aspects: [
    {
      key: JOURNAL_ASPECT, label: "Journal", icon: "journal",
      blurb: "Every day's journal from the Obsidian vault, read as Obsidian shows it, with the recordings and transcripts it was written from.",
    },
  ],
  views: journalViews(),
});
