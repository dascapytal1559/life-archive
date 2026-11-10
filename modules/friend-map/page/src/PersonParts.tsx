// Pieces of a person for the person panel: name, aliases, tags, note, reaching out, accounts,
// "last spoke", and your fixes (join person, detach, this is me). All of
// these read structure only; message text is left to Timeline.tsx.

import { Fragment, useEffect, useRef, useState } from "react";
import { isAspiring } from "./aspiring.ts";
import { ARCHIVE_REASONS, ARCHIVE_TAG, archivedByRule, KEEP_TAG, type PersonCall, type PersonSummary, tagsWithRule, writtenTag } from "./archive.ts";
import { archiveApi } from "./archiveApi.ts";
import { callDuration, callTotals } from "./calls.ts";
import { saveTags } from "./changeChip.ts";
import { reportError } from "./errors.ts";
import { joinCandidates, type Names, useNames } from "./names.ts";
import { platformName } from "./platformNames.ts";
import { useReadOnly } from "./readOnly.ts";
import { relativeDay } from "./time.ts";
import { archiveChanged, useArchive } from "./useArchive.ts";

export { platformName };

/** Runs a change to the archive, then tells every view to reload. */
export async function change<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await work();
    archiveChanged();
    return result;
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

function chipClass(tag: string): string {
  return tag === ARCHIVE_TAG ? "tag-chip tag-chip--archive" : "tag-chip";
}

/**
 * A name as the name choice shows it (see useNames): `text`, or while names
 * are hidden (No name except…), where it is empty, a neutral shape in its
 * place, so what holds it (a row, a button) can still be seen and clicked.
 */
export function Name({ text }: { text: string }) {
  const names = useNames();
  return text || !names.hidden ? <>{text}</> : <HiddenName />;
}

/** Where a name would be, while names are hidden. */
export function HiddenName() {
  return <span className="name-hidden" role="img" aria-label="Name hidden" />;
}

export function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="tag-chips">
      {tags.map((tag) => (
        <span key={tag} className={chipClass(tag)}>{tag}</span>
      ))}
    </span>
  );
}

/**
 * The person's note, saved when the box loses focus (Escape puts it back);
 * hidden and locked while names are hidden, since it can say who they are.
 */
export function NoteEditor({ person }: { person: PersonSummary }) {
  // An aspiring friend's note is where what you would say to them gathers: it asks for that, with room to.
  const aspiring = isAspiring(person);
  return (
    <TextEditor
      label="Note"
      placeholder={aspiring ? "What you would say to them" : "Anything to remember about them"}
      value={person.note}
      rows={aspiring ? { least: 6, most: 16 } : undefined}
      save={(note) => archiveApi.setNote(person.id, note)}
    />
  );
}

