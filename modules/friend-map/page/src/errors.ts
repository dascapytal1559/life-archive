// Errors the page can't handle itself: logged, and shown by whoever listens for "friend-map:error".

export function reportError(error: unknown) {
  console.error(error);
  document.dispatchEvent(new CustomEvent("friend-map:error", { detail: String(error) }));
}
