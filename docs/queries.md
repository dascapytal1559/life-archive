# Queries

The query language, SQL over the metadata, and the AI service that writes queries.

## Queries

### The query language

The query language, for the CLI's `--query` (and queries kept from before), in full at the top of `modules/friend-map/server/query.ts`:

```
is-programmer                  everyone with the tag, written as tags are (lowercase, dashes for spaces)
is-*   *-chess                  * is any run of characters; tag:NAME, or "NAME", for a tag named like a word below
location:sampletown where they are, as far as you last knew (see people.md's "People"): location:new-york or location:"New York"; met: and lives: are gone, and say so
platform:telegram              an account on the platform
group:"Climbing crew"          in a group chat of that title, as its header lists them (members, and anyone who
                               wrote there); group:#75 one chat by its number (npm run archive -- groups)
should-reach-out               also untagged (none of your tags; archive and keep aside) and archived
messages>100                   also direct-messages and group-messages; < <= > >= =
last-spoke<2025-01             the last message's local day against a year, month or day: <2025-01 before
                               January 2025, >2025-01 after it, =2025-01 during it; never spoken to matches none
a AND NOT (b OR c)             NOT binds tightest, then AND, then OR; two terms need AND or OR between them
```

AND, OR, NOT, tags, fields and values may be written in any case. "archive" (or `tag:archive`) matches everyone archived, by you or the rules, as the `archived` flag does; "system-archive" is no longer a tag. A tag or value nobody could have (none in the tag table, or no one with it among everyone) is an error, never an empty map. What people do is a tag, such as is-programmer.

**Generate** writes SQL (see "SQL queries"), so whatever the archive can answer becomes one complete query: "people on Discord I've sent more than 10 messages to" is `SELECT person_id FROM person_platform WHERE platform = 'discord' AND direct_from_me > 10`, counting only your own messages, on Discord alone. What the model is sent (`modules/friend-map/server/queryWriter.ts`, `POST /api/archive/query/generate`): the five views with what each column means (catch-ups among them, with what "caught up with" means), the tables a query may need with their columns, the two functions, how to quote, and that Discord's data package holds only your own messages; every tag and each field's values as stored, with how many people, archived people too, have each, and how many are archived; today's date; and the words; never anyone's name, aliases, note or messages, and not the group chats' titles. It answers with the query and each condition the words ask for, saying whether the query has it; any it could not put in is the note under the box, so nothing is dropped quietly. Its query is run before it is sent back: one that does not run, or is not SQL, is sent back to the model once with the error, and if it still does not run, the error is what the line says. The route also takes a current query to change (`query`; one in the query language goes with a short account of what it means, to be rewritten as SQL), which the box never sends. Generate only writes a query; people are changed from a chat instead (see people.md's "Changing data from a chat"). It asks through the server's AI service (`server/ai.ts`, see "The AI service").

### SQL queries

A query is SQL when its first word (after any `--` or `/* */` comments) is `SELECT` or `WITH`, followed by a space or a new line: one read-only SQLite `SELECT` over the archive, and the view shows the people it returns, as a column named `person_id` (or else `id`). Generate writes these; the CLI's `--query` takes them too (`edit` chooses the people it returns, and `people --query` lists them, archived people too). Anything else is the query language above, unchanged (so the tags `select-crew` and `with-family` are still tags; a tag named `select` is asked for as `tag:select`). On Orbits, Hide and its 1,000 limit apply as to any query. The static demo has no archive to run SQL over: its examples are in the query language.

```sql
-- Only on Discord, with 10 or fewer Discord direct messages (Discord's package holds only yours), not archived.
SELECT person_id FROM people
WHERE platforms = 'discord' AND direct_messages <= 10 AND NOT archived
```

```sql
-- On Telegram they write to you more than you write to them, and you have not spoken there since 2023.
SELECT person_id FROM person_platform
WHERE platform = 'telegram' AND direct_from_them > direct_from_me AND last_day < '2024'
```

```sql
-- 20 or more one-to-one messages in 2025, on any platform, both of you writing.
SELECT person_id FROM direct_message
WHERE day >= '2025' AND day < '2026'
GROUP BY person_id
HAVING count(*) >= 20 AND sum(from_me) > 0 AND sum(NOT from_me) > 0
```

