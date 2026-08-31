// Grimoire's background script (see manifest.json's `background_url`).
// Owlbear loads this invisibly for every connected client — GM and players
// alike — regardless of whether anyone has the sidebar popover open. Its
// only job is listening for the GM's "present to players" broadcast and
// forcing this client's popover open to the presented item.
//
// This has to live here rather than in main.ts: the sidebar popover is only
// mounted while it's actually open (clicking the toolbar button), so a
// listener registered there would miss the broadcast for any player who
// doesn't happen to have it open at that moment — exactly the case a
// "push this to everyone's screen right now" feature needs to handle.
import OBR from "@owlbear-rodeo/sdk";
import { PRESENT_CHANNEL, PresentMessage, setPendingPresentedItem } from "./present";

OBR.onReady(() => {
  OBR.broadcast.onMessage(PRESENT_CHANNEL, (event) => {
    const data = event.data as Partial<PresentMessage> | undefined;
    if (data && typeof data.itemId === "string") {
      setPendingPresentedItem(data.itemId);
      void OBR.action.open();
    }
  });
});
