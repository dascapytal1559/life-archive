# Personal message archive: Hermes, OpenClaw, and Messenger

Researched 2026-09-27. This note concerns a local archive of conversations with friends, including historical messages and ongoing updates. An assistant's own conversation history is a different data set.

Finding: Hermes and OpenClaw demonstrate persistent messaging adapters and local session storage, but neither checked official distribution provides personal Messenger archival ingestion. A promising design is initial Meta exports plus an optional passive mautrix-meta collector for new messages, with periodic exports to repair gaps. This is a proposed architecture, not a tested integration.

## Hermes Agent

Reviewed the public `NousResearch/hermes-agent` source at commit [`b4410b4baddbc83732241c655ff39ac72ffba865`](https://github.com/NousResearch/hermes-agent/commit/b4410b4baddbc83732241c655ff39ac72ffba865), committed 2026-09-27, plus the official documentation. No local Hermes credentials, configuration, or private messages were inspected.

### What it connects to

Hermes' gateway receives messages through platform adapters, routes them to per-chat sessions, and invokes its AI agent. Its published platform list and the checked source contain no native Facebook Messenger adapter. This is a finding about this revision and official distribution, not a claim that no third-party plugin could exist. [Gateway architecture](https://hermes-agent.nousresearch.com/docs/user-guide/messaging), [checked platform adapters](https://github.com/NousResearch/hermes-agent/tree/b4410b4baddbc83732241c655ff39ac72ffba865/plugins/platforms), [adapter registry](https://github.com/NousResearch/hermes-agent/blob/b4410b4baddbc83732241c655ff39ac72ffba865/gateway/platform_registry.py)

The access mechanism varies by platform. Telegram uses a bot token; that is an assistant account, not a login to the user's personal Telegram inbox. WhatsApp can instead use a Baileys bridge that emulates a linked WhatsApp Web session. The official WhatsApp guide distinguishes this unofficial personal-account bridge from the separate WhatsApp Business Cloud API integration. [Telegram setup](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram), [WhatsApp setup](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp)

### What it retains locally

`~/.hermes/state.db` is the canonical SQLite store for agent sessions and messages, with full-text search. Its schema is organized around sessions and model turns: role, content, tool calls, reasoning, tokens, timestamps, and optional platform message IDs. It is suitable for resuming and searching conversations with the agent; it is not itself a complete normalized archive of every conversation on an attached account. The latter is an inference from the schema and the adapter filters below. [Session storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage), [message schema](https://github.com/NousResearch/hermes-agent/blob/b4410b4baddbc83732241c655ff39ac72ffba865/hermes_state_common.py#L428-L457)

Retention matters: the checked defaults enable automatic pruning of ended sessions after 90 inactive days. Open, pinned, and active sessions are protected; `sessions.auto_prune: false` disables this pruning. A permanent archive should not inherit an agent runtime's session lifecycle accidentally. [Session documentation](https://hermes-agent.nousresearch.com/docs/user-guide/sessions), [retention defaults](https://github.com/NousResearch/hermes-agent/blob/b4410b4baddbc83732241c655ff39ac72ffba865/hermes_cli/config_defaults.py#L2239-L2253)

### Why a connected channel is not a complete archive

These are specific observations from the checked source, not universal limits of the underlying messaging services:

- **WhatsApp:** the bridge sets `syncFullHistory: false` and says it does not maintain a message store. Self-chat mode accepts the owner's messages to themselves and drops other people's messages. Bot mode uses admission rules, and owner-written messages require an explicit forwarding option; messages sent by the owner to groups are dropped. These choices serve an assistant, not two-sided historical capture. [Socket setup](https://github.com/NousResearch/hermes-agent/blob/b4410b4baddbc83732241c655ff39ac72ffba865/scripts/whatsapp-bridge/bridge.js#L386-L405), [message filters](https://github.com/NousResearch/hermes-agent/blob/b4410b4baddbc83732241c655ff39ac72ffba865/scripts/whatsapp-bridge/bridge.js#L517-L639)
- **Matrix:** the adapter polls Matrix sync responses, but its inbound handler skips its own messages, certain bridge/system senders, events older than startup minus five seconds, and edits. It additionally applies room and mention policies. Connecting Hermes to a Matrix bridge therefore does not make Hermes an archival consumer of that bridge. [Sync loop](https://github.com/NousResearch/hermes-agent/blob/b4410b4baddbc83732241c655ff39ac72ffba865/plugins/platforms/matrix/adapter.py#L1847-L1885), [inbound filtering](https://github.com/NousResearch/hermes-agent/blob/b4410b4baddbc83732241c655ff39ac72ffba865/plugins/platforms/matrix/adapter.py#L1979-L2026), [Matrix behavior](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/matrix)
- **Telegram:** there is an optional feature to store unmentioned group chatter as context without triggering a response. It still requires the bot to receive those messages and explicit configuration; it does not grant access to the user's other private conversations. [Observed group context](https://github.com/NousResearch/hermes-agent/blob/b4410b4baddbc83732241c655ff39ac72ffba865/website/docs/user-guide/messaging/telegram.md#L220-L244)

### Useful design lesson

Inference: borrow Hermes' separation of platform adapters, persistent storage, and consumers, but store raw message events in an archive before any bot/mention policy or AI processing. Initial history import, live updates, edit/delete semantics, participant identity, attachment storage, retry cursors, and coverage reporting should belong to the archive. An assistant can query that archive afterward. Installing Hermes alone does not solve personal Messenger ingestion.

## OpenClaw

Reviewed public source at [`168ebc5b67080909f825858d16308a94278c5342`](https://github.com/openclaw/openclaw/commit/168ebc5b67080909f825858d16308a94278c5342), committed 2026-09-27. This revision matters: older descriptions of a JSONL-only session store are out of date.

### Connections and durable delivery

The checked official channel catalog has no Facebook Messenger integration. Telegram uses the Bot API; WhatsApp uses a persistent WhatsApp Web connection through Baileys, paired by QR code. Neither mechanism involves exporting the user's account daily. A channel's access depends on the underlying protocol and account type. [Channel catalog](https://github.com/openclaw/openclaw/blob/168ebc5b67080909f825858d16308a94278c5342/docs/channels/index.md#L37-L75), [WhatsApp guide](https://docs.openclaw.ai/channels/whatsapp), [Telegram guide](https://docs.openclaw.ai/channels/telegram)

The WhatsApp implementation handles `messages.upsert` events of type `notify` and `append`, persists received payloads in a durable queue, and uses the conversation ID plus message ID for deduplication. Processing is ordered per conversation. This is a useful design for reliable live ingestion. [Event handling](https://github.com/openclaw/openclaw/blob/168ebc5b67080909f825858d16308a94278c5342/extensions/whatsapp/src/inbound/message-delivery.ts#L479-L581), [queue identity and delivery](https://github.com/openclaw/openclaw/blob/168ebc5b67080909f825858d16308a94278c5342/extensions/whatsapp/src/inbound/durable-receive.ts)

However, it serves agent delivery: old `append` events are normally excluded from agent processing outside a bounded reconnect window, recent agent-send echoes are skipped, and completed queue entries have seven-day retention plus a 5,000-entry cap. That queue is not a permanent message archive. [Age gate](https://github.com/openclaw/openclaw/blob/168ebc5b67080909f825858d16308a94278c5342/extensions/whatsapp/src/inbound/message-delivery.ts#L200-L215), [dispatch filters](https://github.com/openclaw/openclaw/blob/168ebc5b67080909f825858d16308a94278c5342/extensions/whatsapp/src/inbound/message-delivery.ts#L409-L442), [queue retention](https://github.com/openclaw/openclaw/blob/168ebc5b67080909f825858d16308a94278c5342/extensions/whatsapp/src/inbound/durable-receive.ts#L130-L150)

### Session history is a separate concern

Current OpenClaw stores runtime session rows and transcripts in per-agent `openclaw-agent.sqlite`. Maintenance normally archives eligible durable sessions after 30 days; it does not simply delete all history at 30 days. Disk-budget cleanup can delete eligible cap-generated archives, and synthetic automation sessions have different retention. These are agent-session semantics rather than a permanent personal-message archive contract. [Pinned session documentation](https://github.com/openclaw/openclaw/blob/168ebc5b67080909f825858d16308a94278c5342/docs/concepts/session.md#L226-L363)

Matrix support can connect an agent to bridged rooms, but has admission policies and bounded history context. Some channels, including Matrix, send introductions on joining allowed groups by default. Inference: a passive archive collector should be a distinct component with no automatic reply path; merely adding an AI agent to bridged rooms changes behavior. [Matrix configuration](https://docs.openclaw.ai/channels/matrix), [join introductions](https://github.com/openclaw/openclaw/blob/168ebc5b67080909f825858d16308a94278c5342/docs/channels/index.md#L83-L122)

## Messenger bridges and recommendation

### A route to personal Messenger

Reviewed `mautrix/meta` at [`87cb97a5ff42429daf65733ab0d2813b689cf5bc`](https://github.com/mautrix/meta/commit/87cb97a5ff42429daf65733ab0d2813b689cf5bc), committed 2026-09-26. Matrix's own directory lists mautrix-meta as a personal Messenger/Instagram bridge and marks the older mautrix-facebook bridge obsolete. [Matrix bridge directory](https://www.matrix.org/ecosystem/bridges/facebook_messenger/)

This uses the user's logged-in Facebook/Messenger session and registers a device for encrypted messages. It is an unofficial client integration, distinct from Meta's Page messaging API. The normal packaged setup requires a Matrix homeserver with application-service support. [Authentication](https://docs.mau.fi/bridges/go/meta/authentication.html), [device connection](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/pkg/connector/client.go#L468-L526), [setup](https://docs.mau.fi/bridges/go/setup.html?bridge=meta)

### Live capture and historical limits

The source handles live encrypted Messenger events, including messages, edits, reactions, and deletions. Although some implementation names refer to WhatsApp, that library also implements Messenger's encrypted protocol; a separate WhatsApp account is not required for Messenger. Self-sender handling indicates that messages sent from the user's other devices are intended to be received too, but this needs a real account test before claiming complete two-sided capture. [Encrypted events](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/pkg/connector/handlewhatsapp.go#L21-L38), [event classification](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/pkg/connector/events.go#L404-L469), [self-sender detection](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/pkg/connector/ids.go#L20-L29)

**It does not replace the encrypted-history export.** The roadmap explicitly leaves encrypted Messenger message history / reading chat backup unsupported. The backfill implementation skips `ENCRYPTED_OVER_WA_GROUP`; other paths need Facebook-style message anchors. Older unencrypted history and thread enumeration are supported, but neither establishes encrypted-backup access. [Roadmap](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/ROADMAP.md#L107-L140), [backfill implementation](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/pkg/connector/backfill.go#L185-L241)

Offline-sync and reconnect handling exist. No verified Messenger-specific outage-retention window or complete recovery guarantee was found. A Mac waking from sleep therefore needs coverage checks; WhatsApp-specific buffering comments cannot establish Messenger guarantees. [Offline sync](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/pkg/connector/handlewhatsapp.go#L75-L106), [reconnect](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/pkg/messagix/e2ee-client.go#L36-L52)

### Where the content lives

The bridge database is not the desired searchable message archive: message rows mainly map remote IDs to Matrix event IDs with sender/time/reply metadata. There are also credentials, encryption state, and temporary retry buffers, so it would be wrong to describe the database as containing no sensitive content. Actual bridged messages go to Matrix events; attachments normally download/decrypt and upload to Matrix's media store. Optional direct-media mode uses retrieval metadata instead, which is less suitable for an independent durable archive. [Message mapping schema](https://github.com/mautrix/go/blob/c6024bacd2e6f89e2aca177d9a5efcd5545568a9/bridgev2/database/message.go#L33-L53), [temporary buffers](https://github.com/tulir/whatsmeow/blob/0057a822e79a5e81584f24b3b4cabf07c2a936d0/store/sqlstore/upgrades/00-latest-schema.sql#L160-L182), [attachment handling](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/pkg/msgconv/from-whatsapp.go#L196-L262)

The pinned bridge framework supports SQLite and PostgreSQL, while the rolling setup guide recommends PostgreSQL. This does not mean a SQLite bridge file contains the full conversation content. [Pinned database configuration](https://github.com/mautrix/go/blob/c6024bacd2e6f89e2aca177d9a5efcd5545568a9/bridgev2/matrix/mxmain/example-config.yaml#L172-L185)

### Proposed architecture for friend-map

```text
Meta export archives --------> archive importer ----+
                                                   |
Messenger -> mautrix-meta -> local Matrix -> collector -> local message DB
                                                           |
                                                    friend-map / search
```

The collector would consume Matrix events and persist a separate archive with platform message IDs, participant IDs, original timestamps, edits/reactions/deletions, attachment bytes, and import provenance. It would operate without automatic AI replies. Cross-format message matching between export IDs and bridge IDs remains an implementation question to validate against real samples; it must not be assumed exact.

There is also a smaller custom route: use the bridge's Go `messagix` and `whatsmeow` libraries directly, writing events to our database without Matrix. Their client/event interfaces make this plausible, but this is an engineering inference, not a packaged archival mode. It trades fewer running services for maintaining a custom adapter to an unofficial protocol. [messagix client interface](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/pkg/messagix/client.go#L30-L104), [event handler](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/pkg/messagix/client.go#L220-L237)

For an initial implementation, use the two Meta exports as the historical baseline. A bridge pilot can establish whether ongoing capture is dependable enough to reduce routine exports. Periodic exports remain useful to audit and repair gaps. Before trusting the pilot, verify incoming and own-device outgoing messages, edits, reactions, media, duplicate delivery, restart, and sleep/reconnect behavior.

The material operational tradeoff is account-session maintenance: the bridge holds session credentials and encryption keys, Meta may request reauthentication or suspicious-activity checks, and upstream protocol changes can break connectivity. The bridge's August 2026 changelog records a server change that required a connection repair. [Authentication caveats](https://docs.mau.fi/bridges/go/meta/authentication.html), [recent compatibility repair](https://github.com/mautrix/meta/blob/87cb97a5ff42429daf65733ab0d2813b689cf5bc/CHANGELOG.md#L16-L18)

This research did not install Hermes, OpenClaw, Matrix, or a bridge; connect an account; inspect private configuration; or change friend data. It does not establish end-to-end archive completeness for this account.
