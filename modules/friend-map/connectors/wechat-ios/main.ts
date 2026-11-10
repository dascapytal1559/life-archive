import { runConnector } from "../../../../sdk/connector.ts";
import { wechatIos } from "./read.ts";

await runConnector(wechatIos);
