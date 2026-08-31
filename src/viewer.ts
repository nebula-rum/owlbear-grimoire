// The OBR.popover content that actually displays a handout: a Drive PDF
// preview iframe, rendered Markdown, or a plain external link. Also owns a
// slide-out "Browse" drawer so the GM/player can switch which item is shown
// without leaving the popover, and (GM-only) a "Present to players" button
// that force-opens the current item on every connected screen via a
// broadcast (see viewerPopover.ts / background.ts).
import OBR from "@owlbear-rodeo/sdk";
import { initTheme } from "./theme";
import { loadVault, onVaultChange } from "./store";
import { driveFilePreviewUrl, driveFileViewUrl, fetchDriveThumbnail } from "./drive";
import { fetchRenderedMarkdown, MarkdownFetchError } from "./markdown";
import { renderPdfReader } from "./pdfReader";
import { childrenOf, isEffectivelyHidden, ancestorIds } from "./tree";
import { TYPE_META } from "./itemMeta";
import { VaultData, VaultItem, EMPTY_VAULT } from "./types";
import { VIEWER_POPOVER_ID, PRESENT_CHANNEL, PresentMessage } from "./viewerPopover";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === "class") node.className = v as string;
    else (node as any)[k] = v;
  });
  children.forEach((c) => node.append(c));
  return node;
}

function getItemId(): string | null {
  return new URLSearchParams(window.location.search).get("id");
}

/** The URL to send someone to if they want this open as a real browser tab
 *  instead of embedded here — the original Drive share link for pdf/markdown,
 *  or the item's own URL for a plain link. */
function externalUrlFor(item: VaultItem): string | null {
  if ((item.type === "pdf" || item.type === "markdown") && item.driveFileId) {
    return item.url ?? driveFileViewUrl(item.driveFileId);
  }
  if (item.type === "link" && item.linkUrl) {
    return item.linkUrl;
  }
  return null;
}

async function renderContent(
  item: VaultItem,
  apiKey: string | undefined,
  onProgress: (percent: number | null) => void,
): Promise<Node> {
  if (item.type === "pdf" && item.driveFileId) {
    // The full reader (page nav, zoom, thumbnail rail) needs the file's raw
    // bytes, which requires the same Drive API key Markdown rendering uses.
    // With a key, try it first and fall back to Drive's bare preview iframe
    // on any failure; without one, go straight to the iframe so PDFs still
    // work with zero setup.
    if (apiKey) {
      try {
        return await renderPdfReader(item.driveFileId, apiKey, onProgress);
      } catch (err) {
        console.error("Grimoire: PDF reader failed, falling back to the plain preview —", err);
      }
    }
    const iframe = el("iframe", { src: driveFilePreviewUrl(item.driveFileId), allow: "autoplay" });
    return iframe;
  }

  if (item.type === "markdown" && item.driveFileId) {
    if (!apiKey) {
      return el("div", { class: "center-message" }, [
        el("p", {}, ["No Google Drive API key is set yet, so this Markdown file can't be fetched and rendered."]),
        el("p", {}, [
          "Open the vault popover → ⚙ Settings and add a free API key (see the README's Markdown setup section).",
        ]),
        el(
          "a",
          { href: driveFileViewUrl(item.driveFileId), target: "_blank", rel: "noopener noreferrer", class: "btn" },
          ["Open the raw file in Google Drive instead"],
        ),
      ]);
    }
    try {
      const html = await fetchRenderedMarkdown(item.driveFileId, apiKey);
      const pane = el("div", { class: "markdown-pane" });
      pane.innerHTML = html;
      return pane;
    } catch (err) {
      const message = err instanceof MarkdownFetchError ? err.message : "Something went wrong rendering this file.";
      return el("div", { class: "center-message" }, [
        el("p", {}, [message]),
        el(
          "a",
          { href: driveFileViewUrl(item.driveFileId), target: "_blank", rel: "noopener noreferrer", class: "btn" },
          ["Open the raw file in Google Drive instead"],
        ),
      ]);
    }
  }

  if (item.type === "link" && item.linkUrl) {
    return el("div", { class: "center-message" }, [
      el("p", {}, ["This is an external link. Many sites block being shown inside another page, so it opens in a new tab instead."]),
      el("a", { href: item.linkUrl, target: "_blank", rel: "noopener noreferrer", class: "btn" }, ["Open link ↗"]),
    ]);
  }

  return el("div", { class: "center-message" }, [el("p", {}, ["Nothing to display for this item."])]);
}

// ---------------------------------------------------------------- state --

let vault: VaultData = structuredClone(EMPTY_VAULT);
let role: "GM" | "PLAYER" = "PLAYER";
let currentItemId: string | null = null;
let browseOpen = false;
const browseExpanded = new Set<string>();

