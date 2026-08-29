// Persistence layer: reads/writes the vault as a single JSON blob in
// Owlbear's room metadata, so it's shared live with every connected client
// (GM and players) and persists with the room across sessions.
import OBR from "@owlbear-rodeo/sdk";
import { EMPTY_VAULT, VaultData } from "./types";

const METADATA_KEY = "dev.fede.grimoire/data";
// Owlbear caps total room metadata at 16kB. We stay comfortably under that
// so other extensions sharing the room still have headroom.
const MAX_METADATA_BYTES = 15000;

export type Unsubscribe = () => void;

function parse(raw: unknown): VaultData {
  if (raw && typeof raw === "object") {
    const data = raw as Partial<VaultData>;
    if (Array.isArray(data.items)) {
      return {
        version: 1,
        config: data.config ?? {},
        items: data.items,
      };
    }
  }
  return structuredClone(EMPTY_VAULT);
}

/** One-time read of the current vault. */
export async function loadVault(): Promise<VaultData> {
  const metadata = await OBR.room.getMetadata();
  return parse(metadata[METADATA_KEY]);
}

/** Subscribe to live updates (fires on every change, from any client). */
export function onVaultChange(callback: (vault: VaultData) => void): Unsubscribe {
  return OBR.room.onMetadataChange((metadata) => {
    callback(parse(metadata[METADATA_KEY]));
  });
}

export class VaultSizeError extends Error {}

/** Persist the full vault. Only ever call this from a GM client. */
export async function saveVault(vault: VaultData): Promise<void> {
  const json = JSON.stringify(vault);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_METADATA_BYTES) {
    throw new VaultSizeError(
      `Your vault is ${(bytes / 1024).toFixed(1)}kB, over the ${(
        MAX_METADATA_BYTES / 1024
      ).toFixed(0)}kB safety limit (Owlbear caps all room metadata at 16kB total). ` +
        `Delete a few items, shorten names, or split content across multiple rooms/scenes.`,
    );
  }
  await OBR.room.setMetadata({ [METADATA_KEY]: vault });
}

/**
 * Batches rapid GM edits (e.g. typing a rename) into a single write so we
 * don't spam setMetadata on every keystroke.
 */
export function createDebouncedSaver(
  onError: (err: unknown) => void,
  delayMs = 400,
): (vault: VaultData) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: VaultData | undefined;
  return (vault: VaultData) => {
    latest = vault;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const toSave = latest;
      latest = undefined;
      if (toSave) saveVault(toSave).catch(onError);
    }, delayMs);
  };
}
