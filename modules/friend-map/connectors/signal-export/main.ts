import { runConnector } from "../../../../sdk/connector.ts";
import { signalExport } from "./read.ts";

await runConnector(signalExport);
