// The People panel: everyone you have chatted with, and everyone you
// have added, from the archive's person table. At the top, people who may be
// the same person wait for your call; below, everyone, filterable by
// tag and by kind (group-only acquaintances, and the archived, each with why).
// Choosing someone opens the person panel (PersonView): name, aliases,
// tags, location (edited in place, for anyone), should reach out, hangouts and calls (Add event), archiving,
// accounts, fixes and messages, and at the foot a draft of a message to them.
// The map views open it straight at a person, showing what the map already
// knows of them at once while the rest loads, and the messages last, a page at a time.

import { useEffect, useMemo, useRef, useState } from "react";
import { ARCHIVE_REASONS, ARCHIVE_TAG, KEEP_TAG, type LocationInfo, type MergeProposal, type PeopleListing, type PersonSummary } from "./archive.ts";
import { archiveApi } from "./archiveApi.ts";
import { locationMatches } from "./locations.ts";
import { Identicon } from "./Identicon.tsx";
import { goesBy, holds, useNames } from "./names.ts";
import { back, historyOf, merged, NO_HISTORY, opened, type PersonStep } from "./personHistory.ts";
import { NamesField } from "./NameChips.tsx";
import { PlaceEditor } from "./PersonFields.tsx";
import {
  AccountList,
  accountName,
  ArchiveButton,
  ArchivedNote,
  change,
  JoinPerson,
  MessageCounts,
  Name,
  NoteEditor,
  platformName,
  ReachOutSwitch,
  TagChips,
  TagEditor,
} from "./PersonParts.tsx";
import { useReadOnly } from "./readOnly.ts";
import { useShowGroups } from "./showGroups.ts";
import { locale, relativeDay } from "./time.ts";
import { ActivityChart } from "./ActivityChart.tsx";
import { offers } from "./contract/handshake.ts";
import { CatchUpsField } from "./CatchUps.tsx";
import { DraftBox } from "./DraftBox.tsx";
import { GroupChat } from "./GroupChat.tsx";
import { PersonGroups } from "./PersonGroups.tsx";
import { Timeline } from "./Timeline.tsx";
import { momentKey, type ChatMoment } from "./chatDays.ts";
import { UNTOUCHED_HINT } from "./untouched.ts";
import { useArchive } from "./useArchive.ts";

type Filter = { kind: "all" | "direct" | "groups-only" | "archived" } | { kind: "tag"; tag: string };

const RULES: Record<string, string> = {
  "phone-match": "Same phone number",
  "name-exact": "Same name",
  "name-one-word": "Same one-word name",
  "name-contained": "One name contains the other",
};

/** What the page already knows about a person, shown while the rest of their panel loads. */
export interface PersonPreview {
  id: number;
  name: string;
  aliases: string[];
  tags: string[];
  identiconSeed: string;
  identiconHue: number | null;
}

/**
 * The panel, open at the list (`openId` null) or at one person. `preview`,
 * where given, is what the page already knows of a person (the map's model),
 * shown at once. The page's People button goes back to the list.
 * A person opened from inside the panel (a group chat's member, say) can be
 * left by the back arrow at its top left, to the one they were opened from
 * (personHistory.ts); one opened from outside it starts afresh. A page that
 * opened it from a panel of its own (the Calendar's day) gives `back`, where
 * the arrow goes once there is nobody to go back to here.
 */
