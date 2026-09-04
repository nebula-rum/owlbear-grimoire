// The extension's single action popover: the folder tree, GM editing
// controls, and the settings panel (the "tree screen"), plus — in place,
// same popover — the item viewer (the "viewer screen": PDF reader / rendered
// Markdown / external link, with its own "Browse" drawer and Present
// button). Switching screens resizes the popover itself via
// OBR.action.setWidth/setHeight rather than opening a second modal/popover,
// because OBR.action is the one thing Owlbear genuinely keeps docked to the
// toolbar — a second popover positioned via anchorPosition/anchorReference
// didn't actually stay docked in the real Owlbear client, despite matching
// the SDK's own types/docs exactly.
import OBR from "@owlbear-rodeo/sdk";
import { initTheme } from "./theme";
import { loadVault, onVaultChange, saveVault, VaultSizeError } from "./store";
import { childrenOf, isEffectivelyHidden, nextOrder, wouldCreateCycle, descendantIds } from "./tree";
import {
  extractDriveFileId,
  fetchDriveThumbnail,
  checkDriveApiKey,
  driveFilePreviewUrl,
  driveFileViewUrl,
} from "./drive";
import { fetchRenderedMarkdown, MarkdownFetchError, MarkdownHeading } from "./markdown";
import { renderPdfReader } from "./pdfReader";
import { newId, VaultData, VaultItem, VaultItemType, EMPTY_VAULT } from "./types";
import { PRESENT_CHANNEL, PresentMessage, broadcastPresent, consumePendingPresentedItem, clearPendingPresentedItem } from "./present";
import { TYPE_META } from "./itemMeta";

// Sizes for the two screens the popover can be in. TREE_* mirrors
// manifest.json's action.width/height (that manifest value is only the
// *initial* size Owlbear opens the popover at — it's undocumented whether a
// resized popover resets on next open, so boot() below always explicitly
// sets one of these two rather than assuming the manifest default still
// holds).
const TREE_WIDTH = 420;
const TREE_HEIGHT = 640;

// The viewer is sized to almost fill the screen's height and match an A4
// portrait page's proportions (210:297mm) in width — plus a fixed allowance
// for the PDF reader's thumbnail rail (`.rail-column`'s 128px in
// style.css), so the *page itself* renders at roughly true A4 shape instead
// of being squeezed narrower by that sidebar. Computed from window.screen
// (available regardless of this being an embedded iframe — it reflects the
// physical display, not the parent document) rather than hardcoded, so it
// scales across monitors instead of assuming ~1080p. Recomputed on every
// call rather than cached, so it stays right if the window moves to a
// different monitor mid-session.
const A4_PORTRAIT_RATIO = 210 / 297;
const PDF_RAIL_ALLOWANCE = 128;

function computeViewerSize(): { width: number; height: number } {
  const availHeight = window.screen.availHeight || window.screen.height || 900;
  const availWidth = window.screen.availWidth || window.screen.width || 1200;
  const height = Math.round(Math.min(Math.max(availHeight * 0.92, 700), 1700));
  const width = Math.round(Math.min(height * A4_PORTRAIT_RATIO + PDF_RAIL_ALLOWANCE, availWidth * 0.6));
  return { width, height };
}

// ---------------------------------------------------------------- state --

let vault: VaultData = structuredClone(EMPTY_VAULT);
let role: "GM" | "PLAYER" = "PLAYER";

let expanded = new Set<string>();
let renamingId: string | null = null;
let addFormParent: string | null | "none" = "none"; // "none" = closed
let addFormType: VaultItemType = "folder";
let movePickerId: string | null = null;
let deleteArmedId: string | null = null;
let deleteArmTimer: ReturnType<typeof setTimeout> | undefined;
let settingsOpen = false;
let toast: string | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

// Drive's per-file cover thumbnail (usually a render of page 1), keyed by
// file id. "loading" while the fetch is in flight, null once we've tried
// and there wasn't one (or it failed) — either way we stop asking again.
const thumbnailCache = new Map<string, string | null | "loading">();

/** Kicks off a thumbnail fetch the first time a pdf item is rendered, then
 *  re-renders once it resolves. Returns the cached image URL immediately if
 *  we already have one, otherwise null (fall back to the plain icon). */
