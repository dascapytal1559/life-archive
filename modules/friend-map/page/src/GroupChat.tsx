// A group chat opened in a person's panel, in place of their own chat in the
// Events section (your pick, "In the sidebar"): the way back to
// their chat, then the group's name, platform and size, how much came in since
// when, everyone in it (each opens their own panel), and its messages, opening
// at the newest, a page at a time like any chat. It follows new messages as the
// person's own chat does. Members you have never changed are drawn muted
// (untouched.ts) and the archived faint, and "Archive untouched" archives every
// untouched member at once, with no question first, as one changeset the chip
// can undo. Read only otherwise: friend-map sends only into
// one-to-one chats (server/archive/send.ts).

import { useState } from "react";
import type { GroupChat as Group } from "./archive.ts";
import { archiveApi } from "./archiveApi.ts";
import { archiveUntouched } from "./changeChip.ts";
import { groupName, NAMED_BY } from "./groupName.ts";
import { useNames } from "./names.ts";
import { change, Name, platformName } from "./PersonParts.tsx";
import { useReadOnly } from "./readOnly.ts";
import { locale, relativeDay, zonedFormat } from "./time.ts";
import { Timeline } from "./Timeline.tsx";
import { UNTOUCHED_HINT, untouchedPlan } from "./untouched.ts";
import { useArchive } from "./useArchive.ts";

/** How many members show before "Show all". */
const FIRST_MEMBERS = 12;
const number = (n: number) => n.toLocaleString(locale());
const monthFormat = zonedFormat({ month: "short", year: "numeric" });

export function GroupChat({ groupId, back, onBack, onOpenPerson }: {
  groupId: number;
  /** Where the way back leads, as its link says it ("Messages with Ada"). */
  back: string;
  onBack: () => void;
  onOpenPerson: (personId: number) => void;
}) {
  // With new messages too: its counts, its last message, and the chat's newest messages follow them.
  const group = useArchive(() => archiveApi.group(groupId), [groupId], { messages: true });
  const names = useNames();
  const backLink = <button type="button" className="link-button group-chat__back" onClick={onBack}>← {back}</button>;
  if (!group.data) {
    return (
      <>
        {backLink}
        <p className="muted">{group.unavailable ? "This group chat is no longer in the archive." : (group.error ?? "Loading…")}</p>
      </>
    );
  }
  const data = group.data;
  return (
    <>
      {backLink}
      <Timeline
        key={groupId}
        title={<Name text={groupName({ ...data, namedBy: data.members.slice(0, NAMED_BY) }, names)} />}
        source={{ group: groupId }}
        version={`${data.messageCount}:${data.lastMessageAt}`}
      >
        <p className="group-chat__facts muted">
          <span className="platform-badge">{platformName(data.platform)}</span>{" "}
          {number(data.people)} people, you included
          {` · ${number(data.messageCount)} ${data.messageCount === 1 ? "message" : "messages"}`}
          {data.firstMessageAt !== null && ` since ${monthFormat.format(data.firstMessageAt)}`}
          {data.lastMessageAt !== null && ` · last ${relativeDay(data.lastMessageAt)}`}
        </p>
        <GroupMembers group={data} onOpenPerson={onOpenPerson} />
      </Timeline>
      <p className="muted group-chat__read-only">Read only: friend-map sends only into one-to-one chats.</p>
    </>
  );
}

/**
 * Everyone in the group, each opening their own panel (the first few until "Show all"), the untouched drawn muted
 * and the archived faint, then "Archive untouched" while there is anyone to archive.
 */
export function GroupMembers({ group, onOpenPerson }: { group: Group; onOpenPerson: (personId: number) => void }) {
  const [everyone, setEveryone] = useState(false);
  const names = useNames();
  const readOnly = useReadOnly();
  const members = everyone ? group.members : group.members.slice(0, FIRST_MEMBERS);
  const plan = untouchedPlan(group.members);
  return (
    <>
      <div className="group-chat__members">
        {members.map((member) => {
          const sent = `${number(member.messages)} ${member.messages === 1 ? "message" : "messages"} here; open them`;
          const look = member.archived ? " group-chat__member--archived" : member.untouched ? " group-chat__member--untouched" : "";
          return (
            <button
              key={member.id}
              type="button"
              className={`group-chat__member${look}`}
              title={member.archived ? `Archived. ${sent}` : member.untouched ? `${UNTOUCHED_HINT}. ${sent}` : sent}
              onClick={() => onOpenPerson(member.id)}
            >
              <Name text={names.label(member).primary} />
            </button>
          );
        })}
        <span className="group-chat__member group-chat__member--you" title={`You sent ${number(group.fromMe)} here`}>You</span>
        {group.members.length > FIRST_MEMBERS && (
          <button type="button" className="link-button" onClick={() => setEveryone(!everyone)}>
            {everyone ? "Show fewer" : `Show all ${number(group.members.length)}`}
          </button>
        )}
      </div>
      {!readOnly && plan.archive.length > 0 && (
        <button type="button" className="link-button group-chat__archive-untouched" title="Archive everyone here you have never changed; the chip's Undo brings them back" onClick={() => void change(() => archiveUntouched(group.id, plan.archive))}>
          Archive untouched ({number(plan.archive.length)})
        </button>
      )}
    </>
  );
}
