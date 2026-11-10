// What a module's page half hears of an edit saved on the Events page's Tables (savedEdits.ts): the edit as the record
// keeps it, asked of the record only when some module listens, and never a failure of the edit's.

import { describe, expect, it, vi } from "vitest";
import type { ViewerDefinition } from "../sdk/viewer.ts";
import type { EditDone, EditRecord, EditsAnswer } from "./editWire.ts";
import type { ModuleViewer } from "./modules.ts";
import { type SavedEdit, tellSaved } from "./savedEdits.ts";

const done = (edit: number | null, gone = false): EditDone => ({ edit, id: "4", state: null, gone });

const logged = (id: number): EditRecord => ({
  id, action: "edit", at: 0, surface: "console", who: null, kind: "tags", module: "made-up", rowId: "4", field: "name",
  label: "Tag", before: "climbing", after: "bouldering", undoes: null, undoneBy: null, undone: null,
});

const listening = (id: string, saved: ViewerDefinition["saved"]): ModuleViewer => ({ id, viewer: { aspects: [], views: [], saved } });

describe("an edit saved, told to the modules' page halves", () => {
  it("is the edit the record keeps, asked of it by its number, to each module that listens", async () => {
    const heard: SavedEdit[] = [];
    const record = vi.fn(async (): Promise<EditsAnswer> => ({ edits: [logged(7)] }));
    const viewers = [listening("a", (edit) => heard.push(edit)), { id: "b", viewer: { aspects: [], views: [] } }, { id: "c", failed: "broken" }];
    await tellSaved("tags", done(7, true), { viewers: () => viewers, record });
    expect(record).toHaveBeenCalledWith({ kind: "tags", limit: 1, before: 8 });
    expect(heard).toEqual([{ module: "made-up", kind: "tags", field: "name", before: "climbing", after: "bouldering", gone: true }]);
  });

  it("tells an undo as the edit it is, asked of every table's record when its table is not known", async () => {
    const heard: SavedEdit[] = [];
    const record = vi.fn(async (): Promise<EditsAnswer> => ({ edits: [{ ...logged(9), before: "bouldering", after: "climbing", undoes: 7 }] }));
    await tellSaved(undefined, done(9), { viewers: () => [listening("a", (edit) => heard.push(edit))], record });
    expect(record).toHaveBeenCalledWith({ kind: undefined, limit: 1, before: 10 });
    expect(heard).toEqual([{ module: "made-up", kind: "tags", field: "name", before: "bouldering", after: "climbing", gone: false }]);
  });

  it("asks nothing of the record when nobody listens or nothing was changed", async () => {
    const record = vi.fn(async (): Promise<EditsAnswer> => ({ edits: [] }));
    await tellSaved("tags", done(7), { viewers: () => [], record });
    await tellSaved("tags", done(null), { viewers: () => [listening("a", () => undefined)], record });
    expect(record).not.toHaveBeenCalled();
  });

  it("tells nothing of another edit, and a module that fails, or a record that cannot be read, fails nothing", async () => {
    const heard: SavedEdit[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const viewers = [listening("a", () => { throw new Error("made-up failure"); }), listening("b", (edit) => heard.push(edit))];
    await tellSaved("tags", done(7), { viewers: () => viewers, record: async () => ({ edits: [logged(6)] }) });
    expect(heard).toEqual([]);
    await expect(tellSaved("tags", done(7), { viewers: () => viewers, record: async () => { throw new Error("offline"); } })).resolves.toBeUndefined();
    await tellSaved("tags", done(7), { viewers: () => viewers, record: async () => ({ edits: [logged(7)] }) });
    expect(heard).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
