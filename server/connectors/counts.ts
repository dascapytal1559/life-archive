// What one import (or one batch of a live sync) did, as the host records it in its ledger's `source` row
// (connectors/host.ts) and the import commands and the Sources tab say it: one shape for every ledger, the core's own
// (its event index, archive/coreWrite.ts) and each module's (friend map's chats, exercise's workouts), each filling the
// parts that are its.

/** What an import did to an event index, by kind (the core's sessions, prompts and replies; exercise's `workout`). */
export type EventCounts = Partial<Record<string, { added: number; updated: number; unchanged: number }>>;

export interface ImportCounts {
  accounts: { added: number; updated: number };
  conversations: { added: number; updated: number };
  messages: {
    added: number;
    updated: number;
    unchanged: number;
    /** Records that repeated a message already seen in this import (the same id), collapsed into one. */
    duplicates: number;
    /** Of the added messages, those retracted by their sender. */
    unsentAdded: number;
    /** Messages the archive already had from another connector, now also known by this source's ids. */
    matched: number;
    /** Edits (edit events) that changed a message's text; the text before is kept in message_version. */
    edited: number;
  };
  reactions: { added: number };
  attachments: {
    added: number;
    updated: number;
    /** Attachment records in this import whose file was copied into the media folder... */
    stored: number;
    /** ...and those whose file the source did not have. */
    missing: number;
  };
  /** Calls (call events); one already there from an earlier copy of the history is unchanged, or updated if its record differs. */
  calls: { added: number; updated: number; unchanged: number };
  /** The event index's events (events.ts), by kind. */
  events: EventCounts;
  coverageSpans: number;
  /** Counts the connector kept itself, such as skipped records by reason. */
  tallies: Record<string, number>;
}

export function emptyCounts(): ImportCounts {
  return {
    accounts: { added: 0, updated: 0 },
    conversations: { added: 0, updated: 0 },
    messages: { added: 0, updated: 0, unchanged: 0, duplicates: 0, unsentAdded: 0, matched: 0, edited: 0 },
    reactions: { added: 0 },
    attachments: { added: 0, updated: 0, stored: 0, missing: 0 },
    calls: { added: 0, updated: 0, unchanged: 0 },
    events: {},
    coverageSpans: 0,
    tallies: {},
  };
}
