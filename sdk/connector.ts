// The SDK a module's connector imports (sdk.test.ts holds every module to the SDK's files): the connector contract
// (server/connectors/contract.ts: what a connector is, the events it writes, how it says what went wrong) and the
// child-process edge its main.ts runs (server/connectors/runtime.ts), so a module's connector is written as the core's
// own are, and the core's host runs it the same way (server/connectors/host.ts). A module's module.ts names each of
// them, with the file the host runs (sdk/server.ts's ModuleConnectors).

export { runConnector } from "../server/connectors/runtime.ts";
export {
  connectorError, ConnectorError, whole,
  type Connector, type ConnectorManifest, type Emit, type SportFamily, type StreamInfo, type WorkoutEvent,
  type WorkoutStream,
} from "../server/connectors/contract.ts";

// What the friend map module uses of the core's, as it was the core's own before it was a module.
export { EXPORTS_FOLDER } from "../server/archive/mediaPaths.ts";
export { isEncodedName, isNumberName, isPhone, isPlaceholderName, nameKey, normalizeHandle } from "../server/archive/names.ts";
export { type AccountEvent, type AttachmentType, type CallEvent, type CallService, type CommandOutcome, type ConnectorCommand, type ConversationEvent, type HistoryOptions, type MessageEvent, type MessageType, type Platform, type SyncOptions } from "../server/connectors/contract.ts";
export { expandHome, jsonLines } from "../server/connectors/lines.ts";
export { MediaLedger, keepInPlace, mediaTypeOf, unpackFirst } from "../server/connectors/media.ts";
export { type ZipEntry, ZipFile } from "../server/connectors/zip.ts";
export { REPO, archiveFolder, jobNode, jobPath } from "../server/dataHome.ts";
export { runPromise } from "../server/effectRuntime.ts";
export { installLaunchAgent, launchdPlist, takeLock } from "../server/jobs.ts";
export { dayKey } from "../src/time.ts";
