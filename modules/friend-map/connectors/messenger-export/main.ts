import { runConnector } from "../../../../sdk/connector.ts";
import { messengerExport } from "./read.ts";

await runConnector(messengerExport);
