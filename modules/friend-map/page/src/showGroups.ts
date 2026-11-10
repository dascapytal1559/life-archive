// Whether a person's panel counts and shows what they said in group chats as
// well as your one-to-one chats with them: off on every page load until you
// tick "Show group messages", then kept for the rest of the visit, so it
// carries from one person's panel to the next. It is not kept in the browser.

import { useState } from "react";

let chosen = false;

export function useShowGroups(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(chosen);
  const choose = (next: boolean) => {
    chosen = next;
    setValue(next);
  };
  return [value, choose];
}