export function PeoplePanel({ hidden = false, openId, moment, onOpen, onClose, onGroup, preview, back: outside, className = "" }: {
  hidden?: boolean;
  openId: number | null;
  /** Where the open person's chat opens, in place of its newest message (a chip in the Table's Who). */
  moment?: ChatMoment;
  onOpen: (id: number | null) => void;
  onClose: () => void;
  /** Told which group chat the open person's panel shows in place of their chat (null for none), as it changes. */
  onGroup?: (groupId: number | null) => void;
  preview?: (id: number) => PersonPreview | undefined;
  /** Back to where the page opened the panel from: what it is called, and how to go there. */
  back?: { label: string; onBack: () => void };
  className?: string;
}) {
  // Everyone is a big download (every archived person too): only while the list is showing, so opening a person never waits on it.
  const listing = useArchive(() => archiveApi.people(), [], { enabled: openId === null });
  const proposals = useArchive(() => archiveApi.proposals(), []);
  const tags = useArchive(() => archiveApi.tags(), []);
  const locations = useArchive(() => archiveApi.locations(), []);
  const setOpenId = onOpen;
  const names = useNames();
  const [history, setHistory] = useState(NO_HISTORY);
  // Someone opened from outside (or the list): the history was another's, so it starts afresh.
  const [lastOpenId, setLastOpenId] = useState(openId);
  if (openId !== lastOpenId) {
    setLastOpenId(openId);
    setHistory(historyOf(history, openId));
  }
  const previous = historyOf(history, openId).previous.at(-1);
  const goBack = () => {
    const step = back(history, openId);
    if (!step) return;
    setHistory(step.history);
    setOpenId(step.to);
  };

  return (
    <aside className={`side-panel people-panel ${className}`} aria-label="People" hidden={hidden}>
      <header className="side-panel__header">
        {openId !== null && previous ? <BackButton label={names.label(previous).primary} onBack={goBack} />
          : outside && <BackButton label={outside.label} onBack={outside.onBack} />}
        {openId === null && <h2>People</h2>}
        <button
          type="button"
          className="side-panel__close"
          onClick={() => {
            setHistory(NO_HISTORY);
            onClose();
          }}
          aria-label="Close"
        >
          ×
        </button>
      </header>
      {openId !== null ? (
        // A person opens without waiting for everyone (or the list): they load on their own.
        <OpenPerson
          key={openId}
          id={openId}
          moment={moment}
          tagNames={tags.data?.map((t) => t.name)}
          locations={locations.data}
          onGroup={onGroup}
          preview={preview?.(openId)}
          onMerged={(survivor) => {
            setHistory(merged(history, openId, survivor.id));
            setOpenId(survivor.id);
          }}
          onOpenPerson={(from, to) => {
            setHistory(opened(history, from, to));
            setOpenId(to);
          }}
          // Gone since (joined away, say), when reached by going back: on to the one before.
          onGone={historyOf(history, openId).cameBack ? goBack : undefined}
        />
      ) : listing.unavailable ? (
        <p className="muted">The message archive is not running. See docs/archive.md: “The message archive”.</p>
      ) : !listing.data ? (
        <p className="muted">{listing.error ?? "Loading…"}</p>
      ) : (
        <>
          <Review proposals={proposals.data ?? []} onOpen={setOpenId} />
          <PeopleList listing={listing.data} onOpen={setOpenId} />
        </>
      )}
    </aside>
  );
}

