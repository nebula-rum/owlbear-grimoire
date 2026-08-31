// Shared constants + helpers for opening Grimoire's viewer modal — used by
// the sidebar popover (direct clicks) and by background.ts (reacting to a
// GM's "present to players" broadcast), so both open it identically.
import OBR from "@owlbear-rodeo/sdk";

export const VIEWER_MODAL_ID = "dev.fede.grimoire/viewer";

// Broadcast channel the GM uses to force-open an item on every connected
// client ("present to players" / "push to table"). See background.ts for
// the listening side — it's a background script rather than something
// wired up in main.ts specifically so it still works for players who don't
// have the sidebar popover open when the GM presents something.
export const PRESENT_CHANNEL = "dev.fede.grimoire/present";
export interface PresentMessage {
  itemId: string;
}

// Sized to show a whole portrait PDF page (US Letter/A4-ish ratio) at a
// readable scale once the reader's thumbnail rail and toolbar are accounted
// for, while still leaving the scene visible around it rather than going
// full-screen. Owlbear's modal has no explicit centering option — per its
// SDK types there's nothing to set beyond width/height/fullScreen — but its
// dialogs center by default, same as other extensions that just pass a
// fixed size.
export const VIEWER_WIDTH = 880;
export const VIEWER_HEIGHT = 1040;

function resolveUrl(path: string): string {
  return new URL(path, window.location.href).toString();
}

/**
 * Opens (or re-targets, if already open) Grimoire's single viewer modal at
 * the given item. Safe to call from any of the extension's pages — the
 * popover, the background script, or the viewer itself — since they all
 * resolve viewer.html relative to their own URL and every page is deployed
 * under the same directory.
 */
export function openViewerModal(itemId: string): Promise<void> {
  return OBR.modal.open({
    id: VIEWER_MODAL_ID,
    url: resolveUrl(`viewer.html?id=${encodeURIComponent(itemId)}`),
    width: VIEWER_WIDTH,
    height: VIEWER_HEIGHT,
    // No dimmed backdrop, so the table — and, if Owlbear's shell allows it,
    // the extension's own sidebar popover — stays visible/usable behind the
    // viewer instead of being blocked out by it.
    hideBackdrop: true,
  });
}
