# The demo

The life archive's public demo, planned for Cloudflare Pages (`life-archive-demo.pages.dev` once it is published, as "Publishing it on Cloudflare Pages" below says; it is not published yet): the console as
the archive's server serves it, over the testing data's made-up crowd (`npm run testing-data -- --crowd`), as plain
files on a site with no server behind it. It shows the Events page (its Calendar, Daily rituals, Tables and Sources) and Friend Map
(friend-map's page, framed as the console frames it; its tables are among Events' Tables); every other page is left out until it
is marked ready (docs/modules.md's "Ready pages"), as in a fresh install. Nothing in it can be changed: every change is refused, politely.

## Building it

```sh
npm run build:demo            # into dist-demo/ (git ignores it), about a minute
npm run serve:demo            # dist-demo/ as Cloudflare Pages serves it: http://127.0.0.1:4680/
npm run check-demo            # the check again, on its own
```

`--out <dir>` builds elsewhere, `--no-network` fetches nothing from the web (no map, which the pages shown do not
need), `--keep` keeps the made-up folder it built from, and `--mount <path>` builds it to be served under another
server's path rather than at the root of a site of its own (the main preview's, below). `tools/demo/build.ts` does it all:

1. **The made-up folder**: the testing data's crowd, in a temporary folder.
2. **The server's answers** (`tools/demo/record.ts`): the archive's own server is started over that folder on a spare
   port, with a bare environment, an empty `HOME` of its own and no `.env.local` (`LIFE_ARCHIVE_NO_ENV_FILE=1`,
   `server/dataHome.ts`), so nothing of the machine it is built on (a key, a host, its jobs' schedules) can reach an
   answer. It is asked every question the shown pages can ask of a route whose questions can all be asked beforehand:
   the settings, the Events tables' list, the Sources, every page of every LLM session, and each module's part (its
   `module.ts`'s `demo.record`, `sdk/server.ts`'s `DemoRecorder`): friend map's is every read of its contract for
   every made-up person, group chat, month and day. Each answer is kept as the server gave it, status and JSON, in
   `demo-data/answers/`, a file named by a hash of its question (`sdk/demo.ts`'s `answerKey` and `answerFile`); a file
   the server answers (a map tile) at its own path.
3. **The databases**: the made-up `core.sqlite`, `calendar.sqlite` and each module's database, gzipped, in
   `demo-data/db/`.
4. **The pages** (`tools/demo/vite.ts`): the console (`viewer/demo/`) at `/life-archive/` and each module page that
   has a demo entry (friend-map's `modules/friend-map/page/demo/`) at its path, built as the server serves them with
   the demo's backend underneath (below).
5. **The site's files** (`tools/demo/site.ts`): `_redirects` (the root opens the console's home, every console address
   its page, and the console's former addresses, `/life-archive/console/...`, the same place at `/life-archive/dev`),
   `_headers` (a Content-Security-Policy allowing nothing from another site, no referrer, no devices;
   `server/demoSite.ts`) and the 404 pages.
6. **The check** (below), which fails the build.

## How the pages run with no server

`sdk/demo.ts`: each page's demo entry replaces the browser's `fetch` before the page's own code loads, so not one view
knows it is in the demo. A request under `/life-archive/api/` or `/friend-map/api/` is answered:

- **live**, in the page, by the server's own code over the made-up databases, through SQLite compiled to WebAssembly
  (sql.js, behind `DemoDatabase`, which is what the server's code calls of `node:sqlite`), where the questions are
  open: the Events tables' rows, charts, filters and drawers and the calendar's days (`server/viewer/http.ts`'s
  `viewerAnswers`, with every module's tables and owners from its `demo.ts`), the chat a Messages row opens and
  friend-map's person's messages, a chat's pages and a day of them (`modules/friend-map/server/contentReads.ts`), an
  LLM session's page from wherever it is opened (`server/viewer/content.ts`'s `sessionPageAt` over the recorded pages);
  `viewer/demo/backend.ts` and each module's `demo.ts` list them;
- else **recorded**: the server's answer kept for that question;
- else a file at its own path, else 404, "not in the demo".

Anything but a GET is refused with 403, "This is the demo, on made-up data: it is read-only". friend-map's page is
also told so by its handshake: the demo serves the contract's reads alone (its demo entry's `DEMO_CAPABILITIES`), so
the page is read-only and runs the Query bar's language itself.

The server's code in a page: the server's own files are bundled taking their loading to do nothing but define what
they export, so a page that calls one function of a file does not bring the server with it; the few `node:` modules
they name as they load are the page's own small stand-ins (`viewer/demo/node*.ts`).

`viewer/demo/backend.test.ts` holds the live routes to the server: over the testing crowd, every table's rows (each
sort, a page down, each filter's first value, a time range), facets, charts (each grain, measure and split) and
drawers, the calendar's days, the chats and the Inspirations reads, answered by the page's SQLite as by
`node:sqlite`. A module's tables in its `demo.ts` must be its `module.ts`'s.

## The main preview

The captain keeps two builds on his Mac ("I kinda wanna maybe permanently host a main build and a dev build on my
computer. So I can like very quickly check out what the main build would be like and my daily driving should be the dev
build"): the console at `/life-archive/dev` is the dev branch's, on his archive, and `/life-archive/main` is the main
branch's, as this demo: main's console on the made-up crowd, read-only, plain files with no server process of its own.

- **Built** by `npm run main-preview` (`tools/mainPreview.ts`), run from the checkout the server runs each time main
  moves: main's code checked out in a temporary clone of its own (no worktree is added, nothing untracked comes with
  it), its packages installed (`npm ci`), and main's own `npm run build:demo -- --mount /life-archive/main` run there,
  checked by main's own check against the archive's private names, into a new folder under the archive's folder's
  `main-preview/builds/`. The link `main-preview/current` is then pointed at it in one step (a new link renamed over
  the old) and the old build removed, so the preview is the old build or the new one, never half of either; a build
  that fails leaves the one served as it was. `--ref <ref>` builds another branch or commit, `--into <folder>` keeps
  it elsewhere, `--no-network` fetches nothing (as the build's). main's code from before the command existed cannot
  be built for a mount: it says so, and nothing changes.
- **Built for a mount** (`viewer/mount.ts`): the build tells the pages the mount (`import.meta.env.LIFE_ARCHIVE_MOUNT`),
  and the console's address is the mount itself (`/life-archive/main/events`), while the rest of the demo's site
  (the pages' files, their routes, the recorded answers and databases, friend-map's page) is a step below, under
  `/life-archive/main/_site/`, a name no aspect's slug can be. Its backend looks each question up at the server's own
  path, answers one asked at the server's own path all the same, and keeps the page's `localStorage` under its own
  names, as it shares its origin with `/life-archive/dev`'s console (the look, the rail's order and the folded sections
  of one never change the other's).
- **Served** by the archive's server (`server/mainPreview.ts`), which only reads the build's files: the console's page
  for `/life-archive/main` and every address under it, each file under `_site/` at its path (a folder's page, else the
  nearest `404.html`, as Pages answers), nothing for a change, and a page saying no preview is built yet before the
  first build. Its Content-Security-Policy is the demo's with this path for its own, so its pages can load or ask
  nothing outside `/life-archive/main/`, not one of the archive's routes.

## The check

`tools/demo/check.ts`, run by every build and by `npm run check-demo`, fails on:

1. **A file a demo is not made of**: anything but the pages and their assets, the site's files, the recorded answers,
   the gzipped databases and the files the server answered; any raw database, log, record or `.env`; a file over
   Cloudflare Pages' 25 MiB, or more than its 20,000 files.
2. **Anything the guard stops** (`server/guard/scan.ts`, the commit check's own): in every file's text and every text
   value of every copied database, with the archive's private names and terms where the machine has an archive (the
   captain's Mac; from a linked worktree, whose own `data/` is empty, the main checkout's archive), else the patterns
   alone (emails, phone numbers, hosts, addresses, this machine's names), and then the build and the check say so in a
   `WARNING` line. The pages' compiled code is not read for the shapes of digits alone (a minifier writes a hash's
   constants as digits). Each finding says where and by which rule, never what.
3. **A file the archive's folder holds byte for byte**, whatever it is called, but the demo's own there: the build being checked, and the main preview's builds in `main-preview/`.

Nothing of a private module (one git does not track, `docs/modules.md`'s "Private modules") goes in: the build sets
`LIFE_ARCHIVE_TRACKED_MODULES_ONLY` for the made-up folder, the server it records and its own loading, so such a module
is not installed for any of it, and the pages' globs of the modules' files leave it out by name (`tools/demo/vite.ts`'s
`trackedModulesOnly`), any other import of one of its files stopping the build.

`tools/demo/check.test.ts` builds the demo and shows the check passes it and stops a name from the private
dictionary in an answer and in a database, an email, a stray database or log, and a copy of an archive's file.

## Publishing it on Cloudflare Pages

Once the repository is on GitHub, by hand, once (no worker or agent does this):

1. In a Cloudflare account: Workers & Pages, Create, Pages, Connect to Git; give the
   Cloudflare GitHub App this repository alone.
2. Project name `life-archive-demo` (the address), production branch `main`, build command `npm run build:demo`,
   output directory `dist-demo`. The build reads `.node-version` for its Node. No environment variables.
3. Settings, Builds: preview branches none.

Every push to `main` then rebuilds it. The made-up data is made as the demo is built, so its weeks run to the day of the
build.

## Adding a page to it

Mark it ready (docs/modules.md's "Ready pages"): the build runs the archive's server as a fresh install (`tools/demo/record.ts`), so the demo shows what a new archive offers. Its module's
`demo.record` keeps what the page asks (it is run only when the module is on); a question with open answers
needs a live route in its `demo.ts`. The exercise module's record already cuts the made-up runs' area's open map and
terrain from Protomaps' and Mapterhorn's builds (`modules/exercise/server/demoRecord.ts`) for the Fitness page and
the playback, when they are shown.
