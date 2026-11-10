// friend map's commands, which the core's `npm run archive -- <command>` hands on (sdk/server.ts's `commands`): the
// people, their tags, groups, calls and catch-ups (people.ts, calls.ts), and the chats themselves and the change log
// (chats.ts). Each runs on the friend map the archive opened, with the options the core parsed for it
// (context.ts's FRIEND_MAP_OPTIONS), and says at the end the changeset it made and how to undo it.
//
// Every command but `timeline` and `search` prints structure only (names, counts, dates), never message text. Those two
// print message text: run them only when the captain asks for something from his chats; each read goes in the core's
// trail of content reads, with the reader an agent names in LIFE_ARCHIVE_READER and the captain's words in --why.

import { KEEP_DAYS, zonePlace, type CommandLive } from "../../../sdk/server.ts";
import type { FriendMap } from "./friendMap.ts";
import { callCommands } from "./cli/calls.ts";
import { chatCommands } from "./cli/chats.ts";
import { cli, FRIEND_MAP_OPTIONS, setCli, type CliValues } from "./cli/context.ts";
import { peopleCommands } from "./cli/people.ts";

export { FRIEND_MAP_OPTIONS };

/** Every command friend map answers. */
export const FRIEND_MAP_COMMANDS: readonly string[] = [
  "people", "proposals", "confirm", "reject", "merge", "detach", "tags", "edit", "groups", "group", "person", "tag", "locations", "location", "field",
  "contact-notes", "rules", "catch-ups", "calls", "catch-up", "call", "coverage", "import-status", "exports", "media", "repair", "storage", "timeline",
  "search", "changes",
];