function getOrFetchThumbnail(fileId: string, apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  const cached = thumbnailCache.get(fileId);
  if (cached === "loading") return null;
  if (cached !== undefined) return cached;

  thumbnailCache.set(fileId, "loading");
  fetchDriveThumbnail(fileId, apiKey).then((link) => {
    thumbnailCache.set(fileId, link);
    if (link) render();
  });
  return null;
}

function showToast(message: string) {
  toast = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast = null;
    render();
  }, 5000);
  render();
}

// --------------------------------------------------------------- saving --

async function persist(next: VaultData) {
  const previous = vault;
  vault = next;
  render();
  try {
    await saveVault(next);
  } catch (err) {
    if (err instanceof VaultSizeError) {
      showToast(err.message);
    } else {
      showToast("Couldn't save to the room. Reloading the latest saved vault.");
    }
    // Resync with the server so we don't drift from what's actually saved.
    vault = await loadVault().catch(() => previous);
    render();
  }
}

function mutate(fn: (draft: VaultData) => void) {
  const draft = structuredClone(vault);
  fn(draft);
  void persist(draft);
}

// -------------------------------------------------------------- actions --

function addItem(parentId: string | null, type: VaultItemType, name: string, link: string) {
  const item: VaultItem = {
    id: newId(),
    name,
    type,
    parentId,
    hidden: true, // safe default: new content is invisible to players until revealed
    order: nextOrder(vault.items, parentId),
  };
  if (type === "pdf" || type === "markdown") {
    const fileId = extractDriveFileId(link);
    if (!fileId) return "Couldn't find a Google Drive file id in that link.";
    item.url = link;
    item.driveFileId = fileId;
  } else if (type === "link") {
    if (!/^https?:\/\//i.test(link.trim())) return "Enter a full URL starting with http:// or https://";
    item.linkUrl = link.trim();
  }
  mutate((d) => d.items.push(item));
  if (parentId) expanded.add(parentId);
  addFormParent = "none";
  return null;
}

function renameItem(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  mutate((d) => {
    const item = d.items.find((i) => i.id === id);
    if (item) item.name = trimmed;
  });
}

function toggleHidden(id: string) {
  mutate((d) => {
    const item = d.items.find((i) => i.id === id);
    if (item) item.hidden = !item.hidden;
  });
}

function deleteItem(id: string) {
  mutate((d) => {
    const toRemove = new Set([id, ...descendantIds(d.items, id)]);
    d.items = d.items.filter((i) => !toRemove.has(i.id));
  });
}

function moveItem(id: string, newParentId: string | null) {
  if (wouldCreateCycle(vault.items, id, newParentId)) return;
  mutate((d) => {
    const item = d.items.find((i) => i.id === id);
    if (item) {
      item.parentId = newParentId;
      item.order = nextOrder(d.items, newParentId);
    }
  });
  movePickerId = null;
}

function reorder(id: string, direction: -1 | 1) {
  mutate((d) => {
    const item = d.items.find((i) => i.id === id);
    if (!item) return;
    const siblings = childrenOf(d.items, item.parentId);
    const idx = siblings.findIndex((i) => i.id === id);
    const swapWith = siblings[idx + direction];
    if (!swapWith) return;
    const tmp = item.order;
    item.order = swapWith.order;
    swapWith.order = tmp;
  });
}

function armDelete(id: string) {
  deleteArmedId = id;
  if (deleteArmTimer) clearTimeout(deleteArmTimer);
  deleteArmTimer = setTimeout(() => {
    deleteArmedId = null;
    render();
  }, 3000);
  render();
}

function saveApiKey(key: string) {
  mutate((d) => {
    d.config.driveApiKey = key.trim() || undefined;
  });
  // Deliberately left open (unlike most edits here) so the GM can hit "Test
  // key" right after saving without having to reopen Settings — that
  // extra reopen step is exactly what made a bad key hard to notice before.
  showToast("API key saved.");
}

/** GM-only "push to table": force this item open in every connected
 *  client's popover right now, regardless of its hidden flag or whether
 *  anyone has the popover open. Doesn't change the item's persistent
 *  visibility — it's a live spotlight, not the same as revealing it (use
 *  the 👁 toggle for that). Shared by both screens' Present buttons. */
function presentItem(item: VaultItem) {
  void broadcastPresent(item.id);
  showToast(`Presented "${item.name}" to the table.`);
}

// --------------------------------------------------------------- shared --

const app = document.getElementById("app")!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
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

function renderToast() {
  if (toast) {
    app.append(el("div", { class: "toast" }, [toast]));
  }
}

// ----------------------------------------------------------- tree screen --

function renderAddForm(parentId: string | null): HTMLElement {
  const form = el("div", { class: "add-form" });
  const typeSelect = el("select", {}) as HTMLSelectElement;
  (Object.keys(TYPE_META) as VaultItemType[]).forEach((t) => {
    const opt = el("option", { value: t }, [`${TYPE_META[t].icon} ${TYPE_META[t].label}`]);
    if (t === addFormType) opt.selected = true;
    typeSelect.append(opt);
  });
  typeSelect.onchange = () => {
    addFormType = typeSelect.value as VaultItemType;
    render();
  };

  const nameInput = el("input", { placeholder: "Name" }) as HTMLInputElement;
  const linkInput = el("input", {
    placeholder:
      addFormType === "link"
        ? "https://..."
        : "Google Drive share link (Anyone with the link)",
  }) as HTMLInputElement;
  linkInput.style.display = addFormType === "folder" ? "none" : "block";
  typeSelect.addEventListener("change", () => {
    linkInput.style.display = addFormType === "folder" ? "none" : "block";
    linkInput.placeholder =
      addFormType === "link"
        ? "https://..."
        : "Google Drive share link (Anyone with the link)";
  });

  const error = el("div", { class: "field-error" });
  error.style.display = "none";

  const cancel = el("button", { class: "btn secondary", type: "button" }, ["Cancel"]);
  cancel.onclick = () => {
    addFormParent = "none";
    render();
  };
  const submit = el("button", { class: "btn", type: "button" }, ["Add"]);
  submit.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = "Name is required.";
      error.style.display = "block";
      return;
    }
    const err = addItem(parentId, addFormType, name, linkInput.value);
    if (err) {
      error.textContent = err;
      error.style.display = "block";
      return;
    }
    render();
  };

  form.append(typeSelect, nameInput, linkInput, error, el("div", { class: "row" }, [cancel, submit]));
  return form;
}

