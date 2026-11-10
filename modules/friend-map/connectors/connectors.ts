// Friend map's connectors: one for each way a chat platform's history comes in (an export, an app's database, a live
// bridge), each with its manifest and the file the core's host runs in a process of its own (sdk/connector.ts), its
// imports applied to the archive (server/write.ts). The host lists them with its own (sdk/server.ts's ModuleConnectors).

import { fileURLToPath } from "node:url";
import type { ConnectorManifest } from "../../../sdk/server.ts";
import { manifest as callHistory } from "./call-history/manifest.ts";
import { manifest as discordPackage } from "./discord-package/manifest.ts";
import { manifest as facebookDyi } from "./facebook-dyi/manifest.ts";
import { manifest as imessageDb } from "./imessage-db/manifest.ts";
import { manifest as instagramDyi } from "./instagram-dyi/manifest.ts";
import { manifest as matrixBridge } from "./matrix-bridge/manifest.ts";
import { manifest as matrixWhatsapp } from "./matrix-whatsapp/manifest.ts";
import { manifest as messengerExport } from "./messenger-export/manifest.ts";
import { manifest as signalExport } from "./signal-export/manifest.ts";
import { manifest as wechatIos } from "./wechat-ios/manifest.ts";
import { manifest as whatsappDb } from "./whatsapp-db/manifest.ts";
import { manifest as xArchive } from "./x-archive/manifest.ts";

/** Every manifest, in their folders' order. */
export const MANIFESTS: readonly ConnectorManifest[] = [
  callHistory, discordPackage, facebookDyi, imessageDb, instagramDyi, matrixBridge, matrixWhatsapp, messengerExport, signalExport, wechatIos, whatsappDb, xArchive,
];

/** Each with the main.ts the host runs, its folder's. */
export const CONNECTORS = MANIFESTS.map((manifest) => ({ manifest, main: fileURLToPath(new URL(`./${manifest.id}/main.ts`, import.meta.url)) }));
