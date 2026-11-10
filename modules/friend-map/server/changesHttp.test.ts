import { mkdtemp, rm } from "node:fs/promises";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ChangesetInfo, PeopleListing, PersonSummary } from "../../../sdk/server.ts";
import { sampleMessengerExport } from "../fixtures/exports.ts";
import { archiveHandler } from "../testing/routes.ts";

let dataDir: string;
let archive: TestArchive;
let server: Server;
let base: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-changes-http-"));
  archive = await openTestArchive(dataDir);
  await archive.host.setEnabled("messenger-export", true);
  await archive.importHistory("messenger-export", await sampleMessengerExport(dataDir));
  const handler = archiveHandler(archive);
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/archive`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  archive.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

function send(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function named(name: string): Promise<PersonSummary> {
  const person = (await get<PeopleListing>("/people")).people.find((p) => p.name === name);
  if (!person) throw new Error(`nobody named ${name}`);
  return person;
}

it("records every edit from the app as a changeset, lists and shows them, and undoes one", async () => {
  const ada = await named("Ada Sample");
  const cleo = await named("Cleo Example");
  expect((await send(`/people/${ada.id}/tags`, "PUT", { tags: ["climbing"] })).status).toBe(200);
  expect((await send(`/people/${ada.id}/location`, "PUT", { location: "Tokyo" })).status).toBe(200);
  expect((await send("/tags/climbing", "PUT", { name: "climbers" })).status).toBe(200);
  // The same again changes nothing, so it leaves no changeset; a failed edit leaves none either.
  expect((await send(`/people/${ada.id}/location`, "PUT", { location: "tokyo" })).status).toBe(200);
  expect((await send(`/people/${ada.id}/tags`, "PUT", { tags: ["not a tag!"] })).status).toBe(400);
  expect((await send(`/people/${ada.id}/merge`, "POST", { with: cleo.id })).status).toBe(200);

  const log = await get<ChangesetInfo[]>("/changes");
  expect(log.map((c) => [c.surface, c.action])).toEqual([["app", "merge"], ["app", "tag rename"], ["app", "person location"], ["app", "person tags"]]);
  expect(log[2].people).toEqual([{ id: ada.id, name: "Ada Sample", changes: [{ what: "location", before: "", after: "Tokyo" }] }]);
  expect(log[1]).toMatchObject({ other: ['renamed the tag "climbing" to "climbers"'], peopleCount: 1 });
  expect((await get<ChangesetInfo[]>("/changes?limit=1")).map((c) => c.id)).toEqual([log[0].id]);
  expect(await get<ChangesetInfo>(`/changes/${log[0].id}`)).toEqual(log[0]);
  expect((await fetch(`${base}/changes/99999`)).status).toBe(404);

  // Only friend-map's own page may undo.
  expect((await send(`/changes/${log[0].id}/undo`, "POST", {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  const undo = await send(`/changes/${log[0].id}/undo`, "POST", {});
  expect(undo.status).toBe(200);
  expect(await undo.json()).toMatchObject({ surface: "app", action: `undo #${log[0].id}`, undoes: log[0].id });
  expect(await named("Cleo Example")).toMatchObject({ id: cleo.id, accounts: cleo.accounts });
  expect((await named("Ada Sample")).tags).toEqual(["climbers"]);

  // Changed since: refused with who, and nothing is put back.
  expect((await send(`/people/${ada.id}/location`, "PUT", { location: "Brisbane" })).status).toBe(200);
  const refused = await send(`/changes/${log[2].id}/undo`, "POST", {});
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: `can't undo #${log[2].id}: changed again since: Ada Sample [person ${ada.id}] (location)` });
  expect((await named("Ada Sample")).location).toBe("Brisbane");
  const again = await send(`/changes/${log[0].id}/undo`, "POST", {});
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: expect.stringMatching(new RegExp(`^#${log[0].id} was undone by #\\d+`)) });
});

it("answers saving tags with the changeset it made, so an archive can be undone, and refuses once they changed since", async () => {
  const cleo = await named("Cleo Example");
  const archived = await send(`/people/${cleo.id}/tags`, "PUT", { tags: ["archive"] });
  const { person, changeset } = (await archived.json()) as { person: PersonSummary; changeset: number };
  expect(person).toMatchObject({ id: cleo.id, archived: "you" });
  expect((await get<ChangesetInfo[]>("/changes?limit=1"))[0]).toMatchObject({ id: changeset, action: "person tags" });
  // The same tags again change nothing: no changeset to undo.
  expect(await (await send(`/people/${cleo.id}/tags`, "PUT", { tags: ["archive"] })).json()).toMatchObject({ changeset: null });

  expect((await send(`/changes/${changeset}/undo`, "POST", {})).status).toBe(200);
  expect(await get<PersonSummary>(`/people/${cleo.id}`)).toMatchObject({ archived: null, tags: [] });

  // Another tag since leaves the archive's undo be; the other tag stays.
  const tagged = (await (await send(`/people/${cleo.id}/tags`, "PUT", { tags: ["archive"] })).json()) as { changeset: number };
  expect((await send(`/people/${cleo.id}/tags`, "PUT", { tags: ["archive", "climbers"] })).status).toBe(200);
  expect((await send(`/changes/${tagged.changeset}/undo`, "POST", {})).status).toBe(200);
  expect(await get<PersonSummary>(`/people/${cleo.id}`)).toMatchObject({ archived: null, tags: ["climbers"] });

  // Unarchived and archived again since: refused, naming who.
  const again = (await (await send(`/people/${cleo.id}/tags`, "PUT", { tags: ["climbers", "archive"] })).json()) as { changeset: number };
  expect((await send(`/people/${cleo.id}/tags`, "PUT", { tags: ["climbers"] })).status).toBe(200);
  const refused = await send(`/changes/${again.changeset}/undo`, "POST", {});
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: `can't undo #${again.changeset}: changed again since: Cleo Example [person ${cleo.id}] (tags)` });
  expect(await get<PersonSummary>(`/people/${cleo.id}`)).toMatchObject({ archived: null, tags: ["climbers"] });
});
