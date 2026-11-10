// The Query bar under the header of Orbits and the other live map views: one box, where
// you say who to show in words (plain text: you dictate into it), and
// Hide, together at the right (the Table's once; the maps' own since it folded into Events' Tables). Its placeholder is "Query in natural language".
// Enter (or the go button inside the box, at its right edge, pressable only
// with words in it) has the model write a SQL query from the words (POST
// /api/archive/query/generate) and runs it straight away: the view shows those
// people and the line under the box says how many show after Hide and what the model
// could not put in the query, or nothing changes and the line says why. The
// query itself is never shown. Shift and Enter is a new line; Esc puts back the
// words of the query that ran. × (while the box holds words or a query is on)
// goes back to everyone. With a backend that has no model (no `query.generate`,
// docs/contract.md), the words are the query: the query language, run as typed.
// The box grows wider with its longest line, into the bar's free width, and
// grows down over the page to show all it holds while typed in; the line under
// it moves down with it. The query runs in the server (GET /api/archive/query)
// over everyone, archived people too, and runs again whenever people or
// messages change; one that stops running (a tag deleted, say) leaves nobody
// shown until it is changed. Hide (HidePanel.tsx) is the last gate, after the
// query. The bar takes the view's Hide: each query, and the query again
// whenever Hide changes, is counted under Hide, and the line says how many it
// shows after Hide as it was when the query ran; Hide changing later leaves the line as it was. On the map the bar also takes
// a limit: a query that would show more than the limit after Hide is refused
// before any of it loads, the view keeping what it shows; the box turns red, the
// line saying why, until the words or Hide change.

import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ArchiveError, archiveApi } from "../archiveApi.ts";
import { offers } from "../contract/handshake.ts";
import { onArchiveChanged } from "../useArchive.ts";
import { hiddenTags, type HideChoices } from "./hideChoices.ts";
import { number } from "./view.tsx";
import {
  answered, canGo, EVERYONE, initialQueryBar, keyAction, loadQuery, nextShown, QUERY_KEYS, queryBarReducer, saveQuery,
  type Filter, type QueryBarAction, type QueryBarState, type RunReason, type Shown, type TranscriptExample, type ViewScope,
} from "./queryBar.ts";

/** The bar's state, and who the query that ran matches. */
export interface QueryBarHandle {
  state: QueryBarState;
  dispatch: (action: QueryBarAction) => void;
  /** Runs a filter as the query the view shows (EVERYONE for everyone). */
  run: (filter: Filter, why: RunReason) => void;
  /** Writes a query from the box's words and runs it. */
  generate: () => void;
  /** ×: back to everyone. */
  clear: () => void;
  /** The ids the query that ran matches: null with none (everyone), undefined until it has run. */
  only: ReadonlySet<number> | null | undefined;
  /** With a gate, the Hide choices `only` was counted under, for the view to show with it; until then, Hide's defaults. */
  hide: HideChoices;
  /** How many times you have re-queried (Shown in queryBar.ts): the Spider web replays its scan for each. */
  requery: number;
}

/**
 * A view's gate: its Hide choices, and on the map the most people it draws. A
 * query that would show more after Hide is refused, and so is a change of Hide that would.
 */
export interface QueryGate {
  hide: HideChoices;
  limit?: number;
}

const reasonOf = (error: unknown) => (error instanceof ArchiveError ? error.reason : String(error));

