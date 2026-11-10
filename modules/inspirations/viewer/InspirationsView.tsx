// The Inspirations page: the captain's saved things, by what they are about. Platforms, its first tab, is how many
// platforms they come from and how many each gives (the console draws it: `home`), each opening Recent narrowed to it.
// Recent is everything, newest first, or one platform's (and Hidden, behind a switch); an old link to Recent at the
// first tab's address (a page, an item open) goes on to Recent. By tag narrows to every tag picked, his own or, switched over, the AI's (never mixed);
// Search finds words in his caption, the title, author, description, link and both kinds of tags; Untagged is what he
// has not tagged yet. Each list is in pages of 48, its page in the address. A card shows its picture first and its link;
// it opens its item at the right (from the bottom on a phone): its picture (an Instagram post's small kept picture,
// which loads the live embed from Instagram only when clicked), its link out, his caption and his tags to edit, the
// AI's tags apart (with the model, and Make again), every save, and Hide. Tags is his
// vocabulary (rename, onto another to merge; what each covers; order; delete), and Changes the changesets of
// inspirations, each with Undo; every edit's notice offers Undo at once. Everything here is metadata (docs/features.md's
// "Inspirations"). The console (InspirationsSection.tsx) shows it under its Inspirations aspect: it
// gives the tabs' addresses there (`tabPath`) and draws its own blocks above from the counts the view fetched (`above`).

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ChangesetInfo } from "../../../sdk/contract.ts";
import { countText, dateText, timeText } from "../../../sdk/viewer.ts";
import type { InspirationDetail, InspirationFilter, InspirationSaved, InspirationSummary, InspirationTagsAnswer, TagKind } from "../wire.ts";
import {
  addTag,
  askAiTagsAgain,
  changeTag,
  deleteTag,
  fetchChanges,
  fetchItem,
  fetchItems,
  fetchTags,
  fileUrl,
  saveCaption,
  saveHidden,
  saveTags,
  undoChange,
} from "./api.ts";
import { instagramCode, instagramEmbed, itemName, originLabel, platformLabel, shortLink, sourceLabel, typedTags } from "./format.ts";
import {
  asksForRecent,
  INSPIRATIONS_TABS,
  inspirationsAddress,
  openItemOf,
  PAGE_SIZE,
  pageCount,
  pageNumbers,
  pageOf,
  tabFilter,
  type InspirationsTab,
} from "./tabs.ts";

const RECENT_TAB = INSPIRATIONS_TABS.find((t) => t.key === "recent")!;

/** A change just made, offered to undo. */
interface Notice {
  text: string;
  changeset: number | null;
}

