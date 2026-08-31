// A self-contained PDF reader: continuous-scroll page rendering, zoom
// controls, a lazy thumbnail rail, and a chapter/outline panel — built on
// pdf.js loaded from a CDN at runtime rather than as an npm dependency, so
// the project's package.json/lockfile stay untouched. The tradeoff is no
// compile-time types for pdf.js itself; the small slice of its API used
// below is described by the Minimal* interfaces.
//
// Only used when a Drive API key is set (see viewer.ts) — pdf.js needs the
// file's raw bytes, and only the Drive API's alt=media endpoint serves those
// with permissive-enough CORS for a browser fetch; a plain share link
// doesn't. Without a key, or if anything here throws, the caller falls back
// to Drive's own /preview iframe, so PDFs keep working with zero setup.
import { driveApiMediaUrl } from "./drive";

// Pinned to a mature, widely-deployed release rather than "latest" — pdf.js
// 6.x turned out to rely on brand-new JS engine features (a very recent
// Map method) that threw in Playwright's bundled Chromium during testing,
// which means some players' real browsers would hit the same thing. 4.0.269
// has been out long enough to run everywhere Owlbear itself does.
const PDFJS_VERSION = "4.0.269";
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.mjs`;
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.mjs`;

interface MinimalViewport {
  width: number;
  height: number;
}

interface MinimalPage {
  getViewport(params: { scale: number }): MinimalViewport;
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: MinimalViewport }): { promise: Promise<void> };
}

interface MinimalOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: MinimalOutlineNode[];
}

interface MinimalDocument {
  numPages: number;
  getPage(n: number): Promise<MinimalPage>;
  getOutline(): Promise<MinimalOutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

interface PdfProgress {
  loaded: number;
  total: number;
}

interface PdfLoadingTask {
  promise: Promise<MinimalDocument>;
  onProgress?: (progress: PdfProgress) => void;
}

interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(params: { url: string }): PdfLoadingTask;
}

let pdfjsPromise: Promise<PdfJsModule> | null = null;

function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ PDFJS_URL).then((mod: PdfJsModule) => {
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return mod;
    });
  }
  return pdfjsPromise;
}

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

const THUMB_WIDTH = 96;
// How far past the visible edge (in px) a page starts rendering / a
// thumbnail starts loading — big enough that scrolling never outruns it and
// shows a blank canvas, small enough not to render the whole document.
const RENDER_LOOKAHEAD = "1000px 0px";
const PAGE_GAP = 16;

interface OutlineEntry {
  title: string;
  pageNumber: number | null;
  depth: number;
}

/**
 * Flattens pdf.js's (possibly nested) outline tree into a linear list with
 * a depth for indentation, resolving each entry's destination to a 1-based
 * page number along the way. A `dest` can be a named string (needs
 * getDestination to look up) or already the raw array; either way it
 * ultimately points at a page ref that getPageIndex turns into a number.
 * Entries that fail to resolve (e.g. a pure external-URL bookmark) keep
 * pageNumber null and just render disabled rather than breaking the list.
 */
async function flattenOutline(
  doc: MinimalDocument,
  nodes: MinimalOutlineNode[],
  depth: number,
  out: OutlineEntry[],
): Promise<void> {
  for (const node of nodes) {
    let pageNumber: number | null = null;
    try {
      const dest = typeof node.dest === "string" ? await doc.getDestination(node.dest) : node.dest;
      if (Array.isArray(dest) && dest[0] != null) {
        pageNumber = (await doc.getPageIndex(dest[0])) + 1;
      }
    } catch {
      pageNumber = null;
    }
    out.push({ title: node.title || "(untitled)", pageNumber, depth });
    if (node.items && node.items.length) {
      await flattenOutline(doc, node.items, depth + 1, out);
    }
  }
}

/**
 * Build a full PDF reader UI — a continuous-scroll page column, a lazy
 * thumbnail rail (with a chapters tab when the PDF has an outline), and a
 * toolbar with prev/next, a page number field, and zoom — for the given
 * Drive file. Throws if pdf.js fails to load or the file fails to parse;
 * the caller is expected to fall back to the plain iframe preview then.
 * `onProgress` (0-100, or null once we can't tell) is reported while the
 * file downloads — Drive can take a while to serve larger PDFs, and a live
 * percentage beats a frozen "Loading…" with no sense of whether it's stuck.
 */
