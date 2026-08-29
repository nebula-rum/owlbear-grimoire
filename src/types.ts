// Shared data model for Grimoire.
//
// Everything the vault knows about is stored as ONE JSON blob in Owlbear's
// room metadata (see store.ts). Room metadata is capped at 16kB total, and
// is shared live with every connected player, so keep this shape lean and
// keep player-facing visibility a client-side filter, not a secret.

export type VaultItemType = "folder" | "pdf" | "markdown" | "link";

export interface VaultItem {
  /** Stable random id, used as parentId by children and as viewer.html's ?id= */
  id: string;
  name: string;
  type: VaultItemType;
  /** id of the parent folder, or null for a root-level item */
  parentId: string | null;
  /** GM-only visibility switch. Hidden items (and anything inside a hidden
   *  folder) are filtered out of the tree a PLAYER-role client renders. */
  hidden: boolean;
  /** Sort position among siblings (lower first). */
  order: number;
  /** Original Google Drive share link, only set for pdf/markdown items. */
  url?: string;
  /** Parsed Google Drive file id, only set for pdf/markdown items. */
  driveFileId?: string;
  /** Arbitrary external URL, only set for "link" items. */
  linkUrl?: string;
}

export interface VaultConfig {
  /** Google Cloud API key with the Drive API enabled, used to fetch raw
   *  markdown file contents (needed for full rendering). Not needed for
   *  PDFs, which are shown via Drive's own preview iframe. This key is
   *  meant to be restricted by HTTP referrer to your extension's hosted
   *  domain, so storing it in shared room metadata (visible to players'
   *  clients, same as everything else here) is the intended, safe use. */
  driveApiKey?: string;
}

export interface VaultData {
  version: 1;
  config: VaultConfig;
  items: VaultItem[];
}

export const EMPTY_VAULT: VaultData = {
  version: 1,
  config: {},
  items: [],
};

export function newId(): string {
  // crypto.randomUUID is available in all browsers Owlbear Rodeo supports.
  return crypto.randomUUID();
}