function renderMovePicker(item: VaultItem): HTMLElement {
  const select = el("select", {}) as HTMLSelectElement;
  select.append(el("option", { value: "" }, ["Move to: Root"]));
  const folders = vault.items.filter((i) => i.type === "folder" && i.id !== item.id);
  const blocked = new Set(descendantIds(vault.items, item.id));
  for (const f of folders) {
    if (blocked.has(f.id)) continue;
    const opt = el("option", { value: f.id }, [f.name]);
    if (f.id === item.parentId) opt.selected = true;
    select.append(opt);
  }
  if (item.parentId === null) (select.querySelector('option[value=""]') as HTMLOptionElement).selected = true;
  select.onchange = () => moveItem(item.id, select.value || null);
  select.onclick = (e) => e.stopPropagation();
  const wrap = el("div", { class: "add-form" }, [select]);
  return wrap;
}

function renderNode(item: VaultItem, depth: number): HTMLElement {
  const wrapper = el("div", { class: "node" });
  const isFolder = item.type === "folder";
  const hiddenHere = item.hidden;
  const row = el("div", { class: `node-row${role === "GM" && hiddenHere ? " hidden-item" : ""}` });

  const thumbnail =
    item.type === "pdf" && item.driveFileId
      ? getOrFetchThumbnail(item.driveFileId, vault.config.driveApiKey)
      : null;
  if (thumbnail) {
    row.append(el("img", { class: "node-thumb", src: thumbnail, alt: "" }));
  } else {
    row.append(el("span", { class: "node-icon" }, [TYPE_META[item.type].icon]));
  }

  if (renamingId === item.id) {
    const input = el("input", { class: "node-name-input", value: item.name }) as HTMLInputElement;
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        renameItem(item.id, input.value);
        renamingId = null;
        render();
      } else if (e.key === "Escape") {
        renamingId = null;
        render();
      }
    };
    input.onblur = () => {
      renameItem(item.id, input.value);
      renamingId = null;
      render();
    };
    row.append(input);
    setTimeout(() => input.focus(), 0);
  } else if (isFolder) {
    const btn = el("button", { class: "node-name", type: "button" }, [item.name]);
    btn.onclick = () => {
      if (expanded.has(item.id)) expanded.delete(item.id);
      else expanded.add(item.id);
      render();
    };
    row.append(btn);
  } else {
    const btn = el("button", { class: "node-name", type: "button" }, [item.name]);
    btn.onclick = () => openViewerScreen(item.id);
    row.append(btn);
  }

  if (role === "GM") {
    const actions = el("div", { class: "node-actions" });

    if (isFolder) {
      const addBtn = el("button", { type: "button", title: "Add inside" }, ["+"]);
      addBtn.onclick = () => {
        addFormParent = item.id;
        expanded.add(item.id);
        render();
      };
      actions.append(addBtn);
    }

    const upBtn = el("button", { type: "button", title: "Move up" }, ["↑"]);
    upBtn.onclick = () => reorder(item.id, -1);
    const downBtn = el("button", { type: "button", title: "Move down" }, ["↓"]);
    downBtn.onclick = () => reorder(item.id, 1);
    actions.append(upBtn, downBtn);

    const moveBtn = el("button", { type: "button", title: "Move to folder" }, ["⤤"]);
    moveBtn.onclick = () => {
      movePickerId = movePickerId === item.id ? null : item.id;
      render();
    };
    actions.append(moveBtn);

    const renameBtn = el("button", { type: "button", title: "Rename" }, ["✎"]);
    renameBtn.onclick = () => {
      renamingId = item.id;
      render();
    };
    actions.append(renameBtn);

    const visBtn = el(
      "button",
      { type: "button", title: hiddenHere ? "Reveal to players" : "Hide from players" },
      [hiddenHere ? "\u{1F648}" : "\u{1F441}️"], // 🙈 hidden, 👁️ visible
    );
    visBtn.onclick = () => toggleHidden(item.id);
    actions.append(visBtn);

    if (!isFolder) {
      const presentBtn = el(
        "button",
        { type: "button", title: "Present to players — force this open on every screen" },
        ["\u{1F4E3}"], // 📣
      );
      presentBtn.onclick = () => presentItem(item);
      actions.append(presentBtn);
    }

    const delBtn = el(
      "button",
      { type: "button", class: deleteArmedId === item.id ? "danger" : "", title: "Delete" },
      [deleteArmedId === item.id ? "Confirm?" : "\u{1F5D1}"],
    );
    delBtn.onclick = () => {
      if (deleteArmedId === item.id) {
        deleteItem(item.id);
        deleteArmedId = null;
      } else {
        armDelete(item.id);
      }
    };
    actions.append(delBtn);

    row.append(actions);
  }

  wrapper.append(row);

  if (movePickerId === item.id) {
    wrapper.append(renderMovePicker(item));
  }

  if (isFolder && addFormParent === item.id) {
    wrapper.append(renderAddForm(item.id));
  }

  if (isFolder && expanded.has(item.id)) {
    const kids = childrenOf(vault.items, item.id).filter(
      (child) => role === "GM" || !isEffectivelyHidden(vault.items, child),
    );
    const childWrap = el("div", { class: "node-children" });
    kids.forEach((child) => childWrap.append(renderNode(child, depth + 1)));
    wrapper.append(childWrap);
  }

  return wrapper;
}

