// Cross-frame plumbing for the GM's "Present to players" broadcast.
//
// background.ts (always running, even when the action popover is closed)
// listens for this broadcast and needs to tell main.ts which item to jump
// to once its popover actually opens — but there's no direct channel
// between two separate iframes for that beyond OBR's own broadcast (which
// main.ts, if already mounted, listens to directly instead — see its own
// PRESENT_CHANNEL handler in main.ts) or something durable both frames can
// read: localStorage, shared by same-origin frames within the same tab.
import OBR from "@owlbear-rodeo/sdk";

export const PRESENT_CHANNEL = "dev.fede.grimoire/present";
export interface PresentMessage {
  itemId: string;
}

const PENDING_KEY = "dev.fede.grimoire/pendingPresentedItem";

export function setPendingPresentedItem(itemId: string): void {
  try {
    localStorage.setItem(PENDING_KEY, itemId);
  } catch {
    // Ignore — worst case the popover just opens to the tree instead of
    // jumping straight to the presented item.
  }
}

/** Reads and clears the pending item in one step, so a later *normal* open
 *  of the popover never re-triggers an old present. */
export function consumePendingPresentedItem(): string | null {
  try {
    const value = localStorage.getItem(PENDING_KEY);
    if (value) localStorage.removeItem(PENDING_KEY);
    return value;
  } catch {
    return null;
  }
}

/** Called when a live (already-mounted) client handles a present broadcast
 *  directly, so background.ts's parallel write doesn't linger and get
 *  misread as pending on some later, unrelated popover open. */
export function clearPendingPresentedItem(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Ignore.
  }
}

export function broadcastPresent(itemId: string): Promise<void> {
  return OBR.broadcast.sendMessage(PRESENT_CHANNEL, { itemId } satisfies PresentMessage, { destination: "ALL" });
}
