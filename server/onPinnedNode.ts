// Imported first by each entry point (npm start, npm run archive, npm run
// check-data), so a wrong Node stops before anything else loads (nodeVersion.ts).

import { requirePinnedNode } from "./nodeVersion.ts";

requirePinnedNode();
