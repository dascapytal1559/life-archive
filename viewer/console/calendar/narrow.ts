// Whether the screen is a phone's, at the console's own break (console.css), followed as it changes.

import { useEffect, useState } from "react";

const PHONE = "(max-width: 899px)";

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matchMedia(PHONE).matches);
  useEffect(() => {
    const media = matchMedia(PHONE);
    const follow = () => setNarrow(media.matches);
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);
  return narrow;
}
