// Shared constants + helpers for opening Grimoire's viewer popover — used by
// the sidebar popover (direct clicks) and by background.ts (reacting to a
// GM's "present to players" broadcast), so both open it identically.
import OBR from "@owlbear-rodeo/sdk";

export const VIEWER_POPOVER_ID = "dev.fede.grimoire/viewer";

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
// for, while still leaving the scene visible around it.
export const VIEWER_WIDTH = 880;
export const VIEWER_HEIGHT = 1040;

// Docks the popover's top-left corner near the toolbar instead of Owlbear's
// default modal centering — same left-aligned-panel feel as GM Vault's
// viewer. Unlike OBR.modal (see the SDK's Modal type: only
// width/height/fullScreen/hideBackdrop/hidePaper/disablePointerEvents, no
// position), OBR.popover exposes anchorReference/anchorPosition/
// transformOrigin (mirrors MUI's Popover props), so a fixed on-screen
// position is actually supported here. These px values are a first guess at
// clearing Owlbear's own toolbar — nudge them once you can eyeball it in a
// real room.
const ANCHOR_LEFT = 90;
const ANCHOR_TOP = 16;

function resolveUrl(path: string): string {
  return new URL(path, window.location.href).toString();
}

/**
 * Opens (or re-targets, if already open) Grimoire's single viewer popover at
 * the given item. Safe to call from any of the extension's pages — the
 * sidebar popover, the background script, or the viewer itself — since they
 * all resolve viewer.html relative to their own URL and every page is
 * deployed under the same directory.
 */
export function openViewerPopover(itemId: string): Promise<void> {
  return OBR.popover.open({
    id: VIEWER_POPOVER_ID,
    url: resolveUrl(`viewer.html?id=${encodeURIComponent(itemId)}`),
    width: VIEWER_WIDTH,
    height: VIEWER_HEIGHT,
    anchorReference: "POSITION",
    anchorPosition: { left: ANCHOR_LEFT, top: ANCHOR_TOP },
    transformOrigin: { horizontal: "LEFT", vertical: "TOP" },
    // Popovers (unlike the old modal) have no backdrop to begin with, but
    // they do close on any click outside them by default — disable that so
    // clicking the table to move a token, etc. doesn't dismiss the viewer.
    disableClickAway: true,
  });
}
