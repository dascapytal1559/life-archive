// The group chats a person is in, in the Events section of their panel: so
// someone whose panel shows no group messages can still be seen to share
// groups with you. Each has its name (an untitled one named by the people in
// it, groupName.ts), platform, how many people are in it, what they and you
// sent there, and when it last saw a message, the latest first. It loads on
// its own once the panel has drawn (GET /people/:id/groups: structure and
// counts only). They sit under a "Group chats · 3" heading that opens and closes the
// list (open as `open` says, the panel's choice: closed whenever it opens). Clicking one opens it in place of their
// chat (GroupChat.tsx).
//
// At each row's right, a break-link button (shown on pointing at the row or
// moving into it with the keyboard, and always, faintly, on a touch screen)
// unlinks them from that group chat: they stay in it, and closeness still
// counts it, but it connects them to nobody (no links on the map, One person's
// circle or friend circles through it; People.unlinkFromGroup). The row then
// keeps a broken-link icon, which links them through it again. Each is one
// change, with the chip's Undo. The demo is read-only: no button, and none is
// unlinked.

import { useEffect, useState } from "react";
import type { PersonGroup } from "./archive.ts";
import { archiveApi } from "./archiveApi.ts";
import { saveGroupUnlinked, type ChipPerson } from "./changeChip.ts";
import { groupName } from "./groupName.ts";
import { useNames } from "./names.ts";
import { change, Name, platformName } from "./PersonParts.tsx";
import { useReadOnly } from "./readOnly.ts";
import { locale, relativeDay } from "./time.ts";
import { useArchive } from "./useArchive.ts";

/** How many are listed before "Show all". */
const FIRST = 5;

export function PersonGroups({ person, open, onToggle, onOpen }: {
  person: ChipPerson;
  open: boolean;
  onToggle: (open: boolean) => void;
  onOpen: (groupId: number) => void;
}) {
  const personId = person.id;
  const groups = useArchive(() => archiveApi.groups(personId), [personId], { messages: true });
  const readOnly = useReadOnly();
  // What a click just set, until the list loads again with it.
  const [unlinked, setUnlinked] = useState<ReadonlyMap<number, boolean>>(new Map());
  useEffect(() => setUnlinked(new Map()), [groups.data]);
  const [saving, setSaving] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const names = useNames();
  if (!groups.data || groups.data.length === 0) return null;
  const shown = all ? groups.data : groups.data.slice(0, FIRST);
  const number = (n: number) => n.toLocaleString(locale());
  const toggle = async (group: PersonGroup, unlink: boolean) => {
    setSaving(group.id);
    // The map and friend circles reload with it.
    const now = await change(() => saveGroupUnlinked(person, group, unlink));
    if (now !== undefined) setUnlinked((before) => new Map(before).set(group.id, now));
    setSaving(null);
  };
  return (
    <div className="person-groups">
      <button type="button" className="field__toggle person-groups__title" aria-expanded={open} onClick={() => onToggle(!open)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> Group chats · {number(groups.data.length)}
      </button>
      {open && <ul>
        {shown.map((group) => {
          const isUnlinked = unlinked.get(group.id) ?? group.unlinked;
          return (
          <li key={group.id} className={isUnlinked ? "person-groups__item person-groups__item--unlinked" : "person-groups__item"}>
            <button type="button" className="person-groups__row" title="Open this group chat" onClick={() => onOpen(group.id)}>
              <span className="platform-badge">{platformName(group.platform)}</span>
              <span className="person-groups__name"><Name text={groupName(group, names)} /></span>
              <span className="muted person-groups__counts">
                {number(group.people)} people
                {" · "}them {number(group.fromThem)}, you {number(group.fromMe)}
                {group.lastMessageAt !== null && ` · ${relativeDay(group.lastMessageAt)}`}
              </span>
            </button>
            {!readOnly && (
              <button
                type="button"
                className="person-groups__link"
                aria-pressed={isUnlinked}
                aria-label={isUnlinked ? UNLINKED_LABEL : UNLINK_LABEL}
                title={isUnlinked ? UNLINKED_LABEL : UNLINK_LABEL}
                disabled={saving === group.id}
                onClick={() => void toggle(group, !isUnlinked)}
              >
                <LinkIcon broken={isUnlinked} />
              </button>
            )}
          </li>
          );
        })}
      </ul>}
      {open && groups.data.length > FIRST && (
        <button type="button" className="link-button" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${number(groups.data.length)}`}
        </button>
      )}
    </div>
  );
}

/** The break-link button's words: what it does now, and what it does once they are unlinked. */
export const UNLINK_LABEL = "Not connected through this group";
export const UNLINKED_LABEL = "Connect through this group again";

/** Two chain links, joined, or broken apart (unlinked). */
function LinkIcon({ broken }: { broken: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {broken ? (
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M6.5 4.5 5.4 3.4a2.5 2.5 0 0 0-3.5 3.5l1.6 1.6a2.5 2.5 0 0 0 2.4.6" />
          <path d="M9.5 11.5l1.1 1.1a2.5 2.5 0 0 0 3.5-3.5l-1.6-1.6a2.5 2.5 0 0 0-2.4-.6" />
          <path d="M10.5 2v2M14 5.5h-2M5.5 14v-2M2 10.5h2" />
        </g>
      ) : (
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M7 9a2.5 2.5 0 0 0 3.5 0l2.6-2.6a2.5 2.5 0 0 0-3.5-3.5L8.5 4" />
          <path d="M9 7a2.5 2.5 0 0 0-3.5 0L2.9 9.6a2.5 2.5 0 0 0 3.5 3.5L7.5 12" />
        </g>
      )}
    </svg>
  );
}