/** The Query bar for a view, starting from the query that last ran there; with `gate`, counting under its Hide and refusing to show too many. */
export function useQueryBar(scope: ViewScope, gate?: QueryGate): QueryBarHandle {
  const keys = QUERY_KEYS[scope];
  const [state, dispatch] = useReducer(queryBarReducer, keys, (k) => initialQueryBar(loadQuery(k)));
  // With a gate nothing shows until the first query is counted, the empty one too.
  const [shown, setShown] = useState<Shown>(() => ({ only: state.applied.query || gate ? undefined : null, hide: {}, requery: 0 }));
  const only = shown.only;
  const gated = useRef(gate);
  gated.current = gate;
  /**
   * `applied`: the filter that ran, as soon as it has. `runs` and `reruns` count
   * the runs asked for, so only the latest of each shows; a query run again
   * shows only while it is still the one that ran, so it never undoes a newer one.
   * `asks` counts Generate's questions and ×, so Generate's answer shows only if nothing came after it.
   */
  // `lineHide`: the Hide the line was counted under, so a run again under another Hide leaves it as it was.
  const hideKeyOf = (g: QueryGate | undefined) => (g ? JSON.stringify(hiddenTags(g.hide)) : null);
  const latest = useRef({ state, applied: state.applied, runs: 0, reruns: 0, asks: 0, lineHide: hideKeyOf(gate) });
  latest.current.state = state;

  /** Runs `given`; run "again", one that no longer runs leaves nobody. */
  const run = useCallback((given: Filter, why: RunReason) => {
    const filter = { ...given, query: given.query.trim() };
    const { query } = filter;
    const again = why === "again";
    const mine = again ? ++latest.current.reruns : ++latest.current.runs;
    const gate = gated.current;
    // Only the latest of its kind shows, and only while Hide is still what it was counted under.
    const current = () => (again ? mine === latest.current.reruns && query === latest.current.applied.query : mine === latest.current.runs)
      && gate?.hide === gated.current?.hide;
    const show = (matched: ReadonlySet<number> | null, ran: QueryBarAction) => {
      latest.current.applied = filter;
      setShown((last) => nextShown(last, matched, gate ? gate.hide : last.hide, why));
      // Counted under a Hide other than the line's, the line stays as it was (the reducer keeps it for "hide").
      const hideKey = hideKeyOf(gate);
      const keepsLine = ran.type === "ran" && latest.current.state.failed === null
        && (why === "hide" || (again && hideKey !== latest.current.lineHide));
      if (!keepsLine) latest.current.lineHide = hideKey;
      if (!(keepsLine && again)) dispatch(ran);
      saveQuery(keys, filter);
    };
    if (!query && !gate) return show(null, { type: "ran", filter, count: 0, why });
    archiveApi.query(query, gate ? hiddenTags(gate.hide) : undefined).then(
      (result) => {
        if (!current()) return;
        const action = answered(filter, result, gate?.limit, why);
        if (action.type === "refused") dispatch(action);
        else show(query ? new Set(result.ids) : null, action);
      },
      (error: unknown) => {
        if (!current()) return;
        dispatch({ type: "failed", filter, error: reasonOf(error) });
        if (again) setShown((last) => ({ ...last, only: new Set() }));
      },
    );
  }, [keys]);

  // The query that ran here last time, run again now, and whenever people or messages change.
  useEffect(() => {
    const again = () => run(latest.current.applied, "again");
    again();
    // With a gate, the empty query is counted again too: who is archived may have changed.
    return onArchiveChanged(() => (latest.current.applied.query || gated.current) && again(), { messages: true });
  }, [run]);

  // Hide changed: under a gate, the query is counted again under it, the one refused or failing if there is one
  // (ticking more in Hide may bring it under the limit), else the one that ran.
  const hideKey = gate ? JSON.stringify(hiddenTags(gate.hide)) : null;
  const firstHide = useRef(hideKey);
  useEffect(() => {
    if (hideKey === firstHide.current) return;
    firstHide.current = hideKey;
    const { failed, applied } = latest.current.state;
    dispatch({ type: "hide" });
    run(failed ?? applied, "hide");
  }, [hideKey, run]);

  const generate = useCallback(() => {
    const { transcript, generating } = latest.current.state;
    const said = transcript.trim();
    if (generating || !said) return;
    // A backend with no model to write queries (no `query.generate`) takes the query language as it is typed.
    if (!offers("query.generate")) return run({ query: said, said, note: "" }, "generate");
    const mine = ++latest.current.asks;
    dispatch({ type: "generating" });
    // Always a new query from the words: the box holds all of what is asked for.
    archiveApi.generateQuery("", said).then(
      ({ query, note }) => {
        if (mine !== latest.current.asks) return;
        // No query at all is nothing the model could say: nothing changes, and the note says why.
        if (!query.trim()) return dispatch({ type: "generateFailed", error: note || "no query could be written from that" });
        run({ query, said, note }, "generate");
      },
      (error: unknown) => {
        if (mine === latest.current.asks) dispatch({ type: "generateFailed", error: reasonOf(error) });
      },
    );
  }, [run]);

  const clear = useCallback(() => {
    latest.current.asks++;
    run(EVERYONE, "clear");
  }, [run]);

  return { state, dispatch, run, generate, clear, only, hide: shown.hide, requery: shown.requery };
}

/**
 * The bar: the box with the line under it, then `hide` (the Hide button). With
 * `examples` (the static demo, which has no model), the box only shows the example picked, and its go button opens
 * the list of examples in place of Generate. With `count` (the map views), the line says how many are shown
 * whenever everyone shows ("702 people"), in place of saying nothing or "Everyone shows.".
 */
