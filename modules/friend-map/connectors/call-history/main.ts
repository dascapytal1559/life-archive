import { runConnector } from "../../../../sdk/connector.ts";
import { callHistory } from "./read.ts";

await runConnector(callHistory);
