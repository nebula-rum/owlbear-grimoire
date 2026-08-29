// Fetches a Markdown file's raw text from Google Drive and renders it to
// sanitized HTML.
import { marked } from "marked";
import DOMPurify from "dompurify";
import { driveApiMediaUrl } from "./drive";

marked.setOptions({ breaks: true, gfm: true });

export class MarkdownFetchError extends Error {}

/**
 * Fetch the raw contents of a Drive-hosted markdown file and render it to
 * sanitized HTML ready to drop into innerHTML.
 *
 * Requires a Google Cloud API key with the Drive API enabled (see the
 * README's "Fully rendered Markdown" setup section) and the file shared as
 * "Anyone with the link".
 */
export async function fetchRenderedMarkdown(
  fileId: string,
  apiKey: string,
): Promise<string> {
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
  const html = await marked.parse(raw);
  return DOMPurify.sanitize(html);
}
