#!/bin/sh
# Appends one event to events.jsonl beside this file, for the life archive's side on the Mac
# (the life archive's server/cuaExports/plan.ts reads them; PLAYBOOK.md says when to write which).
#
#   sh event.sh requested instagram from=2026-10-10 to=2026-10-21
#   sh event.sh pending facebook
#   sh event.sh downloaded facebook file=<name in ~/Downloads> [file=<another part>]...
#   sh event.sh needs-user instagram stop=code detail="the code dialog after Start export"
#   sh event.sh approval facebook request=<the Keyvault's request_id>
#   sh event.sh reentered facebook
#   sh event.sh unavailable discord until=2026-11-04
#   sh event.sh round
#
# For each file= it adds the file's size and SHA-256 from ~/Downloads. It prints the line it wrote.
# Never put a password, a code, a link, or anything from a message or an export into an event.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
[ $# -ge 1 ] || { echo "usage: sh event.sh <kind> [<platform>] [key=value]..." >&2; exit 2; }

for a do
  shift
  case $a in
    file=*)
      name=${a#file=}
      case $name in
        */* | .* | "" | *.crdownload | *.download) echo "event.sh: \"$name\" is not a finished download's name in ~/Downloads" >&2; exit 2 ;;
      esac
      f="$HOME/Downloads/$name"
      [ -f "$f" ] || { echo "event.sh: there is no $f" >&2; exit 2; }
      set -- "$@" "file=$name:$(stat -f %z "$f"):$(shasum -a 256 "$f" | cut -d' ' -f1)"
      ;;
    *) set -- "$@" "$a" ;;
  esac
done

js='function run(argv) {
  const [id, kind, ...rest] = argv;
  const event = { id, at: new Date().toISOString(), kind };
  if (rest.length > 0 && !rest[0].includes("=")) event.platform = rest.shift();
  for (const pair of rest) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error("not key=value: " + pair);
    const key = pair.slice(0, at), value = pair.slice(at + 1);
    if (key === "file") {
      const [sha256, bytes, ...name] = value.split(":").reverse();
      (event.files = event.files || []).push({ name: name.reverse().join(":"), bytes: Number(bytes), sha256 });
    } else event[key] = value;
  }
  return JSON.stringify(event);
}'
line=$(/usr/bin/osascript -l JavaScript -e "$js" "$(uuidgen | tr 'A-Z' 'a-z')" "$@")
printf '%s\n' "$line" >> "$here/events.jsonl"
printf '%s\n' "$line"
