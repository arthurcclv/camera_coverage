/**
 * The hierarchy **group-header** context menu's per-group items (spec §5.5, §15.1).
 *
 * The sibling of `ui/entityMenu.ts`, and it exists for the same reason: the items
 * are a `Record<GroupKind, …>`, so a group added to the tree without declaring its
 * list is a **compile error** rather than a header that silently opens the wrong
 * menu — the failure `entityMenu.ts`'s header documents at length.
 *
 * Group headers had **no** menu at all before this (spec §5.5), and most still
 * behave that way: only **Cameras** and **Geometry** declare an item, every other
 * group declares `[]`, and an empty list opens **nothing** — right-clicking
 * Probes, Sections, Zones, Constraints or Splats stays the no-op it always was.
 * That is the point of an empty array over an absent key: "this group has no
 * items" is a stated decision, not an oversight.
 *
 * **Geometry** declares **Import model…** (`asset_import.md` §3.1), so the empty
 * geometry list has a route out of itself without going via the header's "+"
 * menu — the one place a group with no rows can still be acted on.
 */
import type { GroupKind } from '../scene/sceneTree.ts';

/** One entry in a group header's menu. */
export interface GroupMenuItem {
  /**
   * The menu label. **No trailing ellipsis** on the export item: nothing opens —
   * the file downloads (spec §15.1). In this app "…" marks a dialog (§14.7).
   */
  label: string;
  /**
   * Why the item is unavailable, or null when it can run (spec §15.1) — the same
   * blocker-string shape the "+" menu's **3D Gaussian Splat…** entry uses, so a
   * disabled row explains itself in its `title` instead of just not responding.
   */
  disabled: string | null;
  run(): void;
}

/** The per-group callbacks and gating the hierarchy takes for its header menus. */
export interface GroupMenuHandlers {
  /** Write the camera info sidecar file (spec §15). */
  onExportCameraInfo(): void;
  /**
   * Why **Export camera info** is unavailable, or null (spec §15.1). Non-null
   * while a previous export's rays are still being cast, which is what keeps a
   * second click from starting a second worker over the same mesh.
   */
  exportCameraInfoBlocker: string | null;
  /** Open the OS picker for a mesh asset (`asset_import.md` §3.1). */
  onImportModel(): void;
  /** The **Import model…** label, translated by the caller. */
  importModelLabel: string;
}

/** Which items each group header offers, per group (spec §15.1). */
export function groupMenuItems(h: GroupMenuHandlers): Record<GroupKind, GroupMenuItem[]> {
  return {
    cameras: [
      { label: 'Export camera info', disabled: h.exportCameraInfoBlocker, run: h.onExportCameraInfo },
    ],
    probes: [],
    sections: [],
    zones: [],
    constraints: [],
    geometry: [{ label: h.importModelLabel, disabled: null, run: h.onImportModel }],
    splats: [],
  };
}