function renderTreeScreen() {
  app.innerHTML = "";

  const header = el("header", { class: "header" }, [
    el("h1", {}, ["Grimoire"]),
    el("span", { class: "role-badge" }, [role]),
  ]);
  if (role === "GM") {
    const addRootBtn = el("button", { class: "icon-btn", type: "button", title: "Add to root" }, ["+"]);
    addRootBtn.onclick = () => {
      addFormParent = addFormParent === null ? "none" : null;
      render();
    };
    const settingsBtn = el("button", { class: "icon-btn", type: "button", title: "Settings" }, ["⚙"]);
    settingsBtn.onclick = () => {
      settingsOpen = !settingsOpen;
      render();
    };
    header.append(addRootBtn, settingsBtn);
  }
  app.append(header);

  if (settingsOpen && role === "GM") {
    const panel = el("div", { class: "panel" }, [
      el("h2", {}, ["Google Drive API key"]),
      el("p", {}, [
        "Only needed to fully render Markdown files (PDFs work without it). Get a free key from the ",
        el("a", { href: "https://console.cloud.google.com/apis/credentials", target: "_blank", rel: "noopener noreferrer" }, [
          "Google Cloud Console",
        ]),
        " after enabling the Drive API — see the README for the exact steps. This key is shared with your players' clients (same as everything else here) so it should be restricted to your extension's URL.",
      ]),
    ]);
    const input = el("input", { type: "text", value: vault.config.driveApiKey ?? "" }) as HTMLInputElement;
    const saveBtn = el("button", { class: "btn", type: "button" }, ["Save"]);
    saveBtn.onclick = () => saveApiKey(input.value);

    const testBtn = el("button", { class: "btn secondary", type: "button" }, ["Test key"]);
    const testStatus = el("div", { class: "field-status" });
    testStatus.style.display = "none";
    // Tests whatever's currently typed in, not just the saved value — so you
    // can check a key before committing to it, or right after Save without
    // needing to reopen this panel.
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = "Testing…";
      testStatus.className = "field-status";
      testStatus.style.display = "block";
      testStatus.textContent = "Checking…";
      const result = await checkDriveApiKey(input.value);
      testBtn.disabled = false;
      testBtn.textContent = "Test key";
      testStatus.className = result.ok ? "field-status field-success" : "field-status field-error";
      testStatus.textContent = (result.ok ? "✓ " : "✗ ") + result.message;
    };

    panel.append(el("div", { class: "panel-row" }, [input, saveBtn, testBtn]), testStatus);
    app.append(panel);
  }

  if (addFormParent === null && role === "GM") {
    const wrap = el("div", { style: "padding: 6px" } as any, [renderAddForm(null)]);
    app.append(wrap);
  }

  const scroll = el("div", { class: "tree-scroll" });
  const roots = childrenOf(vault.items, null).filter(
    (item) => role === "GM" || !isEffectivelyHidden(vault.items, item),
  );

  if (roots.length === 0) {
    scroll.append(
      el("div", { class: "empty-state" }, [
        el("p", {}, [role === "GM" ? "Your vault is empty." : "Nothing has been shared yet."]),
        role === "GM"
          ? el("p", {}, ["Use the + button above to add a folder, PDF, Markdown file, or link."])
          : el("p", {}, ["Check back once your GM reveals a handout."]),
      ]),
    );
  } else {
    roots.forEach((item) => scroll.append(renderNode(item, 0)));
  }
  app.append(scroll);

  renderToast();
}

