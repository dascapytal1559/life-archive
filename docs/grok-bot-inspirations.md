# Inspirations from Grok Bot: the instruction to paste

Paste the text below into the charter of the Grok Bot agent that should keep the captain's inspirations (features.md's "Inspirations"). It runs on this Mac, so it uses the archive's own command; no MCP or server of its own is needed.

---

**Keeping the captain's inspirations.** When the captain sends you something to keep (a link to an Instagram post or reel, an X post, a YouTube video, a web page, or a photo or screenshot), usually with a line about how it makes him feel, keep it in his life archive:

1. Look at it with your logins (Instagram and X need them), so you can say what it is: a short title, who made it (the account or channel), and a sentence or two on what it shows. Do not download its media.
2. In a terminal on this Mac, run, from `~/Projects/life-archive`:

   ```sh
   export PATH="$HOME/.vite-plus/bin:$PATH"
   npm run --silent archive -- inspiration add "<the link>" \
     --caption "<the captain's own words, exactly as he wrote or said them>" \
     --title "<a short title of what it is>" \
     --author "<the account or channel, e.g. @someone>" \
     --description "<one or two sentences on what it shows>" \
     --origin grok-bot --wait
   ```

   - For a photo or screenshot he sent, save it to a file first and give its path instead of the link (`inspiration add ~/Downloads/<file>.png ...`); with a link too, add `--file <path>` beside the link.
   - If he names tags ("this is parenting and art"), add `--tag parenting,art`. Never invent tags of his: the archive adds the AI's own tags by itself, kept apart.
   - Leave out a flag you have nothing for. Quote every value.
3. Tell him in one line what it printed: the item's number, whether it was new or another save of something he kept before, and its AI tags (for example: "Kept as #42, new. AI tags: ceramics, craft, parenting").
4. If the command fails, tell him its error as it is; do not retry with made-up values. If the AI tags are "still waiting", the archive's server may be down: say so.

Other things he may ask, each through the same command (`npm run --silent archive -- ...`): `inspiration list --tag <tag>` or `--ai-tag <tag>` or `--search <words>` to find things, `inspiration show <n>`, `inspiration tag <n> <tag ...>` and `untag`, `inspiration caption <n> "<words>"`, `inspiration hide <n>`. Each change but `add` is undoable: say the changeset number it prints, and that `npm run archive -- changes undo <number>` (or Undo on the Inspirations page) puts it back.
