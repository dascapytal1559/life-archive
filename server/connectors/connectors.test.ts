import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateCommand, validateEvent, type ConnectorEvent } from "./contract.ts";
import { writeZip, ZipFile } from "./zip.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-connectors-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("zip", () => {
  it("reads back what it writes, including empty files and non-ASCII names", async () => {
    const path = join(dir, "test.zip");
    const big = "x".repeat(100_000);
    await writeZip(path, [
      { name: "Cléo_1.json", data: "{}" },
      { name: "media/a/empty.bin", data: "" },
      { name: "media/b/big.txt", data: big },
    ]);
    const zip = await ZipFile.open(path);
    try {
      expect(zip.entries.map((e) => e.name)).toEqual(["Cléo_1.json", "media/a/empty.bin", "media/b/big.txt"]);
      expect((await zip.read(zip.entries[0])).toString()).toBe("{}");
      expect((await zip.read(zip.entries[1])).length).toBe(0);
      expect((await zip.read(zip.entries[2])).toString()).toBe(big);
    } finally {
      await zip.close();
    }
  });

  it("rejects a file that is not a zip", async () => {
    const path = join(dir, "not.zip");
    await writeFile(path, "hello");
    await expect(ZipFile.open(path)).rejects.toThrow(/not a zip file/);
  });
});

describe("validateEvent", () => {
  it("accepts well-formed events", () => {
    const ok: ConnectorEvent[] = [
      { kind: "account", key: "Ada", keyKind: "name", displayName: "Ada" },
      { kind: "conversation", id: "c", type: "direct", members: ["Ada"] },
      { kind: "message", id: "m", idKind: "synthetic", conversation: "c", sender: "Ada", isFromSelf: false, sentAt: 1, type: "text", text: "", raw: {} },
      { kind: "message", id: "s", idKind: "platform", conversation: "c", sender: null, isFromSelf: false, sentAt: 1, type: "system", raw: null },
      { kind: "attachment", message: "m", ordinal: 0, type: "image", stored: { sha256: "a".repeat(64), size: 3, path: "messenger/aa/x.jpg" } },
      { kind: "coverage", from: 1, to: 2 },
      { kind: "tally", name: "skipped", count: 2 },
      { kind: "edit", message: "m", text: "", editedAt: 2 },
      { kind: "checkpoint", cursor: null },
      { kind: "checkpoint", cursor: { since: "s1" } },
      { kind: "state", state: "connected" },
      { kind: "state", state: "logged-out", detail: "the bridge has no login" },
      { kind: "send-result", request: "r1", status: "sent", messageId: "user:1/2" },
      { kind: "send-result", request: "r1", status: "failed", error: "no" },
    ];
    for (const event of ok) expect(validateEvent(event)).toEqual({ event });
  });

  it("checks sync events and the host's commands", () => {
    expect(validateEvent({ kind: "checkpoint" })).toEqual({ error: "(checkpoint) cursor is missing" });
    expect(validateEvent({ kind: "state", state: "happy" })).toEqual({ error: expect.stringMatching(/state must be one of/) });
    expect(validateEvent({ kind: "send-result", request: "r", status: "maybe" })).toEqual({ error: expect.stringMatching(/status must be one of/) });
    const send = { command: "send", request: "r", conversation: "user:1", text: "a private line" };
    expect(validateCommand(send)).toEqual({ command: send });
    expect(validateCommand({ ...send, text: 5 })).toEqual({ error: "(send) text must be a non-empty string" });
    expect(validateCommand({ ...send, command: "typing" })).toEqual({ error: "has an unknown command" });
    expect(JSON.stringify(validateCommand({ ...send, conversation: "" }))).not.toContain("a private line");
  });

  it("names the field that is wrong without quoting any value", () => {
    const secret = "a very private message";
    const cases: Array<[unknown, RegExp]> = [
      [{ kind: "message", id: "m", idKind: "synthetic", conversation: "c", sender: "Ada", isFromSelf: false, sentAt: secret, type: "text", raw: {} }, /sentAt/],
      [{ kind: "message", id: "m", idKind: "synthetic", conversation: "c", sender: "Ada", isFromSelf: false, sentAt: 1, type: secret, raw: {} }, /type must be one of/],
      [{ kind: "message", id: "m", idKind: "synthetic", conversation: "c", sender: "Ada", isFromSelf: false, sentAt: 1, type: "text" }, /raw is missing/],
      [{ kind: "attachment", message: "m", ordinal: 0, type: "image", stored: { sha256: "a".repeat(64), size: 1, path: "../../etc/passwd" } }, /inside the media folder/],
      [{ kind: "coverage", from: 5, to: 1 }, /from must not be after to/],
      [{ kind: secret }, /unknown kind/],
      [[secret], /not a JSON object/],
    ];
    for (const [event, reason] of cases) {
      const result = validateEvent(event);
      expect(result).toEqual({ error: expect.stringMatching(reason) });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
