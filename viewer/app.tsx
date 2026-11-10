// The life archive's page: the console (console/Console.tsx), the front end, started by main.tsx. The old viewer it
// replaced is gone, so any other address under /life-archive/ (the page's root, an old page's) opens the console's home,
// Events.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CONSOLE_PATH, isConsolePath } from "./console/address.ts";
import { Console } from "./console/Console.tsx";
import "./viewer.css";

if (!isConsolePath(location.pathname)) history.replaceState(null, "", CONSOLE_PATH);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Console />
  </StrictMode>,
);
