// What the console shows in place of a page that failed, so the failure stays on that page and the rest of the console
// goes on: a module whose viewer.tsx did not load (moduleFailed, viewer/modules.ts) is a page of its own in the rail
// saying so, and a view that throws as it is drawn (ViewBoundary, Console.tsx) shows why in its place.

import { Component, type ReactNode } from "react";
import type { ViewerDefinition } from "../../sdk/viewer.ts";
import { Card } from "./blocks.tsx";

/** The notice in a failed page's place: what failed, why, and that the rest of the archive is unaffected. */
export function ViewFailed({ what, why }: { what: string; why: string }) {
  return (
    <Card title={`${what} could not be shown`}>
      <p style={{ margin: "0 0 10px", color: "var(--c-muted)" }}>The rest of the archive works as usual. The browser's console has the detail; the error was:</p>
      <pre style={{ margin: 0, fontFamily: "var(--c-mono)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{why}</pre>
    </Card>
  );
}

/** A module's id as a name ("friend-map" as "Friend map"). */
const named = (id: string) => (id.charAt(0).toUpperCase() + id.slice(1)).replace(/-/g, " ");

/**
 * The page of the module `id`, whose viewer.tsx did not load (`why`), saying so: an aspect at each of `pages` (its
 * pages' keys; its id when none is known), its one view under `under` (those aspects, or another page's for a module
 * with no page of its own).
 */
export function moduleFailed(id: string, why: string, pages: readonly string[] = [id], under: readonly string[] = pages): ViewerDefinition {
  const label = named(id);
  return {
    aspects: pages.map((key) => ({ key, label, icon: "close", blurb: `The ${label} module's page did not load.` })),
    views: [
      {
        key: `${id}-failed`, label, aspects: [...under], section: `${id}-failed`, blurb: `Why the ${label} module's page did not load.`,
        component: () => <ViewFailed what={`The ${label} module's page`} why={why} />,
      },
    ],
  };
}

/**
 * Holds a view's failure as it is drawn to its own place: `what` and why it failed, in place of the view. `at` is the
 * place shown; moving to another forgets the failure, without remounting what is drawn (a view keeps its state as it did).
 */
export class ViewBoundary extends Component<{ at: string; what: string; children: ReactNode }, { at: string; failed?: string }> {
  state: { at: string; failed?: string } = { at: this.props.at };

  static getDerivedStateFromProps(props: { at: string }, state: { at: string }) {
    return props.at === state.at ? null : { at: props.at, failed: undefined };
  }

  static getDerivedStateFromError(cause: unknown): { failed: string } {
    return { failed: cause instanceof Error ? cause.message : String(cause) };
  }

  render() {
    return this.state.failed === undefined ? this.props.children : <ViewFailed what={this.props.what} why={this.state.failed} />;
  }
}
