// The full-screen OBR.modal content that actually displays a handout:
// a Drive PDF preview iframe, rendered Markdown, or a plain external link.
import OBR from "@owlbear-rodeo/sdk";
import { initTheme } from "./theme";
import { loadVault } from "./store";
import { driveFilePreviewUrl, driveFileViewUrl, fetchDriveThumbnail } from "./drive";
import { fetchRenderedMarkdown, MarkdownFetchError } from "./markdown";
import { renderPdfReader } from "./pdfReader";
import { VaultItem } from "./types";

const MODAL_ID = "dev.fede.grimoire/viewer";

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

async function boot() {
  initTheme();
  const app = document.getElementById("app")!;
  const itemId = getItemId();

  const vault = await loadVault();
  const item = vault.items.find((i) => i.id === itemId);

  app.innerHTML = "";

  const closeBtn = el("button", { class: "icon-btn", type: "button", title: "Close" }, ["✕"]);
  closeBtn.onclick = () => OBR.modal.close(MODAL_ID);

  const headerChildren: (Node | string)[] = [];

  if (item?.type === "pdf" && item.driveFileId && vault.config.driveApiKey) {
    const thumbImg = el("img", { class: "viewer-header-thumb", alt: "" }) as HTMLImageElement;
    thumbImg.hidden = true;
    headerChildren.push(thumbImg);
    fetchDriveThumbnail(item.driveFileId, vault.config.driveApiKey).then((link) => {
      if (link) {
        thumbImg.src = link;
        thumbImg.hidden = false;
      }
    });
  }

  headerChildren.push(el("h1", {}, [item ? item.name : "Not found"]));

  const externalUrl = item ? externalUrlFor(item) : null;
  if (externalUrl) {
    const openBtn = el(
      "a",
      { class: "icon-btn", href: externalUrl, target: "_blank", rel: "noopener noreferrer", title: "Open in a new browser tab" },
      ["↗"],
    );
    headerChildren.push(openBtn);
  }

  headerChildren.push(closeBtn);

  const header = el("div", { class: "viewer-header" }, headerChildren);
  app.append(header);

  const content = el("div", { class: "viewer-content" });
  app.append(content);

  if (!item) {
    content.append(
      el("div", { class: "center-message" }, [
        el("p", {}, ["This item couldn't be found — it may have been deleted or moved."]),
      ]),
    );
    return;
  }

  const loadingEl = el("div", { class: "loading" }, ["Loading…"]);
  content.append(loadingEl);
  // Only the PDF path actually reports progress (a Drive fetch of a large
  // file is the one part of this that can take a while); every other
  // branch resolves fast enough that the plain "Loading…" never lingers.
  const rendered = await renderContent(item, vault.config.driveApiKey, (percent) => {
    loadingEl.textContent = percent != null ? `Loading… ${percent}%` : "Loading…";
  });
  content.innerHTML = "";
  content.append(rendered);
}

OBR.onReady(() => {
  boot().catch((err) => {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const app = document.getElementById("app")!;
    app.innerHTML = "";
    app.append(
      el("div", { class: "center-message" }, [
        el("p", {}, ["Grimoire's viewer failed to start."]),
        el("p", { style: "font-family: monospace; font-size: 11px; opacity: 0.8;" } as any, [message]),
      ]),
    );
    console.error("Grimoire viewer failed to start:", err);
  });
});