/** Free text saved when the box loses focus (Escape puts it back); hidden and locked while names are hidden, and text alone on a read-only page. */
function TextEditor({ label, placeholder, value, rows = { least: 2, most: 8 }, save }: {
  label: string;
  placeholder: string;
  value: string;
  /** How tall the box is at the least and the most, in lines. */
  rows?: { least: number; most: number };
  save: (text: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(value);
  const names = useNames();
  const readOnly = useReadOnly();
  if (names.hidden) return <span className="muted">{value ? "Hidden" : "None"}</span>;
  if (readOnly) return value ? <p className="read-only-text">{value}</p> : <span className="muted">None</span>;
  return (
    <textarea
      aria-label={label}
      className="note-editor"
      placeholder={placeholder}
      rows={Math.min(rows.most, Math.max(rows.least, draft.split("\n").length))}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) void change(() => save(draft));
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

/** Whether you should reach out to them: Orbits' glow. Not hidden with names, since the glow shows it anyway. */
export function ReachOutSwitch({ person }: { person: PersonSummary }) {
  const readOnly = useReadOnly();
  return (
    <label className="reach-out">
      <input
        type="checkbox"
        role="switch"
        checked={person.shouldReachOut}
        disabled={readOnly}
        onChange={(e) => void change(() => archiveApi.setShouldReachOut(person.id, e.target.checked))}
      />
      Should reach out
    </label>
  );
}

/**
 * The person's tags with a remove button each and a box to add one; "archive" on someone the rules archived is
 * theirs, not a tag, so it has no remove button. Read only: the tags alone, as chips.
 */
export function TagEditor({ person, suggestions }: { person: PersonSummary; suggestions: string[] }) {
  const [draft, setDraft] = useState("");
  const readOnly = useReadOnly();
  const shown = person.tags;
  if (readOnly) {
    const tags = tagsWithRule(person);
    return tags.length > 0 ? <TagChips tags={tags} /> : <span className="muted">None</span>;
  }
  const save = (tags: string[]) => void change(() => saveTags(person.id, person.tags, tags));
  const add = () => {
    const tag = writtenTag(draft);
    if (!tag || person.tags.includes(tag)) return setDraft("");
    save([...person.tags, tag]);
    setDraft("");
  };
  const listId = `tag-suggestions-${person.id}`;
  return (
    <div className="tag-editor">
      {shown.map((tag) => (
        <span key={tag} className={chipClass(tag)}>
          {tag}
          <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => save(person.tags.filter((t) => t !== tag))}>×</button>
        </span>
      ))}
      {archivedByRule(person) && (
        <span className={chipClass(ARCHIVE_TAG)} title="Archived by the archive rules; unarchive them to take it off">{ARCHIVE_TAG}</span>
      )}
      <form
        className="tag-editor__add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          aria-label="Add a tag"
          placeholder={shown.length === 0 ? "Add a tag, e.g. sibling" : "Add a tag"}
          list={listId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <datalist id={listId}>
          {suggestions.filter((s) => !person.tags.includes(s)).map((s) => <option key={s} value={s} />)}
        </datalist>
      </form>
    </div>
  );
}

/**
 * Archives a person (the "archive" tag: off the map and every map view), or brings them
 * back. Bringing back someone an automatic rule fits also tags them "keep", so the
 * rule leaves them be. Either way the choice is saved in their tags.
 */
export function ArchiveButton({ person }: { person: PersonSummary }) {
  const readOnly = useReadOnly();
  const archived = person.archived !== null;
  if (readOnly) return null;
  const next = archived
    ? [...person.tags.filter((t) => t !== ARCHIVE_TAG), ...(person.archiveRule && !person.tags.includes(KEEP_TAG) ? [KEEP_TAG] : [])]
    : [...person.tags.filter((t) => t !== KEEP_TAG), ARCHIVE_TAG];
  return (
    <button type="button" className="button" onClick={() => void change(() => saveTags(person.id, person.tags, next))}>
      {archived ? "Unarchive" : "Archive"}
    </button>
  );
}

/** Why a person is archived, when they are. */
export function ArchivedNote({ person }: { person: PersonSummary }) {
  if (person.archived === null) return null;
  return (
    <p className="archived-note">
      <strong>Archived</strong> {person.archived === "you" ? "by you" : <>by the archive rules: {ARCHIVE_REASONS[person.archived]}</>}. Off the map and every map view;
      {person.archived === "you"
        ? " never joined with anyone or proposed as the same person as anyone"
        : " joined with anyone of exactly the same full name, and proposed as the same person as another only on the same phone number"}; their
      messages are all kept.
      {person.archived !== "you" && " Unarchiving tags them “keep”, so this rule leaves them be."}
    </p>
  );
}

export function MessageCounts({ person }: { person: PersonSummary }) {
  const parts = [];
  if (person.directMessageCount > 0) parts.push(`${person.directMessageCount} in chats`);
  if (person.groupMessageCount > 0) parts.push(`${person.groupMessageCount} in groups`);
  if (person.marketplaceMessageCount > 0) parts.push(`${person.marketplaceMessageCount} on Marketplace`);
  return <span className="muted">{parts.length > 0 ? parts.join(", ") : "no messages"}</span>;
}

const LINKS: Record<string, string> = {
  import: "Found by an import",
  captain: "Linked by you",
  "rule:same-name": "Joined by name: exactly the same name",
  "rule:same-number": "Joined by number: the same number or Apple ID as their iMessage",
};

/**
 * The person's accounts, each with its messages: one-to-one ones, and with
 * `groups` what it sent in group chats too, and how it was linked to them.
 * With `onOpen`, each one's own messages can be opened (OpenAccountButton), to see who it really is;
 * `openAccount` is the one open. When they have more than one, any can be taken off again (DetachButton),
 * unless the page is read only.
 */
export function AccountList({ person, groups = true, calls, onOpen, openAccount = null }: {
  person: PersonSummary;
  groups?: boolean;
  /**
   * Their calls: a call account (platform phone, badged "Phone call") shows its answered calls and their time, as the
   * others show their messages; another account with calls (its app's, or ones you logged on it) adds them.
   */
  calls?: readonly PersonCall[];
  onOpen?: (accountId: number) => void;
  openAccount?: number | null;
}) {
  const names = useNames();
  const readOnly = useReadOnly();
  return (
    <ul className="account-list">
      {person.accounts.map((account) => {
        const count = groups ? account.messageCount : account.directMessageCount;
        const detachable = person.accounts.length > 1 && !readOnly;
        const name = names.shown(account.displayName);
        const accountCalls = (calls ?? []).filter((call) => call.accountId === account.id);
        return (
          <li key={account.id} title={LINKS[account.link] ?? account.link}>
            <span className="platform-badge">{account.platform === "phone" ? "Phone call" : platformName(account.platform)}</span>
            <span className="account-list__text">
              <span className="account-list__name" title={name || undefined}><Name text={name} /></span>
              {account.platform === "phone" ? (
                <AccountCalls calls={accountCalls} />
              ) : (
                <AccountStats
                  parts={[`${count} msg${count === 1 ? "" : "s"}`, account.lastMessageAt ? relativeDay(account.lastMessageAt) : false, ...callParts(accountCalls)]}
                  title={`${groups ? "One-to-one messages, and what they sent in group chats" : "One-to-one messages"}, and when the last was${accountCalls.length > 0 ? "; then its answered calls and how long they were connected in all" : ""}`}
                />
              )}
            </span>
            {(onOpen || detachable) && (
              <span className="account-list__actions">
                {onOpen && <OpenAccountButton accountId={account.id} open={account.id === openAccount} onOpen={onOpen} />}
                {detachable && <DetachButton personId={person.id} accountId={account.id} />}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** An account's second line, its parts joined by " · ", each kept whole ("2026-06-04", "+61491570110", "1 h 23 min"). */
function AccountStats({ parts, title }: { parts: readonly (string | false)[]; title: string }) {
  return (
    <span className="muted account-list__count" title={title}>
      {parts
        .filter((part) => part !== false)
        .map((part, i) => <Fragment key={i}>{i > 0 && " · "}<span>{part}</span></Fragment>)}
    </span>
  );
}

/** A message account's calls, after its messages: "3 calls", "1 h 5 min"; nothing with none answered. */
function callParts(calls: readonly PersonCall[]): string[] {
  const { answered, seconds } = callTotals(calls);
  return answered > 0 ? [`${answered} call${answered === 1 ? "" : "s"}`, callDuration(seconds)] : [];
}

/**
 * A call account's calls, as a message account shows its messages: "4 calls · 1 h 23 min · 2026-08-21", its answered
 * calls, how long they were connected in all, and when the last call was, answered or not; with none answered,
 * "1 missed call" or "3 missed", and "No calls" with none at all.
 */
function AccountCalls({ calls }: { calls: readonly PersonCall[] }) {
  const { answered, seconds, unanswered } = callTotals(calls);
  const count = answered > 0 ? `${answered} call${answered === 1 ? "" : "s"}`
    : unanswered === 1 ? "1 missed call"
    : unanswered > 1 ? `${unanswered} missed`
    : "No calls";
  return (
    <AccountStats
      parts={[count, answered > 0 && callDuration(seconds), calls.length > 0 && relativeDay(calls[0].at)]}
      title={`Answered calls from the phone's call history and those you logged on it, how long they were connected in all, and when the last call was${answered > 0 && unanswered > 0 ? ` (${unanswered} not answered)` : ""}`}
    />
  );
}

const OPEN_LABEL = "Open this account's messages";

/** Opens one account's own messages in place of the person's chat; it changes nothing. */
export function OpenAccountButton({ accountId, open, onOpen }: { accountId: number; open: boolean; onOpen: (accountId: number) => void }) {
  return (
    <button
      type="button"
      className="account-list__open"
      aria-label={OPEN_LABEL}
      aria-pressed={open}
      title={`${OPEN_LABEL}, to see who it really is`}
      onClick={() => onOpen(accountId)}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

const DETACH_LABEL = "Not them: make this account a separate person";

/** "Not them", as an ×: the account is someone else, so it becomes a person of its own again. */
export function DetachButton({ personId, accountId }: { personId: number; accountId: number }) {
  return (
    <button
      type="button"
      className="account-list__detach"
      aria-label={DETACH_LABEL}
      title={DETACH_LABEL}
      onClick={() => void change(() => archiveApi.detach(personId, accountId))}
    >
      ×
    </button>
  );
}

/** An account in a list of them: its platform and name, or its platform alone while names are hidden. */
export function accountName(account: { platform: string; displayName: string }, names: Names): string {
  return names.hidden ? platformName(account.platform) : `${platformName(account.platform)}: ${account.displayName}`;
}

/**
 * "Join person": join this person into someone you pick by name or
 * alias. The one picked is kept, with its name, and gains this person's
 * accounts, aliases, tags and note; this person is deleted, so it asks first.
 * A small link at the right of the Accounts heading; clicked, it becomes a
 * borderless field there in the same small type, with the matches, then the
 * question, just below. Esc or a click elsewhere closes it.
 */
export function JoinPerson({ person, onJoined }: {
  person: PersonSummary;
  onJoined: (survivor: PersonSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [into, setInto] = useState<PersonSummary | null>(null);
  const names = useNames();
  const readOnly = useReadOnly();
  const box = useRef<HTMLSpanElement>(null);
  // Everyone, to choose from: a big download, so only once you start joining.
  const everyone = useArchive(() => archiveApi.people(), [], { enabled: open });
  const close = () => {
    setOpen(false);
    setQuery("");
    setInto(null);
  };
  // A click anywhere outside closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  if (readOnly) return null;
  if (!open) {
    return (
      <span className="join-person">
        <button type="button" className="link-button join-person__open" title="This is someone you already have: join them into that person" onClick={() => setOpen(true)}>
          Join person
        </button>
      </span>
    );
  }
  const matches = into ? [] : joinCandidates(person.id, (everyone.data?.people ?? []).filter((p) => !names.outside(p.id)), query);
  return (
    <span
      className="join-person join-person--open"
      ref={box}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <input
        aria-label="Join into another person"
        placeholder="Join into… (type a name)"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setInto(null);
        }}
      />
      {into ? (
        <span className="join-person__below join-person__confirm">
          Join <strong><Name text={names.label(person).primary} /></strong> into <strong><Name text={names.label(into).primary} /></strong>?{" "}
          <button
            type="button"
            onClick={async () => {
              const survivor = await change(() => archiveApi.join(person.id, into.id));
              close();
              if (survivor) onJoined(survivor);
            }}
          >
            Join
          </button>{" "}
          <button type="button" className="link-button" onClick={() => setInto(null)}>
            Cancel
          </button>
        </span>
      ) : !everyone.data && query.trim() !== "" ? (
        <span className="join-person__below muted">{everyone.error ?? "Loading everyone…"}</span>
      ) : matches.length > 0 && (
        <ul className="join-person__below">
          {matches.map((other) => (
            <li key={other.id}>
              <button type="button" onClick={() => setInto(other)}>
                {names.hidden ? <Name text={names.label(other).primary} /> : [other.name, ...other.aliases].join(" / ")}{" "}
                <span className="muted">
                  — {other.accounts.map((a) => accountName(a, names)).join(", ") || "no accounts"}
                  {other.archived !== null && ", archived"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
