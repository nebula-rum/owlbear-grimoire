// Recursively mirrors a public Google Drive folder's structure into vault
// items — lets a GM prep a whole room's handout tree in Drive once, then
// pull it in with a single link instead of adding each PDF/Markdown file by
// hand. Same trust model as the rest of drive.ts: the folder — and
// everything inside it — must be shared "Anyone with the link", since this
// only ever authenticates with the public API key, never as the GM.
import { extractDriveFolderId, driveFileViewUrl } from "./drive";
import { newId, VaultItem } from "./types";

const FOLDER_MIME = "application/vnd.google-apps.folder";
// Defensive only — Drive's `parents` relationship can't actually cycle, but
// this caps how far a pathological (or just huge) tree can drag the import
// process out.
const MAX_DEPTH = 12;

export class DriveImportError extends Error {}

interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
}

async function driveApiFetch<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new DriveImportError(
      "Network request to Google Drive failed. Check your connection and that the Drive API key's referrer restriction includes this site.",
    );
  }
  if (!response.ok) {
    if (response.status === 403) {
      throw new DriveImportError(
        "Google Drive refused this request (403). Make sure the folder — and everything inside it — is shared as \"Anyone with the link\".",
      );
    }
    if (response.status === 404) {
      throw new DriveImportError(
        "Google Drive couldn't find that folder (404). Double-check the link and that it hasn't been moved or deleted.",
      );
    }
    let detail = `Google Drive request failed (HTTP ${response.status}).`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      // Not JSON — keep the plain HTTP-status message above.
    }
    throw new DriveImportError(detail);
  }
  return (await response.json()) as T;
}

function getFileMeta(fileId: string, apiKey: string): Promise<DriveFileMeta> {
  const params = new URLSearchParams({ fields: "id,name,mimeType", key: apiKey });
  return driveApiFetch<DriveFileMeta>(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
  );
}

async function listChildren(folderId: string, apiKey: string): Promise<DriveFileMeta[]> {
  const children: DriveFileMeta[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: "1000",
      key: apiKey,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await driveApiFetch<{ files?: DriveFileMeta[]; nextPageToken?: string }>(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    );
    children.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return children;
}

function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

export interface DriveImportStats {
  folders: number;
  pdfs: number;
  markdown: number;
  /** Anything else (images, Google Docs/Slides, other file types) — not a
   *  type Grimoire renders inline, so it's added as a "link" item instead
   *  of being silently dropped. */
  links: number;
}

export interface DriveImportResult {
  rootName: string;
  items: VaultItem[];
  stats: DriveImportStats;
}

/** One folder level: creates a vault item for every child, then recurses
 *  into subfolders after the whole level's items are pushed (so a failure
 *  deeper in the tree doesn't leave this level half-written). */
async function walk(
  folderId: string,
  parentId: string,
  apiKey: string,
  items: VaultItem[],
  stats: DriveImportStats,
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const children = await listChildren(folderId, apiKey);
  const subfolders: { driveId: string; vaultId: string }[] = [];

  children.forEach((child, order) => {
    if (child.mimeType === FOLDER_MIME) {
      const vaultId = newId();
      items.push({ id: vaultId, name: child.name, type: "folder", parentId, hidden: true, order });
      stats.folders++;
      subfolders.push({ driveId: child.id, vaultId });
    } else if (child.mimeType === "application/pdf") {
      items.push({
        id: newId(),
        name: child.name,
        type: "pdf",
        parentId,
        hidden: true,
        order,
        url: driveFileViewUrl(child.id),
        driveFileId: child.id,
      });
      stats.pdfs++;
    } else if (isMarkdownName(child.name)) {
      items.push({
        id: newId(),
        name: child.name,
        type: "markdown",
        parentId,
        hidden: true,
        order,
        url: driveFileViewUrl(child.id),
        driveFileId: child.id,
      });
      stats.markdown++;
    } else {
      items.push({
        id: newId(),
        name: child.name,
        type: "link",
        parentId,
        hidden: true,
        order,
        linkUrl: driveFileViewUrl(child.id),
      });
      stats.links++;
    }
  });

  for (const sub of subfolders) {
    await walk(sub.driveId, sub.vaultId, apiKey, items, stats, depth + 1);
  }
}

/**
 * Mirrors a whole public Drive folder tree into a new top-level vault
 * folder named after it. `rootOrder` places that new folder among the
 * vault's existing root-level items (pass `nextOrder(vault.items, null)`) —
 * this module has no vault access of its own, so it can't compute that
 * itself. Every created item defaults `hidden: true`, same safe default as
 * adding one by hand.
 */
export async function importDriveFolder(
  folderUrlOrId: string,
  apiKey: string,
  rootOrder: number,
): Promise<DriveImportResult> {
  const folderId = extractDriveFolderId(folderUrlOrId);
  if (!folderId) {
    throw new DriveImportError("Couldn't find a Google Drive folder id in that link.");
  }

  const root = await getFileMeta(folderId, apiKey);
  if (root.mimeType !== FOLDER_MIME) {
    throw new DriveImportError("That link points to a file, not a folder.");
  }

  const items: VaultItem[] = [];
  const stats: DriveImportStats = { folders: 0, pdfs: 0, markdown: 0, links: 0 };
  const rootId = newId();
  items.push({ id: rootId, name: root.name, type: "folder", parentId: null, hidden: true, order: rootOrder });
  stats.folders++;

  await walk(folderId, rootId, apiKey, items, stats, 1);

  return { rootName: root.name, items, stats };
}