export async function renderPdfReader(
  fileId: string,
  apiKey: string,
  onProgress?: (percent: number | null) => void,
): Promise<HTMLElement> {
  const pdfjsLib = await loadPdfJs();
  const loadingTask = pdfjsLib.getDocument({ url: driveApiMediaUrl(fileId, apiKey) });
  if (onProgress) {
    loadingTask.onProgress = (p) => onProgress(p.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : null);
  }
  const doc = await loadingTask.promise;
  onProgress?.(100);
  const pageCount = doc.numPages;
  const firstPage = await doc.getPage(1);
  const baseViewport = firstPage.getViewport({ scale: 1 }); // assumed page size for layout before each page is individually measured

  let currentPage = 1;
  let scale = 1;
  let usingManualScale = false;

  // ---- toolbar ----
  const prevBtn = el("button", { class: "icon-btn", type: "button", title: "Previous page (←)" }, ["‹"]);
  const nextBtn = el("button", { class: "icon-btn", type: "button", title: "Next page (→)" }, ["›"]);
  const pageInput = el("input", {
    class: "pdf-page-input",
    type: "text",
    inputMode: "numeric",
    value: "1",
  }) as HTMLInputElement;
  const pageCountLabel = el("span", { class: "pdf-page-count" }, [`/ ${pageCount}`]);
  const zoomOutBtn = el("button", { class: "icon-btn", type: "button", title: "Zoom out" }, ["−"]);
  const zoomInBtn = el("button", { class: "icon-btn", type: "button", title: "Zoom in" }, ["+"]);
  const fitBtn = el(
    "button",
    { class: "btn secondary pdf-fit-btn", type: "button", title: "Fit page width" },
    ["Fit width"],
  );

  const toolbar = el("div", { class: "pdf-toolbar" }, [
    el("div", { class: "pdf-toolbar-group" }, [prevBtn, pageInput, pageCountLabel, nextBtn]),
    el("div", { class: "pdf-toolbar-group" }, [zoomOutBtn, fitBtn, zoomInBtn]),
  ]);

  // ---- continuous-scroll page column ----
  const pageWrappers: HTMLDivElement[] = [];
  const pageCanvases: HTMLCanvasElement[] = [];
  const pageArea = el("div", { class: "pdf-page-area" }) as HTMLDivElement;

  for (let n = 1; n <= pageCount; n++) {
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page-canvas";
    const wrapper = el("div", { class: "pdf-page-wrapper" }, [canvas]) as HTMLDivElement;
    wrapper.dataset.page = String(n);
    pageCanvases.push(canvas);
    pageWrappers.push(wrapper);
    pageArea.append(wrapper);
  }

  function estimateWrapperSize(n: number, targetScale: number) {
    // Placeholder box sized from page 1's aspect ratio so the column's
    // total scroll height (and thus the scrollbar / thumbnail sync) is
    // roughly right immediately, before this specific page has actually
    // been measured. renderPage corrects it once the real page loads —
    // only visibly different for PDFs that mix page sizes, which is rare.
    pageWrappers[n - 1].style.width = `${Math.ceil(baseViewport.width * targetScale)}px`;
    pageWrappers[n - 1].style.height = `${Math.ceil(baseViewport.height * targetScale)}px`;
  }

  const renderedAtScale = new Map<number, number>();
  const renderTokens: number[] = new Array(pageCount + 1).fill(0);

  async function renderPage(n: number, targetScale: number) {
    if (renderedAtScale.get(n) === targetScale) return;
    const myToken = ++renderTokens[n];
    try {
      const page = await doc.getPage(n);
      if (myToken !== renderTokens[n]) return; // superseded by a newer scale/request
      const viewport = page.getViewport({ scale: targetScale });
      const canvas = pageCanvases[n - 1];
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const wrapper = pageWrappers[n - 1];
      wrapper.style.width = `${canvas.width}px`;
      wrapper.style.height = `${canvas.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (myToken !== renderTokens[n]) return;
      renderedAtScale.set(n, targetScale);
    } catch {
      // Leave unset so a later call (rescale, re-scroll) can retry — most
      // failures here are transient (e.g. a slow/aborted fetch mid-page).
    }
  }

  function computeFitWidthScale(): number {
    const availW = Math.max(50, pageArea.clientWidth - PAGE_GAP * 2);
    return availW / baseViewport.width;
  }

  function rescaleAll() {
    for (let n = 1; n <= pageCount; n++) estimateWrapperSize(n, scale);
    for (const n of nearPages) void renderPage(n, scale);
  }

  function goTo(n: number) {
    const clamped = Math.min(pageCount, Math.max(1, n));
    pageWrappers[clamped - 1].scrollIntoView({ block: "start" });
    // Set optimistically so the toolbar/rail feel immediate; the scroll
    // observer below will confirm (or correct) this once it settles.
    currentPage = clamped;
    pageInput.value = String(currentPage);
    highlightThumb();
  }

  prevBtn.onclick = () => goTo(currentPage - 1);
  nextBtn.onclick = () => goTo(currentPage + 1);
  pageInput.onchange = () => {
    const n = parseInt(pageInput.value, 10);
    if (Number.isFinite(n)) goTo(n);
    else pageInput.value = String(currentPage);
  };
  zoomInBtn.onclick = () => {
    usingManualScale = true;
    scale = Math.min(4, scale * 1.2);
    rescaleAll();
  };
  zoomOutBtn.onclick = () => {
    usingManualScale = true;
    scale = Math.max(0.2, scale / 1.2);
    rescaleAll();
  };
  fitBtn.onclick = () => {
    usingManualScale = false;
    scale = computeFitWidthScale();
    rescaleAll();
  };

  window.addEventListener("keydown", (e) => {
    if (document.activeElement === pageInput) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") {
      e.preventDefault();
      goTo(currentPage + 1);
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault();
      goTo(currentPage - 1);
    }
  });

  // Recomputes fit-width on the very first real layout (the page area has
  // no size yet when this function runs) and on any later resize.
  new ResizeObserver(() => {
    if (!usingManualScale) scale = computeFitWidthScale();
    rescaleAll();
  }).observe(pageArea);

  // Renders pages a bit before they'd actually be visible, so scrolling
  // never outruns the pixels. Kept separate from the "which page are we
  // on" tracking below since its generous lookahead would otherwise make
  // the page counter jump early.
  const nearPages = new Set<number>();
  const renderObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const n = Number((entry.target as HTMLElement).dataset.page);
        if (entry.isIntersecting) {
          nearPages.add(n);
          void renderPage(n, scale);
        } else {
          nearPages.delete(n);
        }
      }
    },
    { root: pageArea, rootMargin: RENDER_LOOKAHEAD },
  );

  // Tracks which page is actually most visible right now, to keep the page
  // number box and the thumbnail rail's highlight honest while scrolling.
  const visibleRatios = new Map<number, number>();
  function updateCurrentPageFromScroll() {
    let best = currentPage;
    let bestRatio = 0;
    for (const [n, ratio] of visibleRatios) {
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = n;
      }
    }
    if (best !== currentPage) {
      currentPage = best;
      highlightThumb();
    }
    pageInput.value = String(currentPage);
  }
  const currentPageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const n = Number((entry.target as HTMLElement).dataset.page);
        if (entry.isIntersecting) visibleRatios.set(n, entry.intersectionRatio);
        else visibleRatios.delete(n);
      }
      updateCurrentPageFromScroll();
    },
    { root: pageArea, threshold: [0, 0.25, 0.5, 0.75, 1] },
  );

  pageWrappers.forEach((w) => {
    renderObserver.observe(w);
    currentPageObserver.observe(w);
  });

  // ---- thumbnail rail (lazy: only rendered once scrolled near) ----
  const rail = el("div", { class: "pdf-rail" });
  const railScroll = el("div", { class: "rail-scroll" }, [rail]);

  const thumbButtons: HTMLButtonElement[] = [];
  const thumbCanvases: HTMLCanvasElement[] = [];
  const renderedThumbs = new Set<number>();

  function highlightThumb() {
    thumbButtons.forEach((b, i) => b.classList.toggle("active", i + 1 === currentPage));
    thumbButtons[currentPage - 1]?.scrollIntoView({ block: "nearest" });
  }

  async function renderThumb(n: number) {
    if (renderedThumbs.has(n)) return;
    renderedThumbs.add(n);
    try {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
      const canvas = thumbCanvases[n - 1];
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch {
      renderedThumbs.delete(n); // allow a retry later if this was transient
    }
  }

  const thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = thumbButtons.indexOf(entry.target as HTMLButtonElement);
        if (idx === -1) continue;
        thumbObserver.unobserve(entry.target);
        void renderThumb(idx + 1);
      }
    },
    { root: railScroll, rootMargin: "300px 0px" },
  );

  for (let n = 1; n <= pageCount; n++) {
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-thumb-canvas";
    const btn = el(
      "button",
      { class: "pdf-thumb", type: "button", title: `Page ${n}` },
      [canvas, el("span", { class: "pdf-thumb-label" }, [String(n)])],
    ) as HTMLButtonElement;
    btn.onclick = () => goTo(n);
    thumbCanvases.push(canvas);
    thumbButtons.push(btn);
    rail.append(btn);
    thumbObserver.observe(btn);
  }
  highlightThumb();

  // ---- chapter/outline panel (only shown when the PDF actually has one) ----
  let outlineEntries: OutlineEntry[] = [];
  try {
    const rawOutline = await doc.getOutline();
    if (rawOutline && rawOutline.length) {
      await flattenOutline(doc, rawOutline, 0, outlineEntries);
    }
  } catch {
    outlineEntries = [];
  }

  let railColumnChildren: (Node | string)[] = [railScroll];
  if (outlineEntries.length > 0) {
    const outlinePanel = el("div", { class: "rail-scroll" });

    // Entries with a deeper-depth entry immediately after them are their
    // parent's "has children" marker — outlineEntries is a DFS pre-order
    // flattening (see flattenOutline), so a node's children are exactly the
    // contiguous run of following entries with depth > its own, and that
    // run always starts right after it.
    const hasChildren = outlineEntries.map(
      (entry, i) => (outlineEntries[i + 1]?.depth ?? -1) > entry.depth,
    );
    // Collapsed by index into outlineEntries. Starts with every node that
    // has children folded, so a long/deep outline opens showing just its
    // top-level chapters rather than the whole tree at once — expanding is
    // opt-in per node from there, like the vault folder tree's ▸/▾ used to
    // be.
    const collapsedOutline = new Set<number>(
      hasChildren.flatMap((has, i) => (has ? [i] : [])),
    );

    function renderOutlinePanel() {
      outlinePanel.innerHTML = "";
      // Non-null while we're inside a collapsed node's subtree — every
      // entry with depth greater than this is skipped, since flattening is
      // pre-order (see above) so a subtree's entries are always contiguous.
      let hideBelowDepth: number | null = null;

      outlineEntries.forEach((entry, i) => {
        if (hideBelowDepth != null) {
          if (entry.depth > hideBelowDepth) return; // still inside the collapsed subtree
          hideBelowDepth = null; // back out of it
        }

        const collapsed = collapsedOutline.has(i);
        if (hasChildren[i] && collapsed) hideBelowDepth = entry.depth;

        const row = el("div", { class: "outline-row" });
        row.style.paddingLeft = `${entry.depth * 14}px`;

        if (hasChildren[i]) {
          const toggle = el(
            "button",
            { class: "outline-toggle", type: "button", title: collapsed ? "Expand" : "Collapse" },
            [collapsed ? "▸" : "▾"],
          ) as HTMLButtonElement;
          toggle.onclick = () => {
            if (collapsed) collapsedOutline.delete(i);
            else collapsedOutline.add(i);
            renderOutlinePanel();
          };
          row.append(toggle);
        } else {
          row.append(el("span", { class: "outline-toggle" }, [""]));
        }

        const btn = el(
          "button",
          { class: "outline-item", type: "button" },
          [entry.title],
        ) as HTMLButtonElement;
        if (entry.pageNumber != null) {
          const target = entry.pageNumber;
          btn.onclick = () => goTo(target);
        } else {
          btn.disabled = true;
        }
        row.append(btn);

        outlinePanel.append(row);
      });
    }
    renderOutlinePanel();

    // Chapters is the default view when a PDF actually has an outline —
    // more useful to land on than a wall of page thumbnails. Pages tab
    // (and thus the thumbnail rail) only becomes visible if picked.
    railScroll.hidden = true;

    const pagesTab = el("button", { class: "pdf-rail-tab", type: "button" }, ["Pages"]);
    const chaptersTab = el("button", { class: "pdf-rail-tab active", type: "button" }, ["Chapters"]);
    pagesTab.onclick = () => {
      pagesTab.classList.add("active");
      chaptersTab.classList.remove("active");
      railScroll.hidden = false;
      outlinePanel.hidden = true;
    };
    chaptersTab.onclick = () => {
      chaptersTab.classList.add("active");
      pagesTab.classList.remove("active");
      railScroll.hidden = true;
      outlinePanel.hidden = false;
    };
    const railTabs = el("div", { class: "pdf-rail-tabs" }, [pagesTab, chaptersTab]);
    railColumnChildren = [railTabs, railScroll, outlinePanel];
  }

  const railColumn = el("div", { class: "rail-column" }, railColumnChildren);
  const main = el("div", { class: "pdf-main" }, [toolbar, pageArea]);
  const root = el("div", { class: "pdf-reader" }, [railColumn, main]);

  return root;
}