```sql
-- Caught up with in person this year.
SELECT DISTINCT person_id FROM person_catch_up
WHERE day >= '2026'
```

```sql
-- An hour or more on answered calls (phone and FaceTime) since July.
SELECT person_id FROM person_call
WHERE answered AND day >= '2026-07'
GROUP BY person_id
HAVING sum(duration_seconds) >= 3600
```

```sql
-- In three or more of your group chats, but never a one-to-one message.
SELECT person_id FROM person_group GROUP BY person_id HAVING count(*) >= 3
EXCEPT
SELECT person_id FROM people WHERE direct_messages > 0
```

A query sees every table of the archive as it is, content aside (see "It never reads content" below), as "The message archive" and `docs/architecture.md`'s tables describe them (`person`, `import_person`, `import_person_stats`, `conversation`, `conversation_member`, `message`, `tag`, `person_tag` and the rest), and six views that make common questions short (`modules/friend-map/server/sqlRead.ts` has them in full):

- `people`: one row per person the views list (not you; anyone with an account, or whom you have edited): `person_id`, `name`, `aliases` (a JSON array), `note`, `tags` (your tags, comma-separated, in your order), `archived` (1 when archived by you or by the rules, as the Table shows), `archived_by` (`you` or the rule), `untouched`, `edited_at`, `should_reach_out`, `location`, `platforms` (comma-separated, A to Z, so `platforms = 'discord'` is only Discord), `platform_count`, `accounts`, `messages`, `direct_messages`, `direct_from_them`, `direct_from_me`, `group_messages`, `marketplace_messages`, `last_message_at` and `last_day`.
- `person_names`: one row per name each person goes by (not you): `person_id`, `name`, `position` (1 first, in your order) and `is_display` (1 for their name, the first, which labels them; 0 for an alias), so `SELECT person_id FROM person_names WHERE name LIKE '%sam%'` finds anyone by any of their names.
- `person_platform`: one row per person per platform they have an account on, with `accounts` and the same counts and last message for that platform alone.
- `person_group`: one row per person per group chat they are in (listed as a member, or wrote there; dropped and Marketplace groups, and members taken out of a group, aside): `person_id`, `conversation_id`, `platform`, `title`, `listed` (1 when listed as a member) and `sent` (what they sent there).
- `direct_message`: one row per message in a one-to-one chat (system messages, Marketplace and dropped chats aside): `message_id`, `person_id` (the person on the other side), `platform`, `conversation_id`, `from_me`, `sent_at`, `day` and `type`.
- `person_catch_up`: one row per person per catch-up they were at: `person_id`, `catch_up_id`, `day` (its date; a trip's first), `time` (when it started, such as `19:30`, or NULL), `last_day` and `end_time` (a trip's last date and when it ended; NULL for one on a single day), `hours` (a trip's time together in all), `people` (how many were at it, you aside) and `others` (how many more, unnamed); every one in person, as a call is in `person_call`.
- `person_call`: one row per call with a person, from the phone's call history (see archive.md's "Calls" under archive.md's "The message archive"), an app's call with several people made in no chat (a WhatsApp three-way call, one row for each person on it named) or another app's call record in a one-to-one chat (Messenger, Instagram, WhatsApp, WeChat, Signal, Telegram; that record is a message too): or one you logged (Add event's Call): `person_id`, `call_id` (a call in no chat: the phone's, or an app's with several people), `message_id` (another app's in a chat) or `manual_call_id` (one you logged), `account_id` (the account it was with or on; null for one logged on no account), `platform` (`phone`, or the app; for one logged, its account's platform, or on no account the app you said: `phone`, `facetime`, `messenger`, `instagram`, `wechat`, `telegram` or `other`), `at`, `day`, `direction` (`incoming` or `outgoing`; null for one logged), `answered` (1 when connected; an outgoing call answered by voicemail too), `duration_seconds` (0 when not answered), `service` (a call in no chat's: the phone's `phone`, `facetime-audio` or `facetime-video`, an app's `voice` or `video`), `call_group` (for a call with several people, shared by its rows: for one logged, its first logged call's id; for an app's, minus its first row's `call_id`; else null), `people` (how many were on it: 1, or for one with several, how many, its unnamed others among them) and `others` (of those, how many its app could not name, or you did not name on one you logged; else 0). A call whose app does not say how long it was (WeChat, Signal's answered calls, Messenger's phone-app export, a WhatsApp call answered on another device) has null `duration_seconds` (and, in a chat, null `answered`), unless you gave it a length, which `duration_seconds` then is (and `answered` 1).