let app: HTMLElement;
let headerEl: HTMLElement;
let contentEl: HTMLElement;
let browseBackdropEl: HTMLElement | null = null;
let browseDrawerEl: HTMLElement | null = null;

// ---------------------------------------------------------- browse drawer --

function renderBrowseNode(item: VaultItem, container: HTMLElement) {
  const wrapper = el("div", { class: "node" });
  const isFolder = item.type === "folder";
  const row = el("div", { class: `node-row${role === "GM" && item.hidden ? " hidden-item" : ""}` });

  if (isFolder) {
    const toggle = el("button", { class: "node-toggle", type: "button" }, [
      browseExpanded.has(item.id) ? "▾" : "▸",
    ]);
    toggle.onclick = () => {
      if (browseExpanded.has(item.id)) browseExpanded.delete(item.id);
      else browseExpanded.add(item.id);
      renderBrowseDrawer();
    };
    row.append(toggle);
  } else {
    row.append(el("span", { class: "node-toggle" }, [""]));
  }

  row.append(el("span", { class: "node-icon" }, [TYPE_META[item.type].icon]));

  if (isFolder) {
    const btn = el("button", { class: "node-name", type: "button" }, [item.name]);
    btn.onclick = () => {
      if (browseExpanded.has(item.id)) browseExpanded.delete(item.id);
      else browseExpanded.add(item.id);
      renderBrowseDrawer();
    };
    row.append(btn);
  } else {
    const active = item.id === currentItemId;
    const btn = el("button", { class: `node-name${active ? " active" : ""}`, type: "button" }, [item.name]);
    btn.onclick = () => void showItem(item.id);
    row.append(btn);
  }

  wrapper.append(row);

  if (isFolder && browseExpanded.has(item.id)) {
    const kids = childrenOf(vault.items, item.id).filter(
      (child) => role === "GM" || !isEffectivelyHidden(vault.items, child),
    );
    const childWrap = el("div", { class: "node-children" });
    kids.forEach((child) => renderBrowseNode(child, childWrap));
    wrapper.append(childWrap);
  }

  container.append(wrapper);
}

/** Rebuilds the slide-out item switcher from scratch. Safe (and cheap) to
 *  call any time state changes — it's a no-op beyond tearing down the old
 *  DOM when `browseOpen` is false. */
function renderBrowseDrawer() {
  browseBackdropEl?.remove();
  browseDrawerEl?.remove();
  browseBackdropEl = null;
  browseDrawerEl = null;
  if (!browseOpen) return;

  const backdrop = el("div", { class: "viewer-browse-backdrop" });
  backdrop.onclick = () => {
    browseOpen = false;
    renderBrowseDrawer();
  };

  const closeBtn = el("button", { class: "icon-btn", type: "button", title: "Close" }, ["✕"]);
  closeBtn.onclick = () => {
    browseOpen = false;
    renderBrowseDrawer();
  };

  const treeEl = el("div", { class: "viewer-browse-tree tree-scroll" });
  const roots = childrenOf(vault.items, null).filter(
    (item) => role === "GM" || !isEffectivelyHidden(vault.items, item),
  );
  if (roots.length === 0) {
    treeEl.append(el("div", { class: "empty-state" }, [el("p", {}, ["Nothing here yet."])]));
  } else {
    roots.forEach((item) => renderBrowseNode(item, treeEl));
  }

  const drawer = el("div", { class: "viewer-browse-drawer" }, [
    el("div", { class: "viewer-browse-header" }, [el("h2", {}, ["Browse"]), closeBtn]),
    treeEl,
  ]);

  app.append(backdrop, drawer);
  browseBackdropEl = backdrop;
  browseDrawerEl = drawer;
}

// -------------------------------------------------------------- header --

