// Parsing & URL-building for Google Drive "anyone with the link" shares.
// The file must be shared as "Anyone with the link" (Viewer is enough) for
// any of this to work — Grimoire never authenticates as you, it only
// reaches content Google already serves publicly to that link.

const ID_PATTERNS: RegExp[] = [
  /\/file\/d\/([a-zA-Z0-9_-]{10,})/, // .../file/d/<id>/view
  /\/document\/d\/([a-zA-Z0-9_-]{10,})/, // Google Docs
  /[?&]id=([a-zA-Z0-9_-]{10,})/, // ...?id=<id> (open?id=, uc?id=)
  /\/d\/([a-zA-Z0-9_-]{10,})/, // fallback: any /d/<id>/
];

/**
 * Extract a Google Drive file id from any of the common share-link shapes.
 * Returns null if `url` doesn't look like a Drive link, or if a raw id was
 * passed in directly (in which case it's returned as-is).
 */
export function extractDriveFileId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  for (const pattern of ID_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }

  // A bare file id, no URL wrapper (Drive ids don't contain '/' or spaces).
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;

  return null;
}

/** Embeddable preview URL — works for PDFs with zero extra setup, no API key. */
export function driveFilePreviewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
}

/** "Open in Drive" URL, used as a fallback / "open in new tab" link. */
export function driveFileViewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

/**
 * Raw file bytes via the Drive REST API. Requires an API key (see
 * markdown.ts) and only works for publicly-shared files. Used to pull the
 * raw text of a .md file so it can be rendered as real markdown instead of
 * shown as a plain-text preview.
 */
export function driveApiMediaUrl(fileId: string, apiKey: string): string {
  const params = new URLSearchParams({ alt: "media", key: apiKey });
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId,
  )}?${params.toString()}`;
}

/**
 * Fetch the small cover thumbnail Drive auto-generates for a file (usually
 * a render of page 1), if it has one — not every file gets one, and it
 * requires the same API key as Markdown rendering. Returns null rather than
 * throwing on any failure (missing key, no thumbnail, network error), since
 * this is always a "nice to have" next to the plain type icon.
 */
export async function fetchDriveThumbnail(fileId: string, apiKey: string): Promise<string | null> {
  const params = new URLSearchParams({ fields: "thumbnailLink", key: apiKey });
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = (await response.json()) as { thumbnailLink?: string };
    return data.thumbnailLink ?? null;
  } catch {
    return null;
  }
}