The counts are the ones the app shows (`import_person_stats`): `direct_messages` is every message both ways in one-to-one chats, of which `direct_from_them` they sent and `direct_from_me` you did; `group_messages` is what they sent in group chats. Times are milliseconds since 1970; a day is a local date written `2025-01-31`, so `day >= '2025'` or `last_day < '2024-06'` compare as dates do. Two functions help: `day(ms)`, that date, and `days_ago(ms)`, whole local days from then to today (`days_ago(last_message_at) > 365`). Strings take single quotes: SQLite reads `"Tia"` as a column.

**It can only read.** Each query runs in a process of its own (`modules/friend-map/server/sqlQuery.ts` starts `sqlRead.ts`) on its own connection to friend map's `data/modules/friend-map/archive.sqlite`, opened read-only with extensions off, `PRAGMA query_only` on and SQLite's defensive mode, and an authorizer that lets the statement only read: no `ATTACH`, `PRAGMA`, writes, transactions or schema changes, and no `load_extension`. Only one statement runs: anything after the first `;` but comments is refused. A query running longer than 10 s is stopped by ending its process, and one returning more than 100,000 rows is refused (return each person once, with `DISTINCT` or `GROUP BY person_id`); SQLite may use at most 1 GB of memory for it. Whatever goes wrong, a typo, a refused write, ids that are no person's, or the time limit, is said under the Query bar's box (or by the CLI), starting "SQL:", and the server goes on serving. Each query costs about 60 ms more than the language's for starting its process. It answers only people's ids and counts.

**It never reads content.** The authorizer refuses a query that would read content at all, anywhere in it (`sqlRead.ts`'s `CONTENT_COLUMNS`): message text and original records (`message.text`, `message.raw_json`, `call.raw_json`), earlier texts (`message_version`), the full-text index (`message_fts` and its tables), catch-ups' and calls' notes (`catch_up.note`, `manual_call.note`, `call_note.note`), drafts (`draft.text`), and the change log's copies of rows (`change_row.before_json` and `after_json`, which hold notes and drafts). So no query can filter on what anyone wrote or confirm a guess at it; it says "SQL: a query cannot read content: message.text". Everything else about a message (who, when, which chat, its type) is there as before, and your notes on people (`person.note`) are not content. Generate's model is told neither the content columns nor the index, and that a query cannot read messages.

### The AI service

Every AI request in the life archive goes through one service, `server/ai.ts` (ask it a question, get an answer), and Generate is the first to ask. What answers is an adapter the service chooses as the server starts: Codex (`server/codex.ts`) where a model is named, else none. Codex runs on your ChatGPT subscription through the Codex CLI signed in on this Mac, never an API key: the archive's server starts `codex app-server` (the long-lived process the Codex apps talk to) as it starts, and keeps it running while it runs, so Generate never waits for Codex to start (about 0.4 s). Each question is a new, unsaved Codex thread of one turn, on `LIFE_ARCHIVE_MODEL` (`.env.local`; unset, there is no AI service and each question says so) at low effort in the Fast tier: a Generate takes about 4 to 5 s, first or not, against about 7 to 8 s for starting `codex exec` for each.

Codex runs read-only (it cannot change a file), with no approval prompts and no network for commands, in an empty scratch folder outside the repo and `data/` (`friend-map-codex` in the system's temporary folder). Your own Codex extras are switched off for it: your MCP servers, apps, plugins, hooks, the browser and computer use, image generation, subagents, web search and the `notify` program. Your `~/.codex/AGENTS.md` is still read, as it is for every Codex session.

When Codex is not installed, is signed out, or stops, the archive's server's log says why once (`[codex] Codex is not signed in: run codex login; starting again in 10 s`), and the service starts it again after 10 s, 1 min, 5 min, then every 30 min, as the live connectors do. A Generate meanwhile starts it at once, and if that fails, says why under the Query bar's box ("Codex is not signed in: run codex login"). So after `codex login`, Generate works without restarting the server. `codex` is found on the server's `PATH`.
