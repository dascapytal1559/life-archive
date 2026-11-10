import { runConnector } from "../../../../sdk/connector.ts";
import { whatsappDb } from "./read.ts";

await runConnector(whatsappDb);
