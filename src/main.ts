// Popover UI: the folder tree, GM editing controls, and the settings panel.
import OBR from "@owlbear-rodeo/sdk";
import { initTheme } from "./theme";
import { loadVault, onVaultChange, saveVault, VaultSizeError } from "./store";
import { childrenOf, isEffectivelyHidden, nextOrder, wouldCreateCycle, descendantIds } from "./tree";
import { extractDriveFileId, fetchDriveThumbnail, checkDriveApiKey } from "./drive";
import { newId, VaultData, VaultItem, VaultItemType, EMPTY_VAULT } from "./types";

const TYPE_META: Record<VaultItemType, { icon: string; label: string }> = {
  folder: { icon: "📁", label: "Folder" }, // 📁
  pdf: { icon: "📄", label: "PDF" }, // 📄
  markdown: { icon: "📝", label: "Markdown" }, // 📝
  link: { icon: "🔗", label: "Link" }, // 🔗
};

function resolveUrl(path: string): string {
  return new URL(path, window.location.href).toString();
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

// -------------------------------------------------------------- viewing --

// Sized to show a whole portrait PDF page (US Letter/A4-ish ratio) at a
// readable scale once the reader's thumbnail rail and toolbar are accounted
// for, while still leaving the scene visible around it rather than going
// full-screen. Owlbear's modal has no explicit centering option — per its
// SDK types there's nothing to set beyond width/height/fullScreen — but its
// dialogs center by default, same as other extensions that just pass a
// fixed size.
const VIEWER_WIDTH = 880;
const VIEWER_HEIGHT = 1040;

function openViewer(item: VaultItem) {
  OBR.modal.open({
    id: "dev.fede.grimoire/viewer",
    url: resolveUrl(`viewer.html?id=${encodeURIComponent(item.id)}`),
    width: VIEWER_WIDTH,
    height: VIEWER_HEIGHT,
  });
}

// --------------------------------------------------------------- render --

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

  if (isFolder) {
    const toggle = el("button", { class: "node-toggle", type: "button" }, [
      expanded.has(item.id) ? "▾" : "▸",
    ]);
    toggle.onclick = () => {
      if (expanded.has(item.id)) expanded.delete(item.id);
      else expanded.add(item.id);
      render();
    };
    row.append(toggle);
  } else {
    row.append(el("span", { class: "node-toggle" }, [""]));
  }

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
    btn.onclick = () => openViewer(item);
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

function render() {
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

  if (toast) {
    app.append(el("div", { class: "toast" }, [toast]));
  }
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
    render();

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
  } catch (err) {
    renderFatalError(err);
  }
});