// ---------------------------------------------------------- viewer screen --
// Ported from the extension's old separate viewer.html/viewer.ts (which
// opened as its own OBR.modal, then OBR.popover) — now rendered in place in
// the same popover as the tree, so it inherits the action popover's genuine
// toolbar-docked position instead of relying on a positioning hint Owlbear's
// real client doesn't actually honor.

let viewerItemId: string | null = null;
let viewerHeaderEl: HTMLElement | null = null;
let viewerContentEl: HTMLElement | null = null;

/** The URL to send someone to if they want this open as a real browser tab
 *  instead of embedded here — only for a plain "link" item, where the
 *  header's "↗" button is the *only* way to actually reach it (there's
 *  nothing embedded to show for that type). Deliberately omitted for
 *  pdf/markdown: those already render inline, and the header button was
 *  otherwise just a one-click shortcut to Drive's own view (with its own
 *  prominent Download button) — not something to offer up for free. */
function externalUrlFor(item: VaultItem): string | null {
  if (item.type === "link" && item.linkUrl) {
    return item.linkUrl;
  }
  return null;
}

/** A collapsible chapter/subchapter sidebar for a rendered Markdown
 *  document's headings — same fold-per-level UX as the PDF reader's chapter
 *  panel (see pdfReader.ts's renderOutlinePanel, which this mirrors:
 *  headings is a flat, depth-tagged, source-order list, so a heading's
 *  "children" are exactly the contiguous run of following entries with
 *  greater depth). Clicking one scrolls that heading into view inside
 *  `scrollContainer` instead of navigating to a page. */