export function QueryBar({ bar, hide, examples, count }: { bar: QueryBarHandle; hide?: ReactNode; examples?: readonly TranscriptExample[]; count?: number }) {
  const { state, dispatch, run, generate, clear } = bar;
  const pickExample = (example: TranscriptExample) => run({ query: example.query, said: example.transcript, note: "" }, "generate");
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = keyAction(state, event);
    if (!action) return;
    event.preventDefault();
    if (action === "revert") dispatch({ type: "revert" });
    if (action === "go") {
      event.currentTarget.blur();
      generate();
    }
  };
  const on = state.applied.query !== "";
  const clearable = state.transcript !== "" || on;
  const unsaid = on && state.transcript.trim() !== state.applied.said.trim();
  // The line: what the query matched or why it failed, else (with `count`) how many are shown.
  const counted = count !== undefined && (state.status === null || (state.status.kind === "info" && !on));
  const status = counted ? { kind: "info" as const, text: `${number(count)} ${count === 1 ? "person" : "people"}` } : state.status;
  return (
    // A query that did not run or was refused turns the box (and Hide) red (demos.css), until the words or Hide change.
    <div className={`query-bar${state.failed !== null ? " query-bar--failed" : ""}`} role="search" aria-label="Query">
      <div
        className="query-bar__box query-bar__box--transcript"
        style={{ "--box-chars": Math.max(...state.transcript.split("\n").map((line) => line.length)) } as CSSProperties}
      >
        {/* The line under the box moves down as the box grows. */}
        <div className="query-bar__stack">
          <div className="query-bar__field">
            <textarea
              className={`query-bar__transcript${on ? " query-bar__transcript--on" : ""}`}
              aria-label="Transcript"
              placeholder={examples ? "Example transcripts" : offers("query.generate") ? "Query in natural language" : "Query: climbing AND location:berlin"}
              readOnly={examples !== undefined}
              rows={1}
              value={state.transcript}
              title={unsaid ? "Press Enter to show who this says (Esc puts back the words that are showing)" : undefined}
              onChange={(event) => dispatch({ type: "transcript", transcript: event.target.value })}
              onKeyDown={examples ? undefined : onKeyDown}
            />
            {examples ? (
              <ExamplePicker examples={examples} clearable={clearable} onClear={clear} onPick={pickExample} />
            ) : (
              <BoxButtons
                clearable={clearable}
                onClear={clear}
                canGo={canGo(state)}
                busy={state.generating}
                goTitle={state.generating ? "Generating…" : offers("query.generate") ? "Show who this says: a model writes the query and runs it" : "Show who this query matches"}
                onGo={generate}
              />
            )}
          </div>
          {status && (
            <p className={`query-bar__status${status.kind === "error" ? " query-bar__status--error" : ""}`} role={status.kind === "error" ? "alert" : "status"}>
              {status.text.charAt(0).toUpperCase() + status.text.slice(1)}
            </p>
          )}
        </div>
      </div>
      {hide}
    </div>
  );
}

/** The ×, while there is something to clear: back to everyone. */
const CLEAR_TITLE = "Clear: everyone shows";

/** The box's buttons, inside it at its right edge: × while `clearable`, then go (a tick), pressable as `canGo` says. */
function BoxButtons({ clearable, onClear, canGo, busy, goTitle, onGo }: {
  clearable: boolean;
  onClear: () => void;
  canGo: boolean;
  busy: boolean;
  goTitle: string;
  onGo: () => void;
}) {
  return (
    <div className="query-bar__buttons">
      {clearable && (
        <button type="button" className="query-bar__clear" aria-label={CLEAR_TITLE} title={CLEAR_TITLE} onClick={onClear}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className={`query-bar__go${busy ? " query-bar__go--busy" : ""}`}
        aria-label={goTitle}
        title={goTitle}
        aria-busy={busy || undefined}
        disabled={!canGo}
        onClick={onGo}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

/**
 * In place of Generate where there is no model (the static demo): the box's
 * buttons are × while an example is on, and a list button that opens the
 * examples under the box, each with the query it becomes; picking one shows its
 * words in the box and runs its query. Esc or a click elsewhere closes the list.
 */
function ExamplePicker({ examples, clearable, onClear, onPick }: {
  examples: readonly TranscriptExample[];
  clearable: boolean;
  onClear: () => void;
  onPick: (example: TranscriptExample) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const title = "Examples: in the app you say what you want here, and a model writes the query";
  return (
    <div className="query-bar__examples" ref={ref}>
      <div className="query-bar__buttons">
        {clearable && (
          <button type="button" className="query-bar__clear" aria-label={CLEAR_TITLE} title={CLEAR_TITLE} onClick={onClear}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <button type="button" className="query-bar__go" aria-label={title} title={title} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M3 4 H11 M3 7 H11 M3 10 H8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="tag-filter__panel query-bar__examples-panel" role="dialog" aria-label="Example transcripts">
          <p className="query-bar__examples-note">Examples. In the app you say what you want here, and a model writes the query.</p>
          <ul>
            {examples.map((example) => (
              <li key={example.query}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onPick(example);
                  }}
                >
                  <span>{example.transcript}</span>
                  <code>{example.query}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
