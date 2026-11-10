// Imported after onPinnedNode.ts and before onSettings.ts by check-data, whose argument is the archive's folder: as
// onDataFlag.ts does for --data.

import { resolve } from "node:path";

if (process.argv[2]) process.env.LIFE_ARCHIVE_DATA = resolve(process.argv[2]);
