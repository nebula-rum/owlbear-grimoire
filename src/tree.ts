// Small pure helpers for working with the flat VaultItem[] list as a tree.
import { VaultItem } from "./types";

export function childrenOf(items: VaultItem[], parentId: string | null): VaultItem[] {
  return items
    .filter((i) => i.parentId === parentId)
    .sort((a, b) => a.order - b.order);
}

/** True if this item, or any ancestor folder, is marked hidden. */
export function isEffectivelyHidden(items: VaultItem[], item: VaultItem): boolean {
  let current: VaultItem | undefined = item;
  const seen = new Set<string>();
  while (current) {
    if (current.hidden) return true;
    if (seen.has(current.id)) break; // guard against accidental cycles
    seen.add(current.id);
    current = current.parentId
      ? items.find((i) => i.id === current!.parentId)
      : undefined;
  }
  return false;
}

/** All descendant ids of a folder (not including the folder itself). */
export function descendantIds(items: VaultItem[], folderId: string): string[] {
  const result: string[] = [];
  const stack = [folderId];
  while (stack.length) {
    const parent = stack.pop()!;
    for (const child of items.filter((i) => i.parentId === parent)) {
      result.push(child.id);
      if (child.type === "folder") stack.push(child.id);
    }
  }
  return result;
}

export function nextOrder(items: VaultItem[], parentId: string | null): number {
  const siblings = childrenOf(items, parentId);
  return siblings.length ? siblings[siblings.length - 1].order + 1 : 0;
}

/** Would moving `itemId` under `newParentId` create a cycle (move a folder
 *  into its own descendant, or into itself)? */
export function wouldCreateCycle(
  items: VaultItem[],
  itemId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  if (itemId === newParentId) return true;
  return descendantIds(items, itemId).includes(newParentId);
}
