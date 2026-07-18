// Pure predicate for the settings autosave echo-guard — extracted so the correctness invariant is
// unit-tested (not just asserted in a comment). The settings form deep-watches its mapping; a change
// should arm autosave ONLY when (a) the initial load has completed (`ready` — don't POST before we
// know the server state) and (b) the content actually differs from the last-saved snapshot. Point
// (b) suppresses the ECHO: load/save reseed `mapping` from the server response, which re-fires the
// watch with identical content — without the guard that would loop (reseed → save → reseed → …).

export function shouldAutosave(currentJson: string, lastSavedJson: string, ready: boolean): boolean {
  return ready && currentJson !== lastSavedJson
}
