// Friend map's part of the static demo's build (module.ts's `demo`; the core's docs/demo.md): what friend-map's page
// asks of its routes and the demo keeps, asked of the archive's server over the made-up testing data. The page's reads
// of the contract the demo serves (its page demo's DEMO_CAPABILITIES), for everyone and everything in the made-up
// archive: the map, every person's panel (their summary, group chats, calls, hangouts and Events chart, scored with the
// page's settings), every group chat, the Table, every month and day of the Calendar, the Time river, the People
// list's proposals and the change log; and the page's own settings. A person's messages, a chat's and a day's are not
// kept: the demo reads them in the page (../demo.ts). Nothing here is ever asked of a real archive.

import type { CalendarMonth, ChangesetInfo, Contract, PeopleListing, PersonGroup, TagInfo } from "../../../sdk/contract.ts";
import { addDays, type DemoRecorder } from "../../../sdk/server.ts";
import { closenessSettings, type Settings } from "../page/src/settings.ts";
import { PAGE_PATH } from "./page/savedSettingsPlugin.ts";

const API = `${PAGE_PATH}/api`;
const ARCHIVE = `${API}/archive`;

/** The page's query string for `params` (archiveHttp.ts's), leaving out empty ones. */
const query = (params: Record<string, string | number>) => {
  const search = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
  return search ? `?${search}` : "";
};

/** Every month from `first` to `last` (YYYY-MM), in order. */
function monthsFrom(first: string, last: string): string[] {
  const months: string[] = [];
  let [year, month] = first.split("-").map(Number);
  for (let at = first; at <= last; at = `${year}-${String(month).padStart(2, "0")}`) {
    months.push(at);
    month += 1;
    if (month > 12) [year, month] = [year + 1, 1];
  }
  return months;
}

/** Asks `recorder` what friend-map's page asks of the made-up archive (see the top). */
export async function recordFriendMap(recorder: DemoRecorder): Promise<void> {
  const ask = <T>(path: string) => recorder.json<T>(path);
  const { settings } = await ask<{ settings: Settings }>(`${API}/settings`);
  await Promise.all([ask(`${API}/view-settings`), ask(`${API}/me`)]);
  const closeness = query({ ...closenessSettings(settings) });
  const contract = await ask<Contract>(`${ARCHIVE}/contract`);
  const listing = await ask<PeopleListing>(`${ARCHIVE}/people`);
  const tags = await ask<TagInfo[]>(`${ARCHIVE}/tags`);
  await Promise.all([
    ask(`${ARCHIVE}/relationships`), ask(`${ARCHIVE}/score-report`), ask(`${ARCHIVE}/locations`), ask(`${ARCHIVE}/calls`),
    ask(`${ARCHIVE}/catch-ups`), ask(`${ARCHIVE}/message-apps`), ask(`${ARCHIVE}/merge-proposals`), ask(`${ARCHIVE}/table${closeness}`),
    ...tags.map((tag) => ask(`${ARCHIVE}/people${query({ tag: tag.name })}`)),
  ]);
  const groups = new Set<number>();
  await Promise.all(listing.people.map(async ({ id }) => {
    const [, theirs] = await Promise.all([
      ask(`${ARCHIVE}/people/${id}`),
      ask<PersonGroup[]>(`${ARCHIVE}/people/${id}/groups`),
      ask(`${ARCHIVE}/people/${id}/calls`),
      ask(`${ARCHIVE}/catch-ups${query({ person: id })}`),
      ask(`${API}/archive/people/${id}/activity${closeness}`),
    ]);
    for (const group of theirs) groups.add(group.id);
  }));
  await Promise.all([...groups].map((id) => ask(`${ARCHIVE}/groups/${id}`)));
  // The change log as its panel lists it (ChangesPanel's LISTED), and each change it lists.
  const changes = await ask<ChangesetInfo[]>(`${ARCHIVE}/changes${query({ limit: 40 })}`);
  await Promise.all(changes.map((change) => ask(`${ARCHIVE}/changes/${change.id}`)));
  // The Calendar: every month the archive spans and every day of each, in its time zone.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: contract.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());
  const { span } = await ask<CalendarMonth>(`${ARCHIVE}/calendar/${today.slice(0, 7)}`);
  if (span.first === null || span.last === null) return;
  // A month's view asks for the months either side of it too (their days spill into its weeks).
  const first = addDays(`${span.first.slice(0, 7)}-01`, -1).slice(0, 7);
  const last = addDays(`${(span.last > today ? span.last : today).slice(0, 7)}-28`, 7).slice(0, 7);
  const months = monthsFrom(first, last);
  await Promise.all(months.map((month) => ask(`${ARCHIVE}/calendar/${month}`)));
  const days: string[] = [];
  for (let day = `${first}-01`; day.slice(0, 7) <= last; day = addDays(day, 1)) days.push(day);
  await Promise.all(days.map((day) => ask(`${ARCHIVE}/calendar/${day}`)));
}