/** The arrow back to the person this one was opened from; its label and tooltip name them, unless names are hidden. */
export function BackButton({ label, onBack }: { label: string; onBack: () => void }) {
  const words = label ? `Back to ${label}` : "Back to the previous person";
  return (
    <button type="button" className="side-panel__back" onClick={onBack} aria-label={words} title={words}>
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
        <path d="M13 8H3.5M7.5 3.5 3 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function Review({ proposals, onOpen }: { proposals: MergeProposal[]; onOpen: (id: number) => void }) {
  const [showAll, setShowAll] = useState(false);
  const names = useNames();
  if (proposals.length === 0) return null;
  const shown = showAll ? proposals : proposals.slice(0, 3);
  return (
    <section className="review" aria-label="People to review">
      <h3>
        Same person? <span className="count">{proposals.length}</span>
      </h3>
      <p className="muted review__hint">
        People with exactly the same name are joined by themselves, unless it is one word (not in Chinese). The same one-word name, the
        same phone number, or one name that contains the other, waits here: nothing is merged until you say so, and merging keeps one person with both’s accounts, aliases, tags and notes. Names that only look alike
        (a first name alone, a different case) are not suggested; join those yourself with “Join person” in a person’s panel.
      </p>
      {shown.map((proposal) => (
        <article key={proposal.id} className="proposal">
          <div className="proposal__people">
            {proposal.people.map((person) => (
              <button key={person.id} type="button" className="proposal__person" onClick={() => onOpen(person.id)}>
                <strong><PersonLabel person={person} /></strong>
                <TagChips tags={person.tags} />
                <span className="muted">
                  {person.accounts.map((a) => accountName(a, names)).join(", ") || "no accounts yet"}
                </span>
                <MessageCounts person={person} />
              </button>
            ))}
          </div>
          <p className="proposal__evidence">
            <span className={`tier tier--${proposal.tier}`}>{proposal.tier}</span>
            {proposal.evidence.map((evidence) => RULES[evidence.rule] ?? evidence.rule).join("; ")}
          </p>
          <div className="proposal__actions">
            <button type="button" className="button button--primary" onClick={() => void change(() => archiveApi.confirm(proposal.id))}>
              Same person
            </button>
            <button type="button" className="button" onClick={() => void change(() => archiveApi.reject(proposal.id))}>
              Different people
            </button>
          </div>
        </article>
      ))}
      {proposals.length > shown.length && (
        <button type="button" className="link-button" onClick={() => setShowAll(true)}>Show all {proposals.length}</button>
      )}
    </section>
  );
}

export function PeopleList({ listing, onOpen }: { listing: PeopleListing; onOpen: (id: number) => void }) {
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [query, setQuery] = useState("");
  const names = useNames();
  // What was typed (a name, as often as not) goes once names are hidden.
  useEffect(() => {
    if (names.hidden) setQuery("");
  }, [names.hidden]);
  const counts = useMemo(() => {
    const shown = listing.people.filter((p) => p.archived === null);
    return {
      all: shown.length,
      direct: shown.filter((p) => p.directMessageCount > 0).length,
      "groups-only": shown.filter(isGroupOnly).length,
      archived: listing.people.length - shown.length,
    };
  }, [listing]);
  const words = query.trim();
  const people = listing.people.filter((person) => {
    // While names are hidden, someone is found only by the name they are shown by (as on the map and the Table), so
    // a search never says who is who.
    const matches = !words || (names.hidden
      ? holds(names.label(person).primary, words)
      : goesBy(person.name, person.aliases, words) || holds(person.note, words)
        || locationMatches(person, words) || person.accounts.some((a) => holds(a.displayName, words)));
    if (!matches) return false;
    // Tags and a search find archived people too; the other filters are about the people on the map.
    if (filter.kind === "tag") return person.tags.includes(filter.tag);
    if (filter.kind === "archived") return person.archived !== null;
    if (person.archived !== null && !words) return false;
    if (filter.kind === "direct") return person.directMessageCount > 0;
    if (filter.kind === "groups-only") return isGroupOnly(person);
    return true;
  });
  const chip = (label: string, next: Filter, count?: number) => {
    const active = filter.kind === next.kind && (next.kind !== "tag" || (filter.kind === "tag" && filter.tag === next.tag));
    return (
      <button key={label} type="button" className={`filter-chip${active ? " filter-chip--active" : ""}`} onClick={() => setFilter(next)}>
        {label}{count !== undefined && <span className="count">{count}</span>}
      </button>
    );
  };

  return (
    <section className="people-list" aria-label="Everyone">
      <input
        className="people-list__search"
        type="search"
        aria-label="Find a person"
        placeholder="Find a person"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="filter-chips">
        {chip("Everyone", { kind: "all" }, counts.all)}
        {chip("Chats with me", { kind: "direct" }, counts.direct)}
        {chip("Groups only", { kind: "groups-only" }, counts["groups-only"])}
        {counts.archived > 0 && chip("Archived", { kind: "archived" }, counts.archived)}
        {listing.tags.map(({ tag, count }) => chip(`#${tag}`, { kind: "tag", tag }, count))}
      </div>
      <ul>
        {people.map((person) => (
          <li key={person.id}>
            <button type="button" className="person-row" onClick={() => onOpen(person.id)}>
              <span className="person-row__name">
                <Identicon seed={person.identiconSeed} hue={person.identiconHue} size={16} className="person-row__identicon" />
                <PersonLabel person={person} />
                {person.unknown && <span className="muted"> (deleted or unknown account)</span>}
                {person.archived !== null && person.archived !== "unknown" && (
                  <span className="muted">
                    {person.archived === "you" ? " (archived by you)" : ` (archived: ${ARCHIVE_REASONS[person.archived].toLowerCase()})`}
                  </span>
                )}
              </span>
              <TagChips tags={person.tags} />
              <span className="person-row__meta muted">
                <MessageCounts person={person} />
                {person.lastMessageAt && ` · ${relativeDay(person.lastMessageAt)}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {people.length === 0 && <p className="muted">Nobody here.</p>}
      {listing.me && (
        <p className="muted people-list__me">
          You: {listing.me.accounts.map((a) => (names.hidden ? platformName(a.platform) : `${a.displayName} (${platformName(a.platform)})`)).join(", ")}
        </p>
      )}
    </section>
  );
}

/**
 * The person's label, their name, with their next name beneath it when they have one (see displayName); muted when
 * they are untouched (untouched.ts).
 */
function PersonLabel({ person }: { person: { id: number; name: string; aliases: readonly string[]; untouched?: boolean } }) {
  const { primary, secondary } = useNames().label(person);
  return (
    <>
      {person.untouched ? <span className="person-label--untouched" title={UNTOUCHED_HINT}><Name text={primary} /></span> : <Name text={primary} />}
      {secondary && <span className="person-label__full muted">{secondary}</span>}
    </>
  );
}

/**
 * Loads the person by id (one small request: their row, accounts and stored
 * counts), showing the preview meanwhile. A person merged away is gone, and
 * `onGone`, where given, is told so.
 */
function OpenPerson({ id, preview, onOpenPerson, onGone, ...rest }: {
  id: number;
  moment: ChatMoment | undefined;
  tagNames: string[] | undefined;
  locations: LocationInfo[] | undefined;
  preview: PersonPreview | undefined;
  onMerged: (survivor: PersonSummary) => void;
  /** Opens someone else from this person's panel, who becomes a step back from them. */
  onOpenPerson: (from: PersonStep, to: number) => void;
  onGroup?: (groupId: number | null) => void;
  onGone?: () => void;
}) {
  // With new messages too: their counts, when you last spoke, and the chat's newest messages follow them.
  const person = useArchive(() => archiveApi.person(id), [id], { messages: true });
  const names = useNames();
  const gone = person.unavailable;
  // Told once, when found gone: not again each time the panel draws.
  const tell = useRef(onGone);
  tell.current = onGone;
  useEffect(() => {
    if (gone) tell.current?.();
  }, [gone]);
  if (person.data) {
    const from = person.data;
    return <PersonView person={from} {...rest} onOpenPerson={(to) => onOpenPerson({ id: from.id, name: from.name, aliases: from.aliases }, to)} />;
  }
  if (preview && !person.unavailable && !person.error) {
    return (
      <div className="person-view">
        <label className="field">
          <span>Names</span>
          <span className="person-name">
            <Identicon seed={preview.identiconSeed} hue={preview.identiconHue} size={32} />
            <input value={names.hidden ? names.label(preview).primary : preview.name} readOnly disabled />
          </span>
        </label>
        <TagChips tags={preview.tags} />
        <p className="muted">Loading…</p>
      </div>
    );
  }
  return <p className="muted">{person.unavailable ? "This person is no longer in the archive." : (person.error ?? "Loading…")}</p>;
}

/** The Tags label's tooltip: what the two tags the app acts on do. */
const TAGS_HINT = "“archive” takes them off the map and every map view (Events’ People table still lists them); “keep” stops the automatic rules archiving them.";

/** The Accounts heading's tooltip for someone joined by name. */
const JOINED_HINT = "Joined by name: these accounts have exactly the same name. If an account isn’t them, choose × (“Not them”) beside it; it won’t be joined with them again.";

/**
 * The person: who they are (name, aliases, tags, location, note), reaching out, catch-ups (time with them outside
 * messages, CatchUps.tsx), archiving and their accounts (with Join person at the right of their heading), then Events: how close
 * you have been each month all time (ActivityChart.tsx), their hangouts (CatchUps.tsx), the group chats they are in, and the chat under Messages.
 * Accounts, Hangouts, Group chats and Messages are closed whenever a panel opens, nothing remembered from the last
 * one, and stay as chosen while it is open; their messages load only once Messages is opened. Opened at a moment, Messages
 * opens, to show it. A group chat
 * opened from the list, or from its name on a message, takes the chat's place
 * until you go back (GroupChat.tsx), and so does one account's own chat, opened
 * beside it in Accounts (to see who it really is); the rest of the panel stays as it is. On a
 * read-only page (readOnly.ts) each part shows and changes nothing, and there is no Join person.
 */
export function PersonView({ person, moment, tagNames, locations, onMerged, onOpenPerson, onGroup }: {
  person: PersonSummary;
  /** Where their chat opens, and what it marks there, in place of its newest message: the chat comes back to it whenever it changes. */
  moment?: ChatMoment;
  /** Every tag in the tag table, in order: the suggestions for adding one. */
  tagNames: string[] | undefined;
  /** Each field's values, the most used first: the suggestions for location. */
  locations: LocationInfo[] | undefined;
  onMerged: (survivor: PersonSummary) => void;
  /** Opens someone else's panel (a member of an open group chat). */
  onOpenPerson: (id: number) => void;
  /** Told which group chat is open in place of their chat (null for none), as it changes, and null once the panel goes. */
  onGroup?: (groupId: number | null) => void;
}) {
  const suggestions = tagNames ?? [ARCHIVE_TAG, KEEP_TAG];
  // One-to-one messages only, unless group messages are asked for (for the rest of the visit, not kept in the browser).
  const [groups, setGroups] = useShowGroups();
  // The group chat open in place of their chat, if any.
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  const tellGroup = useRef(onGroup);
  tellGroup.current = onGroup;
  useEffect(() => {
    tellGroup.current?.(openGroup);
    return () => tellGroup.current?.(null);
  }, [openGroup]);
  // The account whose own chat is open in place of theirs, if any, while it is still theirs ("Not them" takes it away).
  const [openAccountId, setOpenAccountId] = useState<number | null>(null);
  // Each closed whenever a panel opens (it opens anew for each person), and kept while it is open: a group chat or an
  // account's chat in place of theirs, and back, leaves them as they were.
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [hangoutsOpen, setHangoutsOpen] = useState(false);
  const [groupChatsOpen, setGroupChatsOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(moment !== undefined);
  // Opened at another moment: back to their chat, at it.
  const atMoment = momentKey(moment);
  const [lastMoment, setLastMoment] = useState(atMoment);
  if (atMoment !== lastMoment) {
    setLastMoment(atMoment);
    setOpenGroup(null);
    setOpenAccountId(null);
    if (moment) setMessagesOpen(true);
  }
  const openAccount = person.accounts.find((a) => a.id === openAccountId) ?? null;
  const names = useNames();
  // What the chat shows of theirs and yours: one-to-one, and group chats' too when they are shown (Marketplace's never counted).
  const shownMessages = person.directMessageCount + (groups ? person.groupMessageCount : 0);
  const theirMessages = names.label(person).primary ? `Messages with ${names.label(person).primary}` : "Their messages";
  const readOnly = useReadOnly();
  // Theirs, the latest first: listed under Hangouts in Events, and in the chat.
  const catchUps = useArchive(() => archiveApi.catchUps(person.id), [person.id]);
  // Their calls (the phone's call history), newest first: in the chat at their time, and added up in Accounts.
  const calls = useArchive(() => archiveApi.calls(person.id), [person.id]);
  const openAccountCalls = useMemo(() => (calls.data ?? []).filter((call) => call.accountId === openAccount?.id), [calls.data, openAccount?.id]);
  return (
    <div className="person-view">
      <NamesField person={person} />
      <div className="field">
        <span title={readOnly ? undefined : TAGS_HINT}>Tags</span>
        <TagEditor person={person} suggestions={suggestions} />
      </div>
      <div className="field">
        <span>Location</span>
        <PlaceEditor key={`${person.id}:${person.location}`} person={person} values={locations} />
      </div>
      <div className="field">
        <span>Note</span>
        <NoteEditor key={`${person.id}:${person.note}`} person={person} />
        {person.noteFromContacts && (
          <span className="muted field__hint">From your iPhone contacts; once you change it, it is yours and the contacts never write over it.</span>
        )}
      </div>
      <div className="field">
        <ReachOutSwitch person={person} />
      </div>
      <ArchivedNote person={person} />
      {!readOnly && (
        <div className="person-view__actions">
          <ArchiveButton person={person} />
        </div>
      )}
      <div className="field">
        <span className="field__head">
          <button
            type="button"
            className="field__toggle"
            aria-expanded={accountsOpen}
            title={person.joined && !readOnly ? JOINED_HINT : undefined}
            onClick={() => setAccountsOpen(!accountsOpen)}
          >
            <span aria-hidden="true">{accountsOpen ? "▾" : "▸"}</span> Accounts · {person.accounts.length}
          </button>
          <JoinPerson person={person} onJoined={onMerged} />
        </span>
        {accountsOpen && (
          <AccountList
            person={person}
            groups={groups}
            calls={calls.data}
            openAccount={openAccount?.id ?? null}
            onOpen={(id) => {
              setOpenGroup(null);
              setOpenAccountId(id === openAccount?.id ? null : id);
            }}
          />
        )}
        {accountsOpen && person.unknown && (
          <span className="muted field__hint">
            The platform shows a deleted or unknown account this way, so it is never proposed for a merge. Each one, or each chat with one,
            is kept as a separate person, except Discord’s “Deleted User”, one person for them all, so joining it joins them all. If you know who this is,
            join them into that person with “Join person” beside Accounts, archived or not.
          </span>
        )}
      </div>
      <section className="notes">
        {openGroup !== null ? (
          <GroupChat
            key={openGroup}
            groupId={openGroup}
            back={openAccount ? accountName(openAccount, names) : theirMessages}
            onBack={() => setOpenGroup(null)}
            onOpenPerson={onOpenPerson}
          />
        ) : openAccount ? (
          <>
            <button type="button" className="link-button group-chat__back" onClick={() => setOpenAccountId(null)}>← {theirMessages}</button>
            <Timeline
              title={
                <>
                  <span className="platform-badge">{platformName(openAccount.platform)}</span>{" "}
                  <Name text={names.shown(openAccount.displayName)} />
                  {!groups && person.groupMessageCount > 0 && <span className="muted"> · one-to-one</span>}
                </>
              }
              key={`account:${openAccount.id}`}
              source={{ person: person.id, groups, account: openAccount.id }}
              calls={openAccountCalls}
              version={`${openAccount.messageCount}:${openAccount.lastMessageAt}`}
              onOpenGroup={setOpenGroup}
            />
          </>
        ) : (
          <>
            <Timeline
              title={<>Events{!groups && person.groupMessageCount > 0 && <span className="muted"> · one-to-one</span>}</>}
              key={`${person.id}:${atMoment}`}
              source={{ person: person.id, groups }}
              moment={moment}
              calls={calls.data}
              catchUps={catchUps.data && { list: catchUps.data, person }}
              version={`${person.messageCount}:${person.marketplaceMessageCount}:${person.lastMessageAt}`}
              marketplaceCount={person.marketplaceMessageCount}
              onOpenGroup={setOpenGroup}
              fold={{
                label: `Messages · ${shownMessages.toLocaleString(locale())}`,
                open: messagesOpen,
                onChange: setMessagesOpen,
                // Inside Messages, beside "Load all": it shows only once Messages is opened, though it changes the chart above too.
                tools: person.groupMessageCount > 0 && (
                  <label className="show-groups muted" title="Their messages in group chats you are both in, and yours there, in the chart; theirs in the counts and the chat below">
                    <input type="checkbox" checked={groups} onChange={(e) => setGroups(e.target.checked)} />
                    Show group messages ({person.groupMessageCount.toLocaleString(locale())} from them)
                  </label>
                ),
              }}
            >
              <ActivityChart personId={person.id} groups={groups} />
              {/* Hangouts and group chats are the backend's `panel`, drafts its `drafts` (src/contract/handshake.ts). */}
              {offers("panel") && <CatchUpsField person={person} catchUps={catchUps.data} open={hangoutsOpen} onToggle={setHangoutsOpen} onOpenPerson={onOpenPerson} />}
              {offers("panel") && <PersonGroups person={person} open={groupChatsOpen} onToggle={setGroupChatsOpen} onOpen={setOpenGroup} />}
            </Timeline>
            {offers("drafts") && <DraftBox key={`draft:${person.id}`} personId={person.id} />}
          </>
        )}
      </section>
    </div>
  );
}

function isGroupOnly(person: PersonSummary): boolean {
  return person.directMessageCount === 0 && person.groupMessageCount > 0;
}
