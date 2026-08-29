// The full-screen OBR.modal content that actually displays a handout:
// a Drive PDF preview iframe, rendered Markdown, or a plain external link.
import OBR from "@owlbear-rodeo/sdk";
import { initTheme } from "./theme";
import { loadVault } from "./store";
import { driveFilePreviewUrl, driveFileViewUrl } from "./drive";
import { fetchRenderedMarkdown, MarkdownFetchError } from "./markdown";
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

async function renderContent(item: VaultItem, apiKey: string | undefined): Promise<Node> {
  if (item.type === "pdf" && item.driveFileId) {
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

  const header = el("div", { class: "viewer-header" }, [
    el("h1", {}, [item ? item.name : "Not found"]),
    closeBtn,
  ]);
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

  content.append(el("div", { class: "loading" }, ["Loading…"]));
  const rendered = await renderContent(item, vault.config.driveApiKey);
  content.innerHTML = "";
  content.append(rendered);
}

OBR.onReady(() => {
  void boot();
});