/** What `npm run archive` says of them: among the structure commands, and among the content commands. */
export const FRIEND_MAP_HELP = {
  structure: `  people [--tag <tag>] [--query <text>] everyone on the map, most recent first, and how many are archived; --query
                                        finds words in names, notes and handles, or, when it is SQL (a SELECT, see
                                        docs/queries.md's "SQL queries"), lists the people it returns, archived too
  people --location <value>             only those with that location (but for case), archived people too
  people --reach-out                    the people you should reach out to, each with their drafts
  people --archived                     the archived, each with why
  proposals                             people who may be the same, waiting for the captain
  confirm <proposal> / reject <proposal>
  merge <person> <other person>         the captain says these two are one: the first is kept, the
                                        second's accounts, aliases, tags and note join it, and it is deleted
  detach <person> <account>             "Not them": the account becomes a person of its own again
  tags <person> [tag ...]               set a person's tags ("archive" takes them off the map; "keep"
                                        stops the automatic archive rules)
  tag list                              every tag, in order, with how many people have it
  tag add <name>                        a new tag, last (multi-word names are hyphenated: "uni friends" is uni-friends)
  tag rename <tag> <new name>           for everyone who has it; onto a tag that exists, the two are merged into that one
  tag delete <tag>                      take it from everyone, and it is gone
  tag move <tag> <position>             put it at this place in the order (1 first)
                                        ("archive" and "keep" can be moved, not renamed, merged into or deleted)
  person show <person>                  a person: name, aliases, tags, location, note, reaching out,
                                        and each account with its number
  person new <name ...> [--location <value>] [--tag <tag,tag>] [--note <text>] [--anyway]
                                        add someone you know offline by hand, with no accounts yet; refused,
                                        naming them, when someone already has that name or alias, unless --anyway
  person set-name <person> <name ...>
  person add-alias <person> <alias ...> another name they go by, after their name (their label)
  person remove-alias <person> <alias ...>
  person tag <person> <tag ...> / person untag <person> <tag ...>
  person link <account> <person>        the account is this person (the captain's link: rules never undo it)
  person unlink <account>               the account becomes a person of its own ("Not them")
  person me <person>                    "This is me": their accounts are yours (an old name of yours)
  person delete <person>                delete a person with no accounts left
  person note <person> <text ...>       set their note (yours from now on: the address book never writes over it)
  person clear-note <person>
  person reach-out <person>             you should reach out to them (Orbits' glow)
  person no-reach-out <person>
  person draft <person> <text ...>      set the message you are writing to them (their first draft; one is made
                                        when they have none). Drafts are your scratch space: no changeset
  person clear-draft <person>           delete their first draft
  person location <person> <value ...>  where they are, as far as you last knew (one value: "Brisbane"); one
                                        someone is at but for case is written as theirs is ("brisbane" is Brisbane)
  person clear-location <person>
  locations                             every location someone is at, the most people first, with how many
  location rename <location> <new name> for everyone at it; onto another location someone is at, the two are
                                        merged into that one (quote one of several words: "New York"); to take
                                        one from everyone: edit clear-location --query 'location:<location>'
  contact-notes <address book>          fill notes from the address book (as --contacts): each contact's company,
                                        department, job title and note, for the people its numbers and
                                        emails belong to; only notes that are empty or as it last wrote them
  rules                                 run the rules now: link new accounts, join exact names, archive
                                        rules, proposals (they also run after every import)
  coverage                              what each platform's imports cover, and how stale they are
  import-status [--json]                for an import session: each connector the archive has had imports from,
                                        how a fresh copy is had (live, this Mac, an iPhone backup, or the platform's
                                        own export), its last import, how far it reaches, and what to do next; then
                                        those never imported (docs/import-runbook.md has each one's steps)
  exports move-imports [--apply]        where each export waiting in data/imports/<platform>-<date>/ goes:
                                        data/platform-exports/<platform>/<date>/; --apply moves them (renames only)
  exports unpack <folder>               unpack the zips at the top of an export's folder into that folder, keeping
                                        them; checked, never writing over a file, so it can be run again
  media repoint [--apply]               the dry run: per platform, attachments still on a copy in data/archive/media/
                                        that re-point to the same file (size and SHA-256) in the newest export holding
                                        it, or to a copy in platform-exports/<platform>/live/ for media with no export
                                        (live connectors), and those that cannot be matched; --apply makes it, logged
                                        to data/archive/repoint-<time>.jsonl. Nothing is deleted: it ends with the
                                        copies nothing points at any more, which are the captain's to delete
  repair messenger-phone-chats [--apply]
                                        the dry run: the chats Messenger's phone export brought in twice (before it
                                        kept a chat by its name, without the export's number for its file), and those
                                        whose key moved: each first chat, which takes its new key, and each copy merged
                                        into it and deleted, with its messages and its "Facebook user" account; and the
                                        photos sent together it brought in twice in any chat (before it told them apart
                                        by their place, not their file names), which take new ids and merge; --apply
                                        makes it, after a checked backup (refused without one), and runs the rules.
                                        An unsent message's text, which its id was made with and the archive does not
                                        keep, is read from the phone exports in data/platform-exports/messenger/. Run
                                        again, it finds nothing to do; until it has run, a messenger-export import is
                                        refused
  storage                               what the data folder holds: in all, and per platform its messages (its share
                                        of archive.sqlite), exports (zips and unpacked), media pointed at, and copies
                                        in data/archive/media/ nothing points at
  groups [words ...]                    group chats whose title has these words (or all), latest first, each with
                                        its number (for a query's group:#n), platform, size and last message
  groups --person <person>              the group chats someone is in
  groups --dropped                      the group chats you dropped
  group drop <group>                    drop a group chat (a bulk message to people who don't know each other): it
                                        links nobody and counts in nothing worked out from group chats, though its
                                        messages stay; a re-import keeps it dropped
  group restore <group>                 bring a dropped group chat back
  group remove-member <group> <person>  take someone who never wrote in a group chat out of it (added by mistake):
                                        they are no member of it in anything worked out from group chats, though
                                        its messages stay; a re-import keeps them out
  group put-back <group> <person>       put someone taken out of a group chat back
  groups --removed                      everyone taken out of a group chat
  catch-ups [--person <person>]         every catch-up (time with people in person), or someone's, the latest
                                        first: its number, date and time (a trip's first to last, with its private
                                        hours), hours, who was there and its note
  catch-up add <person> [person ...] [--day <YYYY-MM-DD>] [--time <HH:MM>] [--hours <hours>] [--note <text>] [--others <n>]
      [--until <YYYY-MM-DD> --end <HH:MM> [--private <HH:MM-HH:MM>]]
                                        time in person with these people: today, with no time, for an hour,
                                        unless said (--time is when it started, 19:30, in ${zonePlace()}: where it
                                        sits in their chat; hours may be 1.5, up to 24; a call is logged as a
                                        call, with call add; --others says how many more were
                                        there unnamed, 0 unless said); it counts toward their closeness as its
                                        hours times the settings' worth of an hour, times each one's share
                                        with everyone at it, the others too (groupSharedPart). --until and --end
                                        make it a trip over several days (away together, in person, up to 366 days,
                                        both ends counted), from --day at --time, which it then needs, to --until at
                                        --end, less each day's private hours (--private, 00:00-10:00 unless said;
                                        23:00-07:00 runs across midnight): its hours are the time together that
                                        leaves, worked out (--hours is not needed), each day counting its own
  catch-up change <catch-up> [--people <person,person,...>] [--day ...] [--time ...] [--hours ...]
      [--note ...] [--others ...] [--until ... --end ... --private ... | --one-day]
                                        change what is given (--time "" and --note "" for none; --people says everyone who
                                        was there; --one-day makes a trip one day again, with --hours)
  catch-up delete <catch-up>
  calls [<person>]                      everyone's calls (the phone's call history, the other apps' calls of known
                                        length, and those you logged), the most time on answered calls first: how
                                        many were answered, for how long in all, how many were not, and the last;
                                        or one person's calls, newest first (those you logged with their number)
  call add <person> [person ...] --time <HH:MM> --minutes <length> [--day <YYYY-MM-DD>] [--account <account> ...] [--note <text>] [--others <n>]
                                        log a call with one or more people: today unless said, started at
                                        --time in ${zonePlace()}, lasting --minutes (25, or 1:30 for an hour and a
                                        half), with each on one of their accounts that carries calls: an
                                        --account of theirs (one --account for each person you choose for),
                                        unless said the one their latest call was on, else their phone one,
                                        else the first. Each counts as a call imported on that account does,
                                        except that a call with several people counts each one's share of
                                        its time, as a catch-up does (--others says how many more were on it
                                        unnamed, 0 unless said), and that one on the phone or FaceTime with one
                                        person and that day's calls from the call history count the longer,
                                        never both (it may be one of them). Someone with no such account: on --app instead (phone
                                        unless said; facetime, whatsapp, messenger, instagram, signal, telegram,
                                        wechat, discord or other).
                                        --note gives it a note, as a catch-up's
  call change <call> [--people <person,person,...>] [--day ...] [--time ...] [--minutes ...] [--account ...] [--app ...] [--note ...] [--others ...]
                                        change what is given, for everyone on it (--note "" for none; --people says everyone on it;
                                        each stays on their account, someone new on their usual one, unless an
                                        --account of theirs says otherwise)
  call delete <call>                    delete it, for everyone on it


Changing people: every command above that changes people, and edit and changes undo below, is one changeset in
the change log, made after a checked backup (see backup), and says its number. --why <words> keeps the captain's
words with it; --into <changeset> adds the change to the newest changeset instead, so one instruction that takes
several edits is undone as one.
  edit <what> (--query <query> | --people <person,person,...>)
                                        the dry run: who it would change, before and after, and who is that way
                                        already; nothing is written. --query chooses everyone it matches, archived
                                        people too (the query language, group:"Title" or group:#n for the
                                        people in a group chat; or SQL, a read-only SELECT returning person_id).
                                        <what> is one of:
                                          tag <tag ...> | untag <tag ...>   ("archive" hides them, "keep" keeps them)
                                          location <value ...> | clear-location
                                          reach-out | no-reach-out
                                          name <name ...> | aliases <alias> [alias ...] | clear-aliases (one person)
  edit <what> (--query ... | --people ...) --apply --expect <n> [--why <words>]
                                        make it, to the same choice, as one changeset; refused unless it would
                                        change exactly <n> people (the dry run's count)
  changes [--limit <n>]                 the change log, newest first: when, from the app or the cli, what, the
                                        captain's words, and who it touched (kept ${KEEP_DAYS} days)
  changes show <changeset>              everyone it touched, each before and after, and its backup
  changes undo <changeset> [--why <words>]
                                        put back exactly what it changed, as a changeset of its own; refused,
                                        naming who, when any of it has changed since`,
  content: `  timeline <person> [--limit <n>]       their messages, newest last
  search <words ...> [--person <person>]`,
};

/** Runs friend map's `command` with `args` and the parsed `values`, on `archive`. */
export async function friendMapCommand(archive: FriendMap, command: string, args: readonly string[], values: CliValues, live: CommandLive): Promise<void> {
  setCli({ values, archive, dataDir: archive.folder, live, made: null });
  let ran = await peopleCommands(command, args);
  if (ran === false) ran = await callCommands(command, args);
  if (ran === false) ran = await chatCommands(command, args);
  if (ran === false) throw new Error(`friend map has no command ${command}`);
  if (cli.made) {
    const { changeset, backup, undo } = cli.made;
    console.log(changeset === null ? "Nothing changed, so no changeset." : `Changeset #${changeset}, after the backup ${backup}; undo it with: npm run archive -- ${undo} undo ${changeset}`);
  }
}
