import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Context, serve } from "../../../sdk/server.ts";
import { testingLifeArchive, type TestingLifeArchive } from "../../../sdk/testing.ts";
import { writeMadeUpVoiceJournal } from "../fixtures/voiceJournal.ts";
import journal from "../module.ts";
import { assetPath, dayPath, daysPath, JOURNAL_API, rawPath, type JournalDay, type JournalDays, type JournalRawFile } from "../wire.ts";
import { journalRoute } from "./http.ts";

let dataDir: string;
let life: TestingLifeArchive;
let server: Server;
let port: number;
let day: string;
let older: string;

/** A request sent with its path exactly as given (fetch would tidy a `..` away before sending it). */
function call(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const json = async <T>(path: string, headers?: Record<string, string>) => {
  const res = await call(path, headers);
  return { status: res.status, body: JSON.parse(res.body.toString("utf8")) as T & { error?: string } };
};

const trail = () => life.archive.contentLog.list().map(({ surface, reader, what, scope, reads }) => ({ surface, reader, what, scope, reads }));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "journal-page-"));
  await writeMadeUpVoiceJournal(dataDir);
  const journals = join(dataDir, "Vault", "Journals");
  const names = (await readdir(journals)).filter((name) => name.endsWith(".md")).sort();
  [older, day] = names.map((name) => name.slice(0, -3)) as [string, string];
  // What lies outside Journals/, and links inside it that would climb out to it.
  await writeFile(join(dataDir, "secret.md"), "outside the journals");
  await writeFile(join(dataDir, "Vault", "Elsewhere.md"), "another note of the vault");
  await symlink(join(dataDir, "secret.md"), join(journals, "2020-01-01.md"));
  await symlink(join(dataDir, "secret.md"), join(journals, "raw", day, "leak-transcript-osw.md"));
  await mkdir(join(journals, "assets", day, "elsewhere"), { recursive: true });
  await symlink(join(dataDir, "secret.md"), join(journals, "assets", day, "elsewhere", "leak.wav"));
  await writeFile(join(journals, "raw", day, ".hidden.md"), "a dotfile");
  life = await testingLifeArchive(dataDir, journal);
  server = createServer(serve(Context.empty(), journalRoute(dataDir, life.archive.contentLog)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  life.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the Journal page's routes", () => {
  it("list the days by their names and sizes alone, the latest first, and keep nothing in the trail", async () => {
    const { status, body } = await json<JournalDays>(daysPath());
    expect(status).toBe(200);
    expect(body.vault).toBe("Vault");
    expect(body.days).toEqual([
      { day, bytes: expect.any(Number), memos: 1, calls: 0, others: 0, edits: true },
      { day: older, bytes: expect.any(Number), memos: 0, calls: 0, others: 0, edits: false },
    ]);
    // The day file that is a link out of Journals/ is not listed.
    expect(body.days.map((d) => d.day)).not.toContain("2020-01-01");
    expect(trail()).toEqual([]);
  });

  it("open a day: its journal as it is on disk and each source its raw folder records, kept in the trail as the viewer's read", async () => {
    const { status, body } = await json<JournalDay>(dayPath(day));
    expect(status).toBe(200);
    expect(body.markdown).toContain("## A slow run, then lunch");
    expect(body.markdown).toContain("[Larder?]");
    expect(body.sources).toHaveLength(1);
    const [source] = body.sources;
    expect(source).toMatchObject({
      kind: "memo",
      label: null,
      seconds: 24,
      transcripts: [
        { engine: "OpenSuperWhisper", file: "2130-voice-transcript-osw.md" },
        { engine: "Nemotron", file: "2130-voice-transcript-nemotron.md" },
      ],
      audio: expect.stringMatching(/^voice-memos\/\d{8}-213000-ABCD1234\.wav$/),
      edits: "2130-voice-edits.md",
      cited: true,
    });
    expect(source!.id).toMatch(/^voicememo-/);
    expect(body.edits).toEqual([]);
    expect(body.recordings).toEqual([]);
    expect(trail()).toEqual([{ surface: "viewer", reader: null, what: "journal-day", scope: { day }, reads: 1 }]);

    // A day written by hand has no sources; a day of nothing is not there.
    const hand = await json<JournalDay>(dayPath(older));
    expect(hand.body.sources).toEqual([]);
    expect(hand.body.markdown).toContain("[[");
    expect((await json(dayPath("2019-05-05"))).status).toBe(404);
  });

  it("read a transcript or edit list of the day's raw folder, each kept in the trail", async () => {
    const before = trail().length;
    const { status, body } = await json<JournalRawFile>(rawPath(day, "2130-voice-transcript-nemotron.md"));
    expect(status).toBe(200);
    expect(body.text).toContain("Nemotron 3.5 Transcribe");
    expect((await json<JournalRawFile>(rawPath(day, "2130-voice-edits.md"))).body.text).toContain("**Guess:**");
    expect(trail().slice(0, trail().length - before).map((r) => [r.what, r.scope])).toEqual([
      ["journal-raw", { day, file: "2130-voice-edits.md" }],
      ["journal-raw", { day, file: "2130-voice-transcript-nemotron.md" }],
    ]);
  });

  it("stream a recording a range at a time so the player can seek, its reads folding into one row of the trail", async () => {
    const { body: opened } = await json<JournalDay>(dayPath(day));
    const path = assetPath(day, opened.sources[0]!.audio!);
    const whole = await call(path);
    expect(whole.status).toBe(200);
    expect(whole.headers["content-type"]).toBe("audio/wav");
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.headers["cache-control"]).toBe("no-store");
    expect(whole.body.subarray(0, 4).toString()).toBe("RIFF");
    const size = whole.body.length;

    const part = await call(path, { range: "bytes=100-199" });
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 100-199/${size}`);
    expect(part.body).toEqual(whole.body.subarray(100, 200));
    expect((await call(path, { range: `bytes=${size}-` })).status).toBe(416);

    const rows = trail().filter((r) => r.what === "journal-asset");
    expect(rows).toEqual([{ surface: "viewer", reader: null, what: "journal-asset", scope: { day, file: opened.sources[0]!.audio! }, reads: 3 }]);
  });

  it("never leave Journals/: no `..`, no slash in a name, no dotfile, no link out, and nothing refused is kept in the trail", async () => {
    const before = trail();
    const refused = [
      `${JOURNAL_API}/days/..%2F..%2Fsecret`,
      `${JOURNAL_API}/days/../../../secret.md`,
      `${JOURNAL_API}/days/%2e%2e/raw/secret.md`,
      `${JOURNAL_API}/days/2026-1-1`,
      `${JOURNAL_API}/days/${day}/raw/..%2F..%2F..%2F..%2Fsecret.md`,
      `${JOURNAL_API}/days/${day}/raw/%2E%2E`,
      `${JOURNAL_API}/days/${day}/raw/.hidden.md`,
      `${JOURNAL_API}/days/${day}/raw/2130-voice.source.json`,
      `${JOURNAL_API}/days/${day}/raw/leak-transcript-osw.md`,
      `${JOURNAL_API}/days/${day}/assets/elsewhere/leak.wav`,
      `${JOURNAL_API}/days/${day}/assets/..%2F..%2F..%2Fsecret.md`,
      `${JOURNAL_API}/days/${day}/assets/voice-memos/%2E%2E/%2E%2E/%2E%2E/secret.wav`,
      `${JOURNAL_API}/days/2020-01-01`,
      `${JOURNAL_API}/days/${day}/raw/%E0%A4%A`,
      `${JOURNAL_API}/../../Elsewhere.md`,
    ];
    for (const path of refused) {
      const res = await call(path);
      expect([400, 404], `${path}: ${res.status} ${res.body.toString()}`).toContain(res.status);
      expect(res.body.toString(), path).not.toContain("outside the journals");
      expect(res.body.toString(), path).not.toContain("another note of the vault");
    }
    expect(trail()).toEqual(before);
  });

  it("answer only the console's own page, and only read", async () => {
    expect((await call(daysPath(), { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await call(dayPath(day), { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call(dayPath(day), { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await call(dayPath(day), {}, "POST")).status).toBe(405);
    expect((await call(dayPath(day), {}, "PUT")).status).toBe(405);
  });

  it("say so when the vault has no Journals/", async () => {
    const empty = await mkdtemp(join(tmpdir(), "journal-none-"));
    const bare = createServer(serve(Context.empty(), journalRoute(empty, life.archive.contentLog)));
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}${daysPath()}`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toMatch(/no Journals folder/);
    } finally {
      await new Promise((resolve) => bare.close(resolve));
      await rm(empty, { recursive: true, force: true });
    }
  });
});
