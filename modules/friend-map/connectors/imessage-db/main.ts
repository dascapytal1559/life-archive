import { runConnector } from "../../../../sdk/connector.ts";
import { imessageDb } from "./read.ts";

await runConnector(imessageDb);
