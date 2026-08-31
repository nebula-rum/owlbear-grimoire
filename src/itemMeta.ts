// Small shared display metadata for each vault item type — kept separate so
// both the sidebar tree (main.ts) and the viewer's in-modal browse drawer
// (viewer.ts) render items identically instead of drifting apart.
import { VaultItemType } from "./types";

export const TYPE_META: Record<VaultItemType, { icon: string; label: string }> = {
  folder: { icon: "📁", label: "Folder" }, // 📁
  pdf: { icon: "📄", label: "PDF" }, // 📄
  markdown: { icon: "📝", label: "Markdown" }, // 📝
  link: { icon: "🔗", label: "Link" }, // 🔗
};
