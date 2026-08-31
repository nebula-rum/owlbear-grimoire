// Fetches a Markdown file's raw text from Google Drive and renders it to
// sanitized HTML, plus the flat heading list used for the chapter sidebar
// (see main.ts's buildViewerNode) and for the document's own "#section"
// links to actually have somewhere to land.
import { marked, Renderer, Tokens } from "marked";
import DOMPurify from "dompurify";
import { driveApiMediaUrl } from "./drive";

marked.setOptions({ breaks: true, gfm: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    // An in-page "#heading-id" link — including the ones the chapter
    // sidebar itself doesn't need (a source document's own hand-written
    // table of contents) — should still scroll within the pane. Only real
    // external links get force-opened in a new tab; otherwise navigating an
    // embedded viewer iframe in place gets silently blocked by Owlbear's
    // host sandboxing, so every link (in-page ones included) looked dead.
    if (href.startsWith("#")) return;
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export class MarkdownFetchError extends Error {}

export interface MarkdownHeading {
  id: string;
  title: string;
  /** 1-based heading level (h1 = 1 … h6 = 6). */
  depth: number;
}

export interface RenderedMarkdown {
  html: string;
  headings: MarkdownHeading[];
}

/** Turns heading text into a URL-fragment-safe, unique-within-the-document
 *  id — duplicate titles get -1, -2, ... appended, same convention GitHub's
 *  own Markdown rendering uses. */
function slugify(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-") || "section";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/**
 * Fetch the raw contents of a Drive-hosted markdown file and render it to
 * sanitized HTML ready to drop into innerHTML, alongside the heading list
 * extracted along the way.
 *
 * Requires a Google Cloud API key with the Drive API enabled (see the
 * README's "Fully rendered Markdown" setup section) and the file shared as
 * "Anyone with the link".
 */
export async function fetchRenderedMarkdown(
  fileId: string,
  apiKey: string,
): Promise<RenderedMarkdown> {
  const url = driveApiMediaUrl(fileId, apiKey);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new MarkdownFetchError(
      "Network request to Google Drive failed. Check your connection and that the Drive API key's referrer restriction includes this site.",
    );
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new MarkdownFetchError(
        "Google Drive refused this request (403). Make sure the file is shared as \"Anyone with the link\", the Drive API is enabled on your Google Cloud project, and the API key's website restriction includes this extension's URL.",
      );
    }
    if (response.status === 404) {
      throw new MarkdownFetchError(
        "Google Drive couldn't find that file (404). Double-check the share link and that the file hasn't been moved or deleted.",
      );
    }
    throw new MarkdownFetchError(`Google Drive request failed (HTTP ${response.status}).`);
  }

  const raw = await response.text();

  // A fresh Renderer per call (rather than mutating the module-level
  // `marked` defaults) so this call's `headings`/`seenSlugs` state can't
  // leak into some other concurrent or later render.
  const headings: MarkdownHeading[] = [];
  const seenSlugs = new Map<string, number>();
  const renderer = new Renderer();
  // Overridden instead of relying on marked's default heading renderer —
  // marked stopped generating heading `id`s itself as of v5 (moved to a
  // separate `marked-gfm-heading-id` extension this project doesn't pull
  // in), so without this, neither a document's own "#section" links nor the
  // chapter sidebar would have anything to scroll to.
  renderer.heading = ({ text, depth }: Tokens.Heading): string => {
    const renderedText = marked.parseInline(text) as string;
    const plainText = DOMPurify.sanitize(renderedText, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }).trim();
    const id = slugify(plainText, seenSlugs);
    headings.push({ id, title: plainText || `Heading ${headings.length + 1}`, depth });
    return `<h${depth} id="${id}">${renderedText}</h${depth}>\n`;
  };

  const html = await marked.parse(raw, { renderer });
  return { html: DOMPurify.sanitize(html), headings };
}