function buildHeadingsRail(headings: MarkdownHeading[], scrollContainer: HTMLElement): HTMLElement {
  const railScroll = el("div", { class: "rail-scroll" });
  const hasChildren = headings.map((h, i) => (headings[i + 1]?.depth ?? 0) > h.depth);
  const collapsed = new Set<number>();

  function renderRail() {
    railScroll.innerHTML = "";
    let hideBelowDepth: number | null = null;

    headings.forEach((heading, i) => {
      if (hideBelowDepth != null) {
        if (heading.depth > hideBelowDepth) return; // still inside the collapsed subtree
        hideBelowDepth = null; // back out of it
      }

      const isCollapsed = collapsed.has(i);
      if (hasChildren[i] && isCollapsed) hideBelowDepth = heading.depth;

      const row = el("div", { class: "outline-row" });
      // depth is 1-based (h1 = 1); top-level headings start unindented.
      row.style.paddingLeft = `${(heading.depth - 1) * 14}px`;

      if (hasChildren[i]) {
        const toggle = el(
          "button",
          { class: "outline-toggle", type: "button", title: isCollapsed ? "Expand" : "Collapse" },
          [isCollapsed ? "▸" : "▾"],
        ) as HTMLButtonElement;
        toggle.onclick = () => {
          if (isCollapsed) collapsed.delete(i);
          else collapsed.add(i);
          renderRail();
        };
        row.append(toggle);
      } else {
        row.append(el("span", { class: "outline-toggle" }, [""]));
      }

      const btn = el("button", { class: "outline-item", type: "button" }, [heading.title]) as HTMLButtonElement;
      btn.onclick = () => {
        scrollContainer.querySelector(`#${CSS.escape(heading.id)}`)?.scrollIntoView({ block: "start" });
      };
      row.append(btn);

      railScroll.append(row);
    });
  }
  renderRail();

  return el("div", { class: "rail-column" }, [railScroll]);
}

