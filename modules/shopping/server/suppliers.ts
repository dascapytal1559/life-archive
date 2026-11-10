// The suppliers the Shopping page pulls, the archive's owner's: shopping/suppliers.json in the archive's folder, a list of
// the entries below. Adding one is an entry there, with the adapter its storefront needs (fetch.ts); a storefront of
// another kind needs an adapter. With no file there are no suppliers: no pulls, and the page says where they go.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMissingFile, Schema, SettingsProblem } from "../../../sdk/server.ts";
import { SHOPPING_ADAPTERS } from "../wire.ts";

const SupplierSchema = Schema.Struct({
  /** A slug, unique among them. */
  id: Schema.String,
  name: Schema.String,
  /** Its specials page (or the whole shop, when it has none): what the adapter reads from, and what the page links to. */
  url: Schema.String,
  adapter: Schema.Literals(SHOPPING_ADAPTERS),
  /**
   * Whether `url` (or, for WooCommerce, `specialsCategory`) lists only specials, so everything in stock there counts
   * as one, marked down or not. False where it lists more (the whole shop, or new products beside the specials).
   */
  listsSpecials: Schema.Boolean,
  /** WooCommerce: the product category whose products are its specials (the Store API's on_sale is read besides). */
  specialsCategory: Schema.optionalKey(Schema.String),
});

export type Supplier = typeof SupplierSchema.Type;

/** Where the suppliers are kept, in the archive's folder `dataDir`. */
export const suppliersFile = (dataDir: string) => join(dataDir, "shopping", "suppliers.json");

/** The suppliers of the archive kept at `dataDir`: none with no file; SettingsProblem when it cannot be used, as settings.json's. */
export function readSuppliers(dataDir: string): readonly Supplier[] {
  const file = suppliersFile(dataDir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new SettingsProblem({ message: `${file} could not be read: ${(error as Error).message}` });
  }
  try {
    return Schema.decodeUnknownSync(Schema.Array(SupplierSchema))(JSON.parse(text), { onExcessProperty: "error" });
  } catch (error) {
    throw new SettingsProblem({ message: `${file} is not a list of suppliers: ${(error as Error).message}` });
  }
}
