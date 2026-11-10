import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, ImportFailedError, loadRegistry } from "../../../sdk/server.ts";
import { openArchive } from "../server/db.ts";
import { sampleMessengerExport } from "../fixtures/exports.ts";
import { backoffDelay, ConnectorDisabledError } from "../../../sdk/testing.ts";
import { chatHost } from "../testing/host.ts";

let dataDir: string;
let db: Db;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-host-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("history import", () => {
  it("imports the sample Messenger export, and a second import of it changes nothing", async () => {
    const host = await chatHost(db, dataDir);
    const sample = await sampleMessengerExport(dataDir);
    await expect(host.importHistory("messenger-export", sample)).rejects.toThrow(ConnectorDisabledError);
    // Two connectors serve Messenger, so the platform alone does not name one.
    await expect(host.importHistory("messenger", sample)).rejects.toThrow(/name one of facebook-dyi, messenger-export/);
    await host.setEnabled("messenger-export", true);

    const first = await host.importHistory("messenger-export", sample);
    expect(first.connector).toBe("messenger-export");
    expect(first.previouslyImportedAt).toBeNull();
    expect(first.counts.messages).toEqual({ added: 28, updated: 0, unchanged: 0, duplicates: 1, unsentAdded: 2, matched: 0, edited: 0 });
    expect(first.counts.conversations.added).toBe(10);
    expect(first.counts.reactions.added).toBe(4);
    expect(first.counts.attachments).toEqual({ added: 6, updated: 0, stored: 5, missing: 1 });
    expect(count("message")).toBe(28);

    const second = await host.importHistory("messenger-export", sample);
    expect(second.previouslyImportedAt).not.toBeNull();
    expect(second.counts.messages).toMatchObject({ added: 0, updated: 0, unchanged: 28, duplicates: 1 });
    expect(second.counts.accounts).toEqual({ added: 0, updated: 0 });
    expect(second.counts.conversations).toEqual({ added: 0, updated: 0 });
    expect(second.counts.reactions.added).toBe(0);
    expect(second.counts.attachments).toMatchObject({ added: 0, updated: 0 });
    expect(count("message")).toBe(28);

    const status = (await host.statuses()).find((s) => s.id === "messenger-export");
    expect(status).toMatchObject({ enabled: true, status: "idle", failures: 0 });
    await host.setEnabled("messenger-export", false);
    expect((await host.statuses()).find((s) => s.id === "messenger-export")!.status).toBe("disabled");
  });
});

describe("isolation", () => {
  // JSON leaves the line and paragraph separators unescaped, so an event holding one is still one line.
  const HELLO = "hello\u2028there\u2029";

  async function fakeConnectors(): Promise<string> {
    const dir = join(dataDir, "fake-connectors");
    const connector = async (id: string, main: string, manifest?: string) => {
      await mkdir(join(dir, id), { recursive: true });
      await writeFile(
        join(dir, id, "manifest.ts"),
        manifest ??
          `export const manifest = { id: "${id}", platform: "discord", sourceKind: "export",
             capabilities: { history: true, sync: false, send: false }, needs: [], description: "${id}" };`,
      );
      await writeFile(join(dir, id, "main.ts"), main);
    };
    const emit = (events: unknown[]) => events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join("\n");
    const good = [
      { kind: "account", key: "u1", keyKind: "id", displayName: "Someone" },
      { kind: "conversation", id: "c1", type: "direct", members: ["u1"] },
      { kind: "message", id: "m1", idKind: "platform", conversation: "c1", sender: "u1", isFromSelf: false, sentAt: 1, type: "text", text: HELLO, raw: {} },
    ];
    await connector("good", emit(good));
    await connector("crashes", `${emit(good)}\nconsole.error("could not read the third chat"); process.exit(1);`);
    await connector("garbage", `${emit(good.slice(0, 1))}\nconsole.log("not json");`);
    await connector("invalid", emit([{ kind: "message", id: "m1" }]));
    await connector("dangling", emit([{ kind: "reaction", message: "nope", actor: "nobody", emoji: "x" }]));
    await connector("hangs", "setInterval(() => {}, 1000);");
    await connector("checkpoints", emit([...good, { kind: "checkpoint", cursor: 1 }]));
    await connector("badmanifest", "", "throw new Error('broken on purpose');");
    await mkdir(join(dataDir, "connectors"));
    for (const id of ["good", "crashes", "garbage", "invalid", "dangling", "hangs", "checkpoints"]) {
      await writeFile(join(dataDir, "connectors", `${id}.json`), JSON.stringify({ enabled: true }));
    }
    await writeFile(join(dataDir, "source.bin"), "x");
    return dir;
  }

  it("a failing connector changes nothing, is marked with its error and a backoff, and the others carry on", async () => {
    const host = await chatHost(db, dataDir, await loadRegistry(await fakeConnectors()));
    const source = join(dataDir, "source.bin");
    const failures: Array<[string, RegExp]> = [
      ["crashes", /stopped with an error: could not read the third chat/],
      ["garbage", /not JSON \(line 2\)/],
      ["invalid", /invalid event on line 1: \(message\) idKind/],
      ["dangling", /refers to a message that no earlier event announced/],
      ["checkpoints", /wrote a checkpoint event on line 4, which only sync mode writes/],
    ];
    for (const [id, reason] of failures) {
      await expect(host.importHistory(id, source)).rejects.toThrow(reason);
    }
    await expect(host.importHistory("hangs", source, { timeoutMs: 300 })).rejects.toThrow(/did not finish/);
    expect(count("message")).toBe(0);
    expect(count("import_person")).toBe(0);

    const result = await host.importHistory("good", source);
    expect(result.counts.messages.added).toBe(1);
    expect(db.prepare("SELECT text FROM message").get()).toEqual({ text: HELLO });

    const statuses = Object.fromEntries((await host.statuses()).map((s) => [s.id, s]));
    expect(statuses.good).toMatchObject({ status: "idle", failures: 0, lastError: null });
    expect(statuses.crashes).toMatchObject({ status: "error", failures: 1, lastError: expect.stringContaining("third chat") });
    expect(statuses.badmanifest).toMatchObject({ status: "error", lastError: expect.stringContaining("broken on purpose") });
    await expect(host.importHistory("badmanifest", source)).rejects.toThrow(ImportFailedError);

    const state = db.prepare("SELECT retry_after, last_error_at FROM connector_state WHERE connector = 'crashes'").get() as
      { retry_after: number; last_error_at: number };
    expect(state.retry_after - state.last_error_at).toBeGreaterThanOrEqual(backoffDelay(1) - 1000);
    expect(db.prepare("SELECT status FROM source WHERE connector = 'crashes'").get()).toEqual({ status: "failed" });
  });

  it("backs off 1 minute, 5, 30, then hourly", () => {
    expect([1, 2, 3, 4, 9].map(backoffDelay)).toEqual([60_000, 300_000, 1_800_000, 3_600_000, 3_600_000]);
  });
});
