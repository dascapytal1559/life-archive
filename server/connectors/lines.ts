// Small helpers shared by the host and the connector runtime.

import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** A path with a leading "~/" read as the home folder. */
export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * The JSON lines on a stream (a connector's events, or the host's commands), split at "\n" alone:
 * readline also splits at U+2028 and U+2029, which JSON leaves unescaped inside strings, so message
 * text holding one would cut its line in two.
 */
export async function* jsonLines(input: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  for await (const chunk of input) {
    const lines = (rest + decoder.write(chunk as Buffer)).split("\n");
    rest = lines.pop()!;
    yield* lines;
  }
  rest += decoder.end();
  if (rest) yield rest;
}
