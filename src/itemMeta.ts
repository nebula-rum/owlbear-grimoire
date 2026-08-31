// Small shared display metadata for each vault item type, used by the
// folder tree (main.ts) — kept separate rather than inlined there in case a
// future screen needs the same {icon, label} per type.
import { VaultItemType } from "./types";

export const TYPE_META: Record<VaultItemType, { icon: string; label: string }> = {
  folder: { icon: "📁", label: "Folder" }, // 📁
  pdf: { icon: "📄", label: "PDF" }, // 📄
  markdown: { icon: "📝", label: "Markdown" }, // 📝
  link: { icon: "🔗", label: "Link" }, // 🔗
};