export function InspirationsView({
  tab,
  tabPath,
  above,
  home,
}: {
  tab: InspirationsTab;
  /** The address of each tab (the console's). */
  tabPath: (tab: InspirationsTab) => string;
  /** Drawn above the tab from the counts and tags, once they have come (the console's blocks). */
  above: (tags: InspirationTagsAnswer) => ReactNode;
  /** Platforms, the first tab, drawn from the counts (the console's chart). */
  home: (tags: InspirationTagsAnswer) => ReactNode;
}) {
  const top = useRef<HTMLDivElement>(null);
  // An old link to Recent, from when it was the first tab's address: on to Recent, the query kept, in the address's
  // place. The console is told on the next turn: on a first load its listener is not there yet (a child's effects run
  // before its parent's).
  const toRecent = tab.key === "" && asksForRecent(location.search);
  useEffect(() => {
    if (!toRecent) return;
    history.replaceState(null, "", tabPath(RECENT_TAB) + location.search);
    const later = setTimeout(() => dispatchEvent(new PopStateEvent("popstate")));
    return () => clearTimeout(later);
  }, [toRecent, tabPath]);
  // The query's part of the address (the filters and the item open), followed as the back button moves it.
  const [search, setSearch] = useState(() => location.search);
  useEffect(() => {
    const back = () => setSearch(location.search);
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);
  useEffect(() => setSearch(location.search), [tab]);
  const filter = useMemo(() => tabFilter(tab, search), [tab, search]);
  const open = openItemOf(search);
  const page = pageOf(search);
  // A new filter starts at the list's first page; opening or closing an item keeps the page.
  const go = useCallback(
    (next: InspirationFilter, item: number | null, { replace = false, page = 1 } = {}) => {
      const address = inspirationsAddress(tabPath(tab), tab, next, item, page);
      if (address !== location.pathname + location.search) history[replace ? "replaceState" : "pushState"](null, "", address);
      setSearch(location.search);
    },
    [tab, tabPath],
  );

  // Every change made here (or seen when the page comes back into view) asks again.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const back = () => document.hidden || refresh();
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [refresh]);

  const [tags, setTags] = useState<InspirationTagsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetchTags(abort.signal)
      .then((answer) => {
        setTags(answer);
        setError(null);
      })
      .catch((e: Error) => abort.signal.aborted || setError(e.message));
    return () => abort.abort();
  }, [version]);

  const [notice, setNotice] = useState<Notice | null>(null);
  const done = useCallback(
    (next: Notice) => {
      setNotice(next);
      refresh();
    },
    [refresh],
  );
  const undo = async (changeset: number) => {
    try {
      await undoChange(changeset);
      setNotice({ text: `Undone (#${changeset}).`, changeset: null });
      refresh();
    } catch (e) {
      setNotice({ text: (e as Error).message, changeset: null });
    }
  };

  useEffect(() => {
    document.title = `${tab.label} · Inspirations · Life archive`;
  }, [tab]);

  if (toRecent) return null;

  let body: ReactNode;
  switch (tab.key) {
    case "":
      body = tags && home(tags);
      break;
    case "tags":
      body = tags && <TagManager tags={tags} onDone={done} />;
      break;
    case "changes":
      body = <ChangesList version={version} onUndo={undo} />;
      break;
    default:
      body = (
        <>
          {tab.key === "by-tag" && tags && <TagPicker tags={tags} filter={filter} onChange={(next) => go(next, null)} />}
          {tab.key === "search" && <SearchBox filter={filter} onChange={(next) => go(next, null, { replace: true })} />}
          {(tab.key !== "search" || filter.q.trim()) && (tab.key !== "by-tag" || filter.tags.length > 0) ? (
            <ItemList
              filter={filter}
              page={page}
              version={version}
              counted={tab.key !== "recent" || filter.hidden || filter.platform !== ""}
              onOpen={(id) => go(filter, id, { page })}
              onPage={(next, replace = false) => {
                go(filter, null, { page: next, replace });
                // The page scrolls inside its frame, not the window: its top back in view.
                if (!replace) top.current?.scrollIntoView({ block: "start" });
              }}
            />
          ) : (
            <p className="insp__hint">{tab.key === "search" ? "Type a word: it is looked for in your words, the title, author, description, link and tags." : "Pick one tag or more: the items with all of them are listed."}</p>
          )}
        </>
      );
  }

  return (
    <div className="insp" ref={top}>
      {tags && above(tags)}
      <div className="insp__top">
        {(!tags || error) && <p className="insp__meta">{error ?? "Loading…"}</p>}
        {tab.key === "recent" && filter.platform && (
          <button type="button" className="insp__tag insp__only" aria-pressed="true" title="Every platform's again" onClick={() => go({ ...filter, platform: "" }, null)}>
            {platformLabel(filter.platform)} only <span aria-hidden="true">✕</span>
          </button>
        )}
        {(tab.key === "recent" || tab.key === "by-tag" || tab.key === "search") && (
          <label className="insp__switch">
            <input type="checkbox" checked={filter.hidden} onChange={(event) => go({ ...filter, hidden: event.target.checked }, null)} />
            Hidden instead
          </label>
        )}
      </div>
      {notice && (
        <p className="insp__notice" role="status">
          {notice.text}
          {notice.changeset !== null && (
            <button type="button" className="insp__button" onClick={() => undo(notice.changeset!)}>
              Undo
            </button>
          )}
          <button type="button" className="insp__dismiss" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ✕
          </button>
        </p>
      )}
      {body}
      {open !== null && <ItemPanel id={open} version={version} vocabulary={tags?.tags.map((t) => t.name) ?? []} onClose={() => go(filter, null, { page })} onDone={done} />}
    </div>
  );
}

