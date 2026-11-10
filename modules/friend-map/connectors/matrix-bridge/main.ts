import { runConnector } from "../../../../sdk/connector.ts";
import { manifest } from "./manifest.ts";
import { matrixBridge } from "./read.ts";
import { TELEGRAM } from "./rig.ts";

await runConnector(matrixBridge(manifest, TELEGRAM));
