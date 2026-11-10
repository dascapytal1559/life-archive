// Which row a table's drawer has open after an edit (openRow.ts), as the edits' answers have it (editWire.ts's
// EditDone: the row's id now, and `gone` with an empty id once it has left its table).

import { describe, expect, it } from "vitest";
import { openAfter } from "./openRow.ts";

const now = (id: string) => ({ id, gone: false });
const GONE = { id: "", gone: true };

describe("the drawer after an edit", () => {
  it("follows the row it has open to its id now, as an edit that gives it another does", () => {
    expect(openAfter("call:4:sms", "call:4:sms", now("call:4:signal"), "close")).toBe("call:4:signal");
    expect(openAfter("call:4:sms", "call:4:sms", now("call:4:sms"), "keep")).toBe("call:4:sms");
  });

  it("leaves another row open, or none, as it was", () => {
    expect(openAfter("hangout:9", "call:4:sms", now("call:4:signal"), "close")).toBe("hangout:9");
    expect(openAfter(null, "call:4:sms", GONE, "close")).toBeNull();
  });

  it("closes, from the table's Undo of an add, the added row's drawer, and so a cell edited after it opens nothing", () => {
    const open = openAfter("hangout:12", "hangout:12", GONE, "close");
    expect(open).toBeNull();
    expect(openAfter(open, "hangout:9", now("hangout:9"), "close")).toBeNull();
  });

  it("stays, from the drawer's own Undo of an add or its delete, on the row gone, never on the empty id, and follows it back", () => {
    const open = openAfter("hangout:12", "hangout:12", GONE, "keep");
    expect(open).toBe("hangout:12");
    expect(openAfter(open, "hangout:12", now("hangout:13"), "keep")).toBe("hangout:13");
  });
});
