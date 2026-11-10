import { runConnector } from "../runtime.ts";
import { llmSessions } from "./read.ts";

await runConnector(llmSessions);