async function buildViewerNode(
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
          "Open ⚙ Settings and add a free API key (see the README's Markdown setup section).",
        ]),
        el(
          "a",
          { href: driveFileViewUrl(item.driveFileId), target: "_blank", rel: "noopener noreferrer", class: "btn" },
          ["Open the raw file in Google Drive instead"],
        ),
      ]);
    }
    try {
      const { html, headings } = await fetchRenderedMarkdown(item.driveFileId, apiKey);
      const pane = el("div", { class: "markdown-pane" });
      pane.innerHTML = html;
      if (headings.length === 0) return pane;

      const mdMain = el("div", { class: "md-main" }, [pane]);
      const rail = buildHeadingsRail(headings, mdMain);
      return el("div", { class: "md-reader" }, [rail, mdMain]);
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

function renderViewerHeader(item: VaultItem | undefined) {
  const headerEl = viewerHeaderEl!;
  headerEl.innerHTML = "";

  const backBtn = el("button", { class: "icon-btn", type: "button", title: "Back to the folder tree" }, ["←"]);
  backBtn.onclick = () => closeViewerScreen();
  headerEl.append(backBtn);

  if (item?.type === "pdf" && item.driveFileId && vault.config.driveApiKey) {
    const thumbImg = el("img", { class: "viewer-header-thumb", alt: "" }) as HTMLImageElement;
    thumbImg.hidden = true;
    headerEl.append(thumbImg);
    const forItemId = item.id;
    fetchDriveThumbnail(item.driveFileId, vault.config.driveApiKey).then((link) => {
      // Discard a slow thumbnail fetch if the user has since switched away.
      if (link && viewerItemId === forItemId) {
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
    presentBtn.onclick = () => presentItem(item);
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

  const closeBtn = el("button", { class: "icon-btn", type: "button", title: "Close Grimoire" }, ["✕"]);
  closeBtn.onclick = () => void OBR.action.close();
  headerEl.append(closeBtn);
}

async function renderViewerContent(item: VaultItem | undefined) {
  const contentEl = viewerContentEl!;
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
  const rendered = await buildViewerNode(item, vault.config.driveApiKey, (percent) => {
    if (viewerItemId !== forItemId) return; // switched away mid-load
    loadingEl.textContent = percent != null ? `Loading… ${percent}%` : "Loading…";
  });
  if (viewerItemId !== forItemId) return; // switched away while awaiting; discard

  contentEl.innerHTML = "";
  contentEl.append(rendered);
}

/** Switches the viewer to show a different item in place — no popover
 *  re-open, no iframe reload — so the GM/player can jump between handouts
 *  without ever leaving the viewer screen. Assumes the viewer screen is
 *  already mounted (viewerHeaderEl/viewerContentEl exist) — call
 *  openViewerScreen() first if it might not be. */
async function showViewerItem(itemId: string | null) {
  viewerItemId = itemId;
  if (itemId) {
    try {
      history.replaceState(null, "", `${window.location.pathname}?item=${encodeURIComponent(itemId)}`);
    } catch {
      // Cosmetic only (keeps the URL in sync so a reload lands on the same
      // item) — ignore if the embedding context disallows history writes.
    }
  }
  const item = itemId ? vault.items.find((i) => i.id === itemId) : undefined;
  renderViewerHeader(item);
  await renderViewerContent(item);
}

/** Switches the popover into the viewer screen showing the given item,
 *  mounting the viewer's header/content elements and resizing the popover
 *  if it isn't already the active screen. Safe to call repeatedly (e.g. from
 *  a live Present broadcast while already viewing something else) — it just
 *  re-targets in place without tearing anything down. */
function openViewerScreen(itemId: string) {
  if (screen !== "viewer") {
    screen = "viewer";
    app.innerHTML = "";
    viewerHeaderEl = el("div", { class: "viewer-header" });
    viewerContentEl = el("div", { class: "viewer-content" });
    app.append(viewerHeaderEl, viewerContentEl);
    const { width, height } = computeViewerSize();
    void OBR.action.setWidth(width);
    void OBR.action.setHeight(height);
  }
  void showViewerItem(itemId);
}

function closeViewerScreen() {
  screen = "tree";
  viewerItemId = null;
  viewerHeaderEl = null;
  viewerContentEl = null;
  try {
    history.replaceState(null, "", window.location.pathname);
  } catch {
    // Cosmetic only — see showViewerItem.
  }
  void OBR.action.setWidth(TREE_WIDTH);
  void OBR.action.setHeight(TREE_HEIGHT);
  render();
}

// ------------------------------------------------------------- dispatch --

type Screen = "tree" | "viewer";
let screen: Screen = "tree";

/** The single entry point every state-changing action calls. Routes to
 *  whichever screen is currently active; the viewer branch deliberately
 *  only refreshes the header chrome (name/thumbnail may have changed)
 *  rather than re-running showViewerItem — that would re-fetch and
 *  re-render the PDF/Markdown (slow, and disruptive mid-read) just because
 *  something unrelated changed elsewhere in the vault. */
function render() {
  if (screen === "viewer") {
    renderViewerHeader(viewerItemId ? vault.items.find((i) => i.id === viewerItemId) : undefined);
    renderToast();
    return;
  }
  renderTreeScreen();
}

// ----------------------------------------------------------------- boot --

function renderFatalError(err: unknown) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  app.innerHTML = "";
  app.append(
    el("div", { class: "center-message" }, [
      el("p", {}, ["Grimoire failed to start."]),
      el("p", { style: "font-family: monospace; font-size: 11px; opacity: 0.8;" } as any, [message]),
      el("p", {}, ["Check the browser console for more detail, and try a hard refresh."]),
    ]),
  );
  // Also surface it in the console with the full stack, in case the message
  // above is truncated by the popover's small size.
  console.error("Grimoire failed to start:", err);
}

OBR.onReady(async () => {
  try {
    initTheme();
    role = await OBR.player.getRole();
    vault = await loadVault();

    // A pending "present" (set by background.ts right before it forced this
    // popover open) wins over the ?item= URL param, which only exists so a
    // reload while already viewing something lands back on the same item.
    const pendingItemId = consumePendingPresentedItem() ?? new URLSearchParams(window.location.search).get("item");
    if (pendingItemId) {
      openViewerScreen(pendingItemId);
    } else {
      render();
      void OBR.action.setWidth(TREE_WIDTH);
      void OBR.action.setHeight(TREE_HEIGHT);
    }

    OBR.player.onChange((player) => {
      if (player.role !== role) {
        role = player.role;
        render();
      }
    });

    onVaultChange((next) => {
      vault = next;
      render();
    });

    // Only fires while this popover is actually mounted — a player who
    // doesn't have it open relies on background.ts + the pending-item check
    // above instead.
    OBR.broadcast.onMessage(PRESENT_CHANNEL, (event) => {
      const data = event.data as Partial<PresentMessage> | undefined;
      if (data && typeof data.itemId === "string") {
        clearPendingPresentedItem();
        openViewerScreen(data.itemId);
      }
    });
  } catch (err) {
    renderFatalError(err);
  }
});
