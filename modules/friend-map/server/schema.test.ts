import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./db.ts";
import { freshSchema } from "./schema.ts";

describe("the archive's schema", () => {
  it("is as the migrations make it, from an empty archive in memory", () => {
    const schema = freshSchema();
    expect(schema.version).toBe(SCHEMA_VERSION);
    const person = schema.tables.find((t) => t.name === "person")!;
    expect(person.columns[0]).toEqual({ name: "id", type: "INTEGER", primaryKey: 1, notNull: false });
    const importPerson = schema.tables.find((t) => t.name === "import_person")!;
    expect(importPerson.foreignKeys).toEqual([{ column: "person_id", table: "person", to: "id" }]);
    expect(importPerson.unique).toEqual([["platform", "key"]]);
    const fts = schema.tables.find((t) => t.name === "message_fts");
    expect(fts).toEqual({ name: "message_fts", kind: "virtual", columns: [{ name: "text", type: "", primaryKey: 0, notNull: false }], foreignKeys: [], unique: [] });
    expect(schema.tables.some((t) => t.name.startsWith("message_fts_") || t.name.startsWith("sqlite_"))).toBe(false);
  });
});