/** By tag's picker: his tags or the AI's, each with how many items have it; picking several narrows to items with all. */
function TagPicker({ tags, filter, onChange }: { tags: InspirationTagsAnswer; filter: InspirationFilter; onChange: (next: InspirationFilter) => void }) {
  const choices = filter.tagKind === "ai" ? tags.aiTags : tags.tags;
  const toggle = (name: string) =>
    onChange({ ...filter, tags: filter.tags.includes(name) ? filter.tags.filter((tag) => tag !== name) : [...filter.tags, name] });
  const kind = (tagKind: TagKind) => onChange({ ...filter, tagKind, tags: [] });
  return (
    <div className="insp__picker">
      <div className="insp__kinds" role="group" aria-label="Which tags">
        <button type="button" aria-pressed={filter.tagKind === "manual"} onClick={() => kind("manual")}>
          My tags
        </button>
        <button type="button" aria-pressed={filter.tagKind === "ai"} onClick={() => kind("ai")}>
          AI tags
        </button>
      </div>
      <div className="insp__chips">
        {choices.length === 0 && <span className="insp__hint">{filter.tagKind === "ai" ? "No AI tags yet." : "No tags yet: add them on an item, or in Tags."}</span>}
        {choices.map((tag) => (
          <button
            key={tag.name}
            type="button"
            className={`insp__tag${filter.tagKind === "ai" ? " insp__tag--ai" : ""}`}
            aria-pressed={filter.tags.includes(tag.name)}
            onClick={() => toggle(tag.name)}
          >
            {tag.name} <span className="insp__count">{tag.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SearchBox({ filter, onChange }: { filter: InspirationFilter; onChange: (next: InspirationFilter) => void }) {
  const [text, setText] = useState(filter.q);
  // The address follows a moment after typing stops.
  useEffect(() => {
    if (text === filter.q) return;
    const later = setTimeout(() => onChange({ ...filter, q: text }), 250);
    return () => clearTimeout(later);
  }, [text]);
  return (
    <input
      className="insp__search"
      type="search"
      placeholder="Search your inspirations"
      aria-label="Search your inspirations"
      value={text}
      autoFocus
      onChange={(event) => setText(event.target.value)}
    />
  );
}

/** A list's items, newest first, a page of PAGE_SIZE at a time. */
function ItemList({ filter, page, version, counted, onOpen, onPage }: {
  filter: InspirationFilter;
  page: number;
  version: number;
  counted: boolean;
  onOpen: (id: number) => void;
  onPage: (page: number, replace?: boolean) => void;
}) {
  const [items, setItems] = useState<InspirationSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(filter);
  useEffect(() => {
    const abort = new AbortController();
    fetchItems(filter, (page - 1) * PAGE_SIZE, PAGE_SIZE, abort.signal)
      .then((answer) => {
        setItems(answer.items);
        setTotal(answer.total);
        setError(null);
      })
      .catch((e: Error) => abort.signal.aborted || setError(e.message));
    return () => abort.abort();
  }, [key, page, version]);
  const pages = pageCount(total);
  // A page past the last (items hidden since, an old link) goes to the last.
  useEffect(() => {
    if (items && items.length === 0 && total > 0 && page > pages) onPage(pages, true);
  }, [items, total, page, pages]);
  if (error) return <p className="viewer__error">{error}</p>;
  if (!items) return <p className="insp__hint">Loading…</p>;
  if (items.length === 0) return <p className="insp__hint">{total > 0 ? "Loading…" : filter.hidden ? "Nothing hidden here." : "Nothing here yet."}</p>;
  const first = (page - 1) * PAGE_SIZE + 1;
  return (
    <>
      {(counted || pages > 1) && (
        <p className="insp__meta">
          {pages > 1 ? `${countText(first)}–${countText(first + items.length - 1)} of ${countText(total)}` : `${countText(total)} ${total === 1 ? "item" : "items"}`}
        </p>
      )}
      <ul className="insp__grid">
        {items.map((item) => (
          <li key={item.id}>
            <Card item={item} onOpen={() => onOpen(item.id)} />
          </li>
        ))}
      </ul>
      {pages > 1 && <Pager page={page} pages={pages} onPage={onPage} />}
    </>
  );
}

/** The list's pages: Newer and Older, and the pages by number around this one. */
function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  return (
    <nav className="insp__pager" aria-label="Pages">
      <button type="button" className="insp__button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ Newer
      </button>
      <span className="insp__pages">
        {pageNumbers(page, pages).map((n, i) =>
          n === null ? (
            <span key={`gap${i}`} className="insp__gap">
              …
            </span>
          ) : (
            <button key={n} type="button" className="insp__page" aria-current={n === page ? "page" : undefined} aria-label={`Page ${n}`} onClick={() => onPage(n)}>
              {n}
            </button>
          ),
        )}
      </span>
      <button type="button" className="insp__button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Older ›
      </button>
    </nav>
  );
}

function Picture({ item, className }: { item: Pick<InspirationSummary, "image" | "platform" | "form">; className: string }) {
  const [broken, setBroken] = useState(false);
  const src = item.image && !broken ? ("fileId" in item.image ? fileUrl(item.image.fileId) : item.image.url) : null;
  if (!src) return <div className={`${className} insp__picture--none`}>{sourceLabel(item)}</div>;
  return <img className={className} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

/** An item in the list: its picture first, what it is, his and the AI's tags; and its link, always there, beneath. */
function Card({ item, onOpen }: { item: InspirationSummary; onOpen: () => void }) {
  return (
    <div className="insp__card">
      <button type="button" className="insp__card-open" onClick={onOpen}>
        <Picture item={item} className="insp__picture" />
        <span className="insp__card-body">
          <span className="insp__name">{itemName(item)}</span>
          <span className="insp__source">
            {sourceLabel(item)}
            {item.author ? ` · ${item.author}` : ""} · {dateText(item.createdAt)}
            {item.probe && <span className="insp__probe-mark">{item.probe.result ? "PROBE · RESULT" : "PROBE ASKED"}</span>}
          </span>
          {item.caption && item.title && <span className="insp__caption">{item.caption.split("\n")[0]}</span>}
          {item.tags.length > 0 && (
            <span className="insp__chips">
              {item.tags.map((tag) => (
                <span key={tag} className="insp__tag">
                  {tag}
                </span>
              ))}
            </span>
          )}
          <span className="insp__chips" title="AI tags">
            <span className="insp__ai-mark">AI</span>
            {item.aiTags.map((tag) => (
              <span key={tag} className="insp__tag insp__tag--ai">
                {tag}
              </span>
            ))}
            {item.aiTags.length === 0 && <span className="insp__waiting">{item.aiState === "pending" ? "on their way" : "none"}</span>}
          </span>
        </span>
      </button>
      {item.link && (
        <a className="insp__card-link" href={item.link} target="_blank" rel="noreferrer noopener" title={item.link}>
          {shortLink(item.link)} ↗
        </a>
      )}
    </div>
  );
}

/**
 * An Instagram post in its item: its small kept picture (or its name, where none was found), and the post itself, live
 * from Instagram's embed page, only once he clicks it; no request goes to Instagram before.
 */
function InstagramPost({ item, code }: { item: InspirationDetail; code: string }) {
  const [live, setLive] = useState(false);
  const [height, setHeight] = useState(640);
  useEffect(() => setLive(false), [code]);
  // The embed says how tall it is (Instagram's MEASURE message), so the frame fits it without a scroll of its own.
  useEffect(() => {
    if (!live) return;
    const measure = (event: MessageEvent) => {
      if (event.origin !== "https://www.instagram.com") return;
      let data: unknown = event.data;
      try {
        if (typeof data === "string") data = JSON.parse(data);
      } catch {
        return;
      }
      const said = data as { type?: string; details?: { height?: unknown } } | null;
      if (said?.type === "MEASURE" && typeof said.details?.height === "number" && said.details.height > 100) setHeight(Math.min(1400, Math.ceil(said.details.height)));
    };
    addEventListener("message", measure);
    return () => removeEventListener("message", measure);
  }, [live]);
  if (live) {
    return (
      <iframe
        className="insp__embed"
        src={instagramEmbed(code)}
        title={`Instagram post ${code}`}
        style={{ height }}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        allow="encrypted-media; fullscreen; picture-in-picture"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <button type="button" className="insp__play" onClick={() => setLive(true)} aria-label="Show the post, live from Instagram">
      <Picture item={item} className="insp__hero" />
      <span className="insp__play-label">▶ Show the post from Instagram</span>
    </button>
  );
}

/** One item, at the right: everything known of it, his caption and tags to edit, the AI's apart, its saves, Hide. */
function ItemPanel({ id, version, vocabulary, onClose, onDone }: { id: number; version: number; vocabulary: string[]; onClose: () => void; onDone: (notice: Notice) => void }) {
  const [item, setItem] = useState<InspirationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // His words as he writes them; `editing` while they differ from what is saved, so a reload keeps them.
  const [caption, setCaption] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setEditing(false), [id]);
  useEffect(() => {
    const abort = new AbortController();
    fetchItem(id, abort.signal)
      .then((answer) => {
        setItem(answer);
        setError(null);
      })
      .catch((e: Error) => abort.signal.aborted || setError(e.message));
    return () => abort.abort();
  }, [id, version]);
  useEffect(() => {
    if (item && !editing) setCaption(item.caption);
  }, [item, editing]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  // While an item's AI tags are on their way, look again every few seconds.
  useEffect(() => {
    if (item?.aiState !== "pending") return;
    const later = setTimeout(() => {
      fetchItem(id).then(setItem, () => {});
    }, 4000);
    return () => clearTimeout(later);
  }, [item]);

  /** Makes an edit; whether it was made. */
  const write = async (what: string, work: () => Promise<InspirationSaved | InspirationDetail>): Promise<boolean> => {
    setBusy(true);
    try {
      const answer = await work();
      if ("changeset" in answer) {
        setItem(answer.item);
        if (answer.changeset !== null) onDone({ text: `${what}.`, changeset: answer.changeset });
      } else {
        setItem(answer);
        onDone({ text: `${what}.`, changeset: null });
      }
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="drawer insp__panel" aria-label="Inspiration">
      <header className="drawer__header">
        <h2>Inspiration</h2>
        <button type="button" className="drawer__close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      {error && <p className="viewer__error">{error}</p>}
      {!item && !error && <p className="drawer__note">Loading…</p>}
      {item && (
        <div className="drawer__body insp__detail">
          {instagramCode(item) ? <InstagramPost item={item} code={instagramCode(item)!} /> : <Picture item={item} className="insp__hero" />}
          <h3 className="insp__title">{itemName(item)}</h3>
          <p className="insp__source">
            {sourceLabel(item)}
            {item.author ? ` · ${item.author}` : ""}
            {item.hidden ? " · hidden" : ""}
          </p>
          {item.link && (
            <a className="insp__open" href={item.link} target="_blank" rel="noreferrer noopener">
              {item.platform === "web" ? "Open the page" : `Open on ${sourceLabel({ platform: item.platform, form: "other" })}`} ↗
              <span className="insp__url">{item.link}</span>
            </a>
          )}
          {item.platform === "instagram" && (
            <p className="insp__small">
              {item.previewState === "pending"
                ? `Its picture and author are on their way: fetched slowly from Instagram${item.previewNote ? ` (last try: ${item.previewNote})` : ""}.`
                : item.previewState === "done"
                  ? item.previewNote ? `From its embed page; ${item.previewNote}.` : "Its picture and author are from its public embed page."
                  : item.previewNote
                    ? `No picture: ${item.previewNote}.`
                    : "No picture yet: npm run archive -- inspiration instagram start asks for them."}
            </p>
          )}
          {item.description && <p className="insp__description">{item.description}</p>}

          <section className="insp__section">
            <h4>Your words</h4>
            <textarea className="insp__textarea" value={caption} rows={3} placeholder="How it makes you feel, why you kept it" onChange={(event) => {
              setCaption(event.target.value);
              setEditing(true);
            }} />
            {editing && caption.trim() !== item.caption && (
              <div className="insp__row">
                <button type="button" className="insp__button insp__button--go" disabled={busy} onClick={() => write("Saved your words", () => saveCaption(item.id, caption)).then((made) => made && setEditing(false))}>
                  Save
                </button>
                <button type="button" className="insp__button" onClick={() => setEditing(false)}>
                  Put back
                </button>
              </div>
            )}
          </section>

          <section className="insp__section">
            <h4>Your tags</h4>
            <TagEditor tags={item.tags} vocabulary={vocabulary} busy={busy} onSave={(next, what) => write(what, () => saveTags(item.id, next))} />
          </section>

          <section className="insp__section">
            <h4>AI tags</h4>
            <div className="insp__chips">
              {item.aiTags.map((tag) => (
                <span key={tag} className="insp__tag insp__tag--ai">
                  {tag}
                </span>
              ))}
              {item.aiTags.length === 0 && <span className="insp__hint">None yet.</span>}
            </div>
            <p className="insp__small">
              {item.ai.state === "pending"
                ? `On their way${item.ai.error ? ` (last try: ${item.ai.error})` : ""}.`
                : item.ai.state === "failed"
                  ? `Given up on: ${item.ai.error ?? "the AI could not answer"}.`
                  : `By ${item.ai.model ?? "the AI"}${item.ai.at ? `, ${dateText(item.ai.at)}` : ""}. Kept apart from yours.`}
              {item.ai.state !== "pending" && (
                <button type="button" className="insp__link" disabled={busy} onClick={() => write("Asked for the AI tags again", () => askAiTagsAgain(item.id))}>
                  Make again
                </button>
              )}
            </p>
          </section>

          {item.probe && (
            <section className="insp__section">
              <h4>Probe</h4>
              <p className="insp__small">
                {item.probe.requestedAt !== null
                  ? `Your words asked for something to be done, so FirstMate was asked for a probe on ${dateText(item.probe.requestedAt)}, ${timeText(item.probe.requestedAt)}.`
                  : "A probe's result was set on it by hand."}
                {item.probe.requestedAt !== null && !item.probe.result && " No result yet."}
              </p>
              {item.probe.result && (
                <a className="insp__open" href={item.probe.result} target="_blank" rel="noreferrer noopener">
                  See the probe's result{item.probe.resultAt !== null ? ` (${dateText(item.probe.resultAt)})` : ""} ↗
                  <span className="insp__url">{item.probe.result}</span>
                </a>
              )}
            </section>
          )}

          <section className="insp__section">
            <h4>{item.saves.length === 1 ? "Saved once" : `Saved ${item.saves.length} times`}</h4>
            <ul className="insp__saves">
              {item.saves.map((save) => (
                <li key={save.id}>
                  <span className="insp__small">
                    {save.savedAt === null ? "When unknown" : `${dateText(save.savedAt)}, ${timeText(save.savedAt)}`} · from {originLabel(save.origin)}
                  </span>
                  {save.caption && <span className="insp__said">“{save.caption}”</span>}
                </li>
              ))}
            </ul>
          </section>

          <div className="insp__row">
            <button type="button" className="insp__button" disabled={busy} onClick={() => write(item.hidden ? "Shown again" : "Hidden", () => saveHidden(item.id, !item.hidden))}>
              {item.hidden ? "Show again" : "Hide"}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

/** His tags on an item: each with × to take it off, and a box to add more (commas between), his vocabulary offered. */
function TagEditor({ tags, vocabulary, busy, onSave }: { tags: string[]; vocabulary: string[]; busy: boolean; onSave: (tags: string[], what: string) => void }) {
  const [text, setText] = useState("");
  const add = (event: FormEvent) => {
    event.preventDefault();
    const typed = typedTags(text).filter((tag) => !tags.includes(tag));
    if (typed.length === 0) return;
    setText("");
    onSave([...tags, ...typed], `Tagged ${typed.join(", ")}`);
  };
  const offered = vocabulary.filter((tag) => !tags.includes(tag));
  return (
    <>
      <div className="insp__chips">
        {tags.map((tag) => (
          <span key={tag} className="insp__tag insp__tag--mine">
            {tag}
            <button type="button" aria-label={`Take off ${tag}`} disabled={busy} onClick={() => onSave(tags.filter((t) => t !== tag), `Took off ${tag}`)}>
              ×
            </button>
          </span>
        ))}
        {tags.length === 0 && <span className="insp__hint">None yet.</span>}
      </div>
      <form className="insp__row" onSubmit={add}>
        <input className="insp__input" list="insp-vocabulary" value={text} placeholder="Add a tag (commas between)" aria-label="Add a tag" onChange={(event) => setText(event.target.value)} />
        <datalist id="insp-vocabulary">
          {offered.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
        <button type="submit" className="insp__button" disabled={busy || !text.trim()}>
          Add
        </button>
      </form>
      {offered.length > 0 && (
        <div className="insp__chips insp__offered">
          {offered.slice(0, 12).map((tag) => (
            <button key={tag} type="button" className="insp__tag insp__tag--offer" disabled={busy} onClick={() => onSave([...tags, tag], `Tagged ${tag}`)}>
              + {tag}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** His vocabulary: each tag renamed (onto another, the two merge), described, moved or deleted; and a new one. */
function TagManager({ tags, onDone }: { tags: InspirationTagsAnswer; onDone: (notice: Notice) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const act = async (what: string, work: () => Promise<{ changeset: number | null }>) => {
    try {
      const { changeset } = await work();
      setError(null);
      onDone({ text: `${what}.`, changeset });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="insp__manager">
      {error && <p className="viewer__error">{error}</p>}
      <form
        className="insp__row insp__new-tag"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          void act(`Added ${name.trim()}`, () => addTag(name, about)).then(() => {
            setName("");
            setAbout("");
          });
        }}
      >
        <input className="insp__input" value={name} placeholder="New tag" aria-label="New tag" onChange={(event) => setName(event.target.value)} />
        <input className="insp__input insp__input--wide" value={about} placeholder="What it covers (optional)" aria-label="What it covers" onChange={(event) => setAbout(event.target.value)} />
        <button type="submit" className="insp__button" disabled={!name.trim()}>
          Add
        </button>
      </form>
      {tags.tags.length === 0 && <p className="insp__hint">No tags yet.</p>}
      <ol className="insp__tag-list">
        {tags.tags.map((tag, i) => (
          <TagRow key={tag.name} tag={tag} first={i === 0} last={i === tags.tags.length - 1} position={i} others={tags.tags.map((t) => t.name)} onAct={act} />
        ))}
      </ol>
      {tags.aiTags.length > 0 && (
        <>
          <h4 className="insp__subhead">AI tags in use</h4>
          <div className="insp__chips">
            {tags.aiTags.map((tag) => (
              <span key={tag.name} className="insp__tag insp__tag--ai">
                {tag.name} <span className="insp__count">{tag.count}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TagRow({ tag, first, last, position, others, onAct }: {
  tag: InspirationTagsAnswer["tags"][number];
  first: boolean;
  last: boolean;
  position: number;
  others: string[];
  onAct: (what: string, work: () => Promise<{ changeset: number | null }>) => Promise<void>;
}) {
  const [name, setName] = useState(tag.name);
  const [about, setAbout] = useState(tag.description);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setName(tag.name), [tag.name]);
  useEffect(() => setAbout(tag.description), [tag.description]);
  const renamed = typedTags(name)[0] ?? "";
  const merging = renamed !== tag.name && others.includes(renamed);
  return (
    <li className="insp__tag-row">
      <div className="insp__row">
        <input className="insp__input" value={name} aria-label={`Name of ${tag.name}`} onChange={(event) => setName(event.target.value)} />
        <span className="insp__count">{tag.count} {tag.count === 1 ? "item" : "items"}</span>
        <span className="insp__moves">
          <button type="button" className="insp__button" aria-label={`Move ${tag.name} up`} disabled={first} onClick={() => onAct(`Moved ${tag.name}`, () => changeTag(tag.name, { position: position - 1 }))}>
            ↑
          </button>
          <button type="button" className="insp__button" aria-label={`Move ${tag.name} down`} disabled={last} onClick={() => onAct(`Moved ${tag.name}`, () => changeTag(tag.name, { position: position + 1 }))}>
            ↓
          </button>
        </span>
      </div>
      <input className="insp__input insp__input--wide" value={about} placeholder="What it covers" aria-label={`What ${tag.name} covers`} onChange={(event) => setAbout(event.target.value)} />
      <div className="insp__row">
        {renamed && renamed !== tag.name && (
          <button type="button" className="insp__button insp__button--go" onClick={() => onAct(merging ? `Merged ${tag.name} into ${renamed}` : `Renamed ${tag.name} to ${renamed}`, () => changeTag(tag.name, { name }))}>
            {merging ? `Merge into ${renamed}` : `Rename to ${renamed}`}
          </button>
        )}
        {about.trim() !== tag.description && (
          <button type="button" className="insp__button insp__button--go" onClick={() => onAct(`Described ${tag.name}`, () => changeTag(tag.name, { description: about }))}>
            Save what it covers
          </button>
        )}
        {deleting ? (
          <>
            <button type="button" className="insp__button insp__button--danger" onClick={() => onAct(`Deleted ${tag.name}`, () => deleteTag(tag.name))}>
              Delete from {tag.count} {tag.count === 1 ? "item" : "items"}
            </button>
            <button type="button" className="insp__button" onClick={() => setDeleting(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="insp__link" onClick={() => setDeleting(true)}>
            Delete…
          </button>
        )}
      </div>
    </li>
  );
}

/** The changesets of inspirations, newest first, each with what it did and Undo. */
function ChangesList({ version, onUndo }: { version: number; onUndo: (changeset: number) => Promise<void> }) {
  const [changes, setChanges] = useState<ChangesetInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetchChanges(abort.signal)
      .then((answer) => {
        setChanges(answer);
        setError(null);
      })
      .catch((e: Error) => abort.signal.aborted || setError(e.message));
    return () => abort.abort();
  }, [version]);
  if (error) return <p className="viewer__error">{error}</p>;
  if (!changes) return <p className="insp__hint">Loading…</p>;
  if (changes.length === 0) return <p className="insp__hint">No changes to inspirations yet (the change log keeps them 90 days).</p>;
  return (
    <ul className="insp__changes">
      {changes.map((change) => (
        <li key={change.id} className="insp__change">
          <div className="insp__row">
            <strong>#{change.id}</strong>
            <span className="insp__small">
              {dateText(change.at)}, {timeText(change.at)} · {change.surface === "app" ? "this page" : "the CLI"}
              {change.description ? ` · “${change.description}”` : ""}
            </span>
            {change.undoneBy !== null ? (
              <span className="insp__small">undone by #{change.undoneBy}</span>
            ) : (
              <button type="button" className="insp__button" onClick={() => onUndo(change.id)}>
                {change.undoes !== null ? "Redo" : "Undo"}
              </button>
            )}
          </div>
          <ul className="insp__lines">
            {change.other.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
