#!/bin/sh
# Opens the Chrome profile the export agent uses (friend-map-exports) at the four export pages, for the captain to sign
# in, or to clear a stop a round left. Quit it (Chrome > Quit Google Chrome) when done: a round cannot use the profile
# while this window has it. Put on the Space's Desktop by the life archive's npm run cua-exports -- setup.
exec open -na "Google Chrome" --args \
  --user-data-dir="$HOME/Library/Application Support/CuaDriver/BrowserProfiles/friend-map-exports" \
  --no-first-run --no-default-browser-check \
  https://accountscenter.instagram.com/info_and_permissions/dyi/ \
  https://accountscenter.facebook.com/info_and_permissions/dyi/ \
  https://www.messenger.com/ \
  https://discord.com/channels/@me
