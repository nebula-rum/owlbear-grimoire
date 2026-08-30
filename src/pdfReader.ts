// A self-contained PDF reader: page navigation, zoom controls, and a lazy
// thumbnail rail — built on pdf.js loaded from a CDN at runtime rather than
// as an npm dependency, so the project's package.json/lockfile stay
// untouched. The tradeoff is no compile-time types for pdf.js itself; the
// small slice of its API used below is described by the Minimal* interfaces.
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

interface MinimalDocument {
  numPages: number;
  getPage(n: number): Promise<MinimalPage>;
}

interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(params: { url: string }): { promise: Promise<MinimalDocument> };
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

/**
 * Build a full PDF reader UI — a lazy thumbnail rail, a page canvas, and a
 * toolbar with prev/next, a page number field, and zoom — for the given
 * Drive file. Throws if pdf.js fails to load or the file fails to parse;
 * the caller is expected to fall back to the plain iframe preview then.
 */
export async function renderPdfReader(fileId: string, apiKey: string): Promise<HTMLElement> {
  const pdfjsLib = await loadPdfJs();
  const doc = await pdfjsLib.getDocument({ url: driveApiMediaUrl(fileId, apiKey) }).promise;
  const pageCount = doc.numPages;

  let currentPage = 1;
  let scale = 1;
  let usingManualScale = false;
  let renderToken = 0;

  const rail = el("div", { class: "pdf-rail" });
  const railScroll = el("div", { class: "pdf-rail-scroll" }, [rail]);

  const pageCanvas = document.createElement("canvas");
  pageCanvas.className = "pdf-page-canvas";
  const pageArea = el("div", { class: "pdf-page-area" }, [pageCanvas]);

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
    { class: "btn secondary pdf-fit-btn", type: "button", title: "Fit whole page" },
    ["Fit page"],
  );

  const toolbar = el("div", { class: "pdf-toolbar" }, [
    el("div", { class: "pdf-toolbar-group" }, [prevBtn, pageInput, pageCountLabel, nextBtn]),
    el("div", { class: "pdf-toolbar-group" }, [zoomOutBtn, fitBtn, zoomInBtn]),
  ]);

  const main = el("div", { class: "pdf-main" }, [toolbar, pageArea]);
  const root = el("div", { class: "pdf-reader" }, [railScroll, main]);

  async function renderCurrentPage() {
    const myToken = ++renderToken;
    const page = await doc.getPage(currentPage);
    if (myToken !== renderToken) return;
    const base = page.getViewport({ scale: 1 });
    if (!usingManualScale) {
      const availW = Math.max(50, pageArea.clientWidth - 32);
      const availH = Math.max(50, pageArea.clientHeight - 32);
      scale = Math.min(availW / base.width, availH / base.height);
    }
    const viewport = page.getViewport({ scale });
    const ctx = pageCanvas.getContext("2d");
    if (!ctx) return;
    pageCanvas.width = Math.ceil(viewport.width);
    pageCanvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (myToken !== renderToken) return;
    pageInput.value = String(currentPage);
    highlightThumb();
  }

  function goTo(n: number) {
    currentPage = Math.min(pageCount, Math.max(1, n));
    void renderCurrentPage();
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
    void renderCurrentPage();
  };
  zoomOutBtn.onclick = () => {
    usingManualScale = true;
    scale = Math.max(0.2, scale / 1.2);
    void renderCurrentPage();
  };
  fitBtn.onclick = () => {
    usingManualScale = false;
    void renderCurrentPage();
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

  // ResizeObserver's first callback always fires once the element has real
  // layout, which is exactly when we can first know pageArea's size — this
  // is what drives the very first paint (the node isn't attached to the
  // document yet when this function runs, so measuring now would be 0x0).
  new ResizeObserver(() => {
    if (!usingManualScale) void renderCurrentPage();
  }).observe(pageArea);

  // ---- thumbnail rail (lazy: only rendered once scrolled near) ----
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

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = thumbButtons.indexOf(entry.target as HTMLButtonElement);
        if (idx === -1) continue;
        observer.unobserve(entry.target);
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
    observer.observe(btn);
  }
  highlightThumb();

  return root;
}