function renderHeader(item: VaultItem | undefined) {
  headerEl.innerHTML = "";

  const browseBtn = el("button", { class: "icon-btn", type: "button", title: "Browse other items" }, ["☰"]);
  browseBtn.onclick = () => {
    browseOpen = !browseOpen;
    if (browseOpen && currentItemId) {
      const current = vault.items.find((i) => i.id === currentItemId);
      if (current) ancestorIds(vault.items, current).forEach((id) => browseExpanded.add(id));
    }
    renderBrowseDrawer();
  };
  headerEl.append(browseBtn);

  if (item?.type === "pdf" && item.driveFileId && vault.config.driveApiKey) {
    const thumbImg = el("img", { class: "viewer-header-thumb", alt: "" }) as HTMLImageElement;
    thumbImg.hidden = true;
    headerEl.append(thumbImg);
    const forItemId = item.id;
    fetchDriveThumbnail(item.driveFileId, vault.config.driveApiKey).then((link) => {
      // Discard a slow thumbnail fetch if the user has since switched away.
      if (link && currentItemId === forItemId) {
        thumbImg.src = link;
        thumbImg.hidden = false;
      }
    });
  }

  headerEl.append(el("h1", {}, [item ? item.name : "Not found"]));

  if (item && role === "GM") {
    const presentBtn = el(
      "button",
      { class: "icon-btn", type: "button", title: "Present to players — force this open on every screen" },
      ["\u{1F4E3}"], // 📣
    );
    presentBtn.onclick = () => {
      void OBR.broadcast.sendMessage(
        PRESENT_CHANNEL,
        { itemId: item.id } satisfies PresentMessage,
        { destination: "ALL" },
      );
    };
    headerEl.append(presentBtn);
  }

  const externalUrl = item ? externalUrlFor(item) : null;
  if (externalUrl) {
    const openBtn = el(
      "a",
      { class: "icon-btn", href: externalUrl, target: "_blank", rel: "noopener noreferrer", title: "Open in a new browser tab" },
      ["↗"],
    );
    headerEl.append(openBtn);
  }

  const closeBtn = el("button", { class: "icon-btn", type: "button", title: "Close" }, ["✕"]);
  closeBtn.onclick = () => OBR.popover.close(VIEWER_POPOVER_ID);
  headerEl.append(closeBtn);
}

// --------------------------------------------------------------- body --

async function renderBody(item: VaultItem | undefined) {
  contentEl.innerHTML = "";

  if (!item) {
    contentEl.append(
      el("div", { class: "center-message" }, [
        el("p", {}, ["This item couldn't be found — it may have been deleted or moved."]),
      ]),
    );
    return;
  }

  const loadingEl = el("div", { class: "loading" }, ["Loading…"]);
  contentEl.append(loadingEl);

  const forItemId = item.id;
  // Only the PDF path actually reports progress (a Drive fetch of a large
  // file is the one part of this that can take a while); every other
  // branch resolves fast enough that the plain "Loading…" never lingers.
  const rendered = await renderContent(item, vault.config.driveApiKey, (percent) => {
    if (currentItemId !== forItemId) return; // switched away mid-load
    loadingEl.textContent = percent != null ? `Loading… ${percent}%` : "Loading…";
  });
  if (currentItemId !== forItemId) return; // switched away while awaiting; discard

  contentEl.innerHTML = "";
  contentEl.append(rendered);
}

// ---------------------------------------------------------- switching --

/** Switches the popover to show a different item in place — no OBR.popover
 *  re-open, no iframe reload — so the GM/player can jump between handouts
 *  without ever closing the viewer. */
async function showItem(itemId: string | null) {
  currentItemId = itemId;
  browseOpen = false;
  if (itemId) {
    try {
      history.replaceState(null, "", `viewer.html?id=${encodeURIComponent(itemId)}`);
    } catch {
      // Cosmetic only (keeps the URL in sync so a reload lands on the same
      // item) — ignore if the embedding context disallows history writes.
    }
  }
  renderBrowseDrawer();
  const item = itemId ? vault.items.find((i) => i.id === itemId) : undefined;
  renderHeader(item);
  await renderBody(item);
}

// ----------------------------------------------------------------- boot --

async function boot() {
  initTheme();
  app = document.getElementById("app")!;
  app.innerHTML = "";

  headerEl = el("div", { class: "viewer-header" });
  contentEl = el("div", { class: "viewer-content" });
  app.append(headerEl, contentEl);

  role = await OBR.player.getRole();
  vault = await loadVault();

  await showItem(getItemId());

  OBR.player.onChange((player) => {
    if (player.role !== role) {
      role = player.role;
      renderHeader(vault.items.find((i) => i.id === currentItemId));
      renderBrowseDrawer();
    }
  });

  onVaultChange((next) => {
    vault = next;
    // Refresh the header (name/thumbnail may have changed) and the browse
    // drawer's list, but deliberately don't re-run renderBody here — that
    // would re-fetch and re-render the PDF/Markdown (slow, and disruptive
    // mid-read) just because something unrelated changed. The displayed
    // content only refreshes when the user actually switches items.
    renderHeader(vault.items.find((i) => i.id === currentItemId));
    renderBrowseDrawer();
  });
}

OBR.onReady(() => {
  boot().catch((err) => {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const appEl = document.getElementById("app")!;
    appEl.innerHTML = "";
    appEl.append(
      el("div", { class: "center-message" }, [
        el("p", {}, ["Grimoire's viewer failed to start."]),
        el("p", { style: "font-family: monospace; font-size: 11px; opacity: 0.8;" } as any, [message]),
      ]),
    );
    console.error("Grimoire viewer failed to start:", err);
  });
});
