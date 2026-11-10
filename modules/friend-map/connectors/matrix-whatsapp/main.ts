import { runConnector } from "../../../../sdk/connector.ts";
import { matrixBridge } from "../matrix-bridge/read.ts";
import { WHATSAPP } from "../matrix-bridge/rig.ts";
import { manifest } from "./manifest.ts";

await runConnector(matrixBridge(manifest, WHATSAPP));
