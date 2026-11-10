// --redacted on the CLI's content commands (cli.ts's event-content, and a module's: friend map's timeline and search):
// the same answer with every text replaced by how long it was, so an agent can learn the shape of content without
// reading any.

/** A text as how long it was, in characters. */
export function redactText(text: string): string {
  return `[redacted: ${[...text].length} characters]`;
}
