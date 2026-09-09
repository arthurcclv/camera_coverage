/**
 * Scene hierarchy view (spec §5.5; `sampling_volumes.md` §4). A generic tree — a
 * `TreeRow` shell plus per-`node.kind` content — rendering a "Cameras" group over
 * camera nodes and, when any exist, sibling "Probes"/"Sections" groups and a
 * "Zones" umbrella over selectable+expandable zone nodes (each holding its volume
 * children). Kind-specific chrome lives in the per-kind row-content components;
 * adding a future entity type means adding a node variant + its row-content
 * component, not touching the shell.
 *
 * The panel header carries the "+" add-entity menu — including the one entry
 * that opens a dialog instead of spawning an entity, **3D Gaussian Splat…**
 * (`gaussian_splats.md` §3.2); right-clicking a camera, probe, section, zone,
 * volume, constraint, or splat row opens a Duplicate/Delete context menu.
 *
 * Rows also **drag to reorder within their own group** (spec §5.5.1) via
 * `useDragReorder` below. That hook owns only the pointer plumbing — threshold,
 * window listeners, Escape, auto-scroll; every geometric decision lives in the pure
 * `scene/reorder.ts`, which is where the tests are.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SceneCamera } from '../cameras/camera.ts';
import type { Probe } from '../scene/probeVisibility.ts';
import { averageDisplayValue, type Section, type SectionCellGrid } from '../scene/sectionHeatmap.ts';
import type { SamplingVolume, Zone, ZoneSummary } from '../scene/samplingVolumes.ts';
import { splatBadge, type SplatLoadState, type SplatObject } from '../scene/splats.ts';
import type { Selection } from '../scene/viewportSelection.ts';
import {
  primitiveMeasure,
  type CameraConstraint,
  type ConstraintGroup,
  type ConstraintKind,
} from '../placement/region.ts';
import {
  buildSceneTree,
  flattenVisible,
  nodeEnabled,
  nodeIdForSelection,
  nodeSelection,
  type EnabledLookup,
  type RenderRow,
  type SceneNode,
} from '../scene/sceneTree.ts';
import {
  insertionTargetAt,
  type InsertionTarget,
  type ReorderableKind,
  type RowBox,
} from '../scene/reorder.ts';
import {
  deleteHandlers,
  duplicateHandlers,
  type DeletableKind,
  type EntityMenuHandlers,
} from './entityMenu.ts';
import { popoverSide, MENU_WIDTH_PX } from './menuPopover.ts';

export interface SceneHierarchyProps extends EntityMenuHandlers {
  cameras: SceneCamera[];
  probes: Probe[];
  sections: Section[];
  zones: Zone[];
  volumes: SamplingVolume[];
  /** Camera-placement groups (`camera_placement.md` §7). */
  constraintGroups: ConstraintGroup[];
  constraints: CameraConstraint[];
  /** 3D Gaussian Splat captures (`gaussian_splats.md` §2.2). */
  splats: SplatObject[];
  /**
   * Per-splat load state (`gaussian_splats.md` §6.2) — derived side state held
   * beside the scene, like the retained per-run probe/section data, never part
   * of the entity and never serialized.
   */
  splatLoadStates: ReadonlyMap<string, SplatLoadState>;
  /** Unified selection (spec §5.5); drives the highlighted node. */
  selection: Selection;
  flaggedIds: Set<string>;
  perCamera: { id: string; coverageRate: number }[] | null;
  /** Per-probe enabled-cameras-that-see count, or null when no usable mask (§5.5). */
  probeSeenCounts: Map<string, number | null>;
  /** Per-section current cell grid, or null when no usable run (§13.4). */
  sectionCellGrids: Map<string, SectionCellGrid | null>;
  /** Per-zone coverage summary, or null when no usable run (`sampling_volumes.md` §4.1). */
  zoneSummaries: Map<string, ZoneSummary> | null;
  /** Ids of collapsed group/zone nodes (ephemeral UI state, §5.5). */
  collapsedIds: Set<string>;
  onSelect(selection: Selection): void;
  /** Toggle the row's enabled state — camera (enable/disable), section
   * (heatmap on/off), or zone (contributes to the marked set) — §5.5, §7.3. */
  onToggleEnabled(kind: ToggleableKind, id: string): void;
  onToggleCollapse(nodeId: string): void;
  onAddCamera(): void;
  onAddProbe(): void;
  onAddSection(): void;
  onAddZone(): void;
  onAddVolume(): void;
  onAddConstraintGroup(): void;
  /**
   * Add a constraint of `kind` to the targeted group (`camera_placement.md` §7).
   * A polyline arms the draw mode instead of spawning geometry (§6.2) — which of
   * the two happens is App's call, not the tree's.
   */
  onAddConstraint(kind: ConstraintKind): void;
  /**
   * Open the **Add 3DGS** dialog (`gaussian_splats.md` §3.2) — the one "+" entry
   * that opens a dialog rather than spawning an entity, and the one that is not
   * always enabled: it needs a scene folder to read `assets/` from.
   */
  onAddSplat(): void;
  /** Why **3D Gaussian Splat…** is disabled, or null when it is available (§3.2). */
  addSplatBlocker: string | null;
  /** Drag-reorder within a group (§5.5.1): move `id` before `beforeId`, or last when null. */
  onReorder(kind: ReorderableKind, id: string, beforeId: string | null): void;
}

/** Kinds whose row carries an enabled checkbox (spec §5.5, `camera_placement.md` §7). */
type ToggleableKind = 'camera' | 'section' | 'zone' | 'constraintGroup' | 'constraint' | 'splat';

interface ContextMenuState {
  x: number;
  y: number;
  kind: DeletableKind;
  id: string;
}

const ORIENTATION_SHORT: Record<Section['orientation'], string> = {
  horizontal: 'H',
  'vertical-x': 'VX',
  'vertical-z': 'VZ',
};

/** Pointer travel that arms a drag; below it, the press is a plain click (§5.5.1). */
const DRAG_THRESHOLD_PX = 4;
/** Edge band that auto-scrolls the tree while dragging, and its top speed (§5.5.1). */
const AUTOSCROLL_ZONE_PX = 24;
const AUTOSCROLL_MAX_PX_PER_FRAME = 14;
/** Row indent, matching the `paddingLeft: 8 + depth * 14` the rows render with. */
const INDENT_BASE_PX = 8;
const INDENT_STEP_PX = 14;

interface DragState {
  nodeId: string;
  kind: ReorderableKind;
  entityId: string;
  /** Resolved drop position, or null when the pointer is over an illegal spot. */
  target: InsertionTarget | null;
  /** Insertion line placement in the tree's scroll-content space, or null. */
  line: { top: number; left: number } | null;
}

interface PressState {
  nodeId: string;
  kind: ReorderableKind;
  entityId: string;
  startX: number;
  startY: number;
  armed: boolean;
}

/** The reorderable kind + entity id behind a row, or null for a group header. */
function reorderableTarget(node: SceneNode): { kind: ReorderableKind; entityId: string } | null {
  switch (node.kind) {
    case 'camera':
      return { kind: 'camera', entityId: node.cameraId };
    case 'probe':
      return { kind: 'probe', entityId: node.probeId };
    case 'section':
      return { kind: 'section', entityId: node.sectionId };
    case 'zone':
      return { kind: 'zone', entityId: node.zoneId };
    case 'volume':
      return { kind: 'volume', entityId: node.volumeId };
    case 'constraintGroup':
      return { kind: 'constraintGroup', entityId: node.groupId };
    case 'constraint':
      return { kind: 'constraint', entityId: node.constraintId };
    case 'splat':
      return { kind: 'splat', entityId: node.splatId };
    default:
      return null;
  }
}

/** Measure every rendered row's vertical extent, in viewport coordinates. */
function measureRows(tree: HTMLElement): Map<string, RowBox> {
  const boxes = new Map<string, RowBox>();
  for (const el of tree.querySelectorAll<HTMLElement>('li[data-node-id]')) {
    const nodeId = el.dataset.nodeId;
    if (!nodeId) continue;
    const r = el.getBoundingClientRect();
    boxes.set(nodeId, { nodeId, top: r.top, bottom: r.bottom });
  }
  return boxes;
}

/**
 * Drag-to-reorder for the hierarchy tree (spec §5.5.1). Owns only the pointer
 * plumbing — the threshold, window listeners, Escape, and the auto-scroll loop.
 * Every geometric decision (which slot, whether the drop is legal, where the line
 * goes) is delegated to the pure `scene/reorder.ts`, which is where the tests live.
 *
 * Window-level move/up listeners are attached on pointerdown rather than declared
 * as an effect, so a press that never crosses the threshold costs nothing and a
 * drag that leaves the panel still tracks.
 */
function useDragReorder(
  rows: RenderRow[],
  onReorder: (kind: ReorderableKind, id: string, beforeId: string | null) => void,
) {
  const treeRef = useRef<HTMLUListElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Refs mirror what the imperatively-attached listeners need, since they close
  // over the values present at pointerdown.
  const pressRef = useRef<PressState | null>(null);
  const pointerYRef = useRef(0);
  const rafRef = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const dragRef = useRef<DragState | null>(null);
  const setDragBoth = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  /** Re-run the hit-test at the current pointer Y and refresh the insertion line. */
  const refreshTarget = useCallback(() => {
    const press = pressRef.current;
    const tree = treeRef.current;
    if (!press?.armed || !tree) return;
    const boxes = measureRows(tree);
    const target = insertionTargetAt(pointerYRef.current, rowsRef.current, boxes, press.nodeId);
    // Viewport Y → the tree's scroll-content space, where the line is positioned.
    const treeRect = tree.getBoundingClientRect();
    const line =
      target === null
        ? null
        : {
            top: target.lineY - treeRect.top + tree.scrollTop,
            left: INDENT_BASE_PX + target.depth * INDENT_STEP_PX,
          };
    // Pointermove fires far more often than the line moves; skip the re-render
    // (of every row) when nothing visible actually changed.
    const prev = dragRef.current;
    const same = (a: number | string | null | undefined, b: number | string | null | undefined) =>
      (a ?? null) === (b ?? null);
    if (
      prev?.nodeId === press.nodeId &&
      same(prev.target?.beforeNodeId, target?.beforeNodeId) &&
      same(prev.line?.top, line?.top) &&
      same(prev.line?.left, line?.left)
    ) {
      return;
    }
    setDragBoth({ nodeId: press.nodeId, kind: press.kind, entityId: press.entityId, target, line });
  }, [setDragBoth]);

  /** rAF loop: scroll the tree while the pointer sits in an edge band (§5.5.1). */
  const autoScrollTick = useCallback(() => {
    const tree = treeRef.current;
    if (!pressRef.current?.armed || !tree) return;
    const rect = tree.getBoundingClientRect();
    const y = pointerYRef.current;
    const overTop = rect.top + AUTOSCROLL_ZONE_PX - y;
    const underBottom = y - (rect.bottom - AUTOSCROLL_ZONE_PX);
    // Speed ramps with how far into the band the pointer is.
    let dy = 0;
    if (overTop > 0) dy = -Math.min(1, overTop / AUTOSCROLL_ZONE_PX) * AUTOSCROLL_MAX_PX_PER_FRAME;
    else if (underBottom > 0) dy = Math.min(1, underBottom / AUTOSCROLL_ZONE_PX) * AUTOSCROLL_MAX_PX_PER_FRAME;
    if (dy !== 0) {
      const before = tree.scrollTop;
      tree.scrollTop = before + dy;
      if (tree.scrollTop !== before) refreshTarget();
    }
    rafRef.current = requestAnimationFrame(autoScrollTick);
  }, [refreshTarget]);

  const endDrag = useCallback(
    (commit: boolean) => {
      const press = pressRef.current;
      const current = dragRef.current;
      pressRef.current = null;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      setDragBoth(null);
      if (commit && press?.armed && current?.target) {
        onReorderRef.current(press.kind, press.entityId, current.target.beforeId);
      }
    },
    [setDragBoth],
  );
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;

  const onRowPointerDown = useCallback(
    (ev: React.PointerEvent, node: SceneNode) => {
      if (ev.button !== 0) return;
      const target = reorderableTarget(node);
      if (!target) return; // group headers are not draggable (§5.5.1)
      // The enabled checkbox and the expand caret keep their own behavior.
      if ((ev.target as HTMLElement).closest('input, button')) return;

      pressRef.current = {
        nodeId: node.id,
        kind: target.kind,
        entityId: target.entityId,
        startX: ev.clientX,
        startY: ev.clientY,
        armed: false,
      };

      const onMove = (e: PointerEvent) => {
        const press = pressRef.current;
        if (!press) return;
        pointerYRef.current = e.clientY;
        if (!press.armed) {
          const moved = Math.hypot(e.clientX - press.startX, e.clientY - press.startY);
          if (moved < DRAG_THRESHOLD_PX) return;
          press.armed = true;
          rafRef.current = requestAnimationFrame(autoScrollTick);
        }
        // Once armed, suppress text selection / native drag for the rest of the gesture.
        e.preventDefault();
        refreshTarget();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        // A completed drag must not also select the row (§5.5.1: selection is
        // untouched). The click that follows pointerup is swallowed once, in the
        // capture phase; the timeout releases the guard if no click arrives (the
        // pointer came up over a different element).
        if (pressRef.current?.armed) {
          const swallow = (e: MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
            release();
          };
          const release = () => {
            window.removeEventListener('click', swallow, true);
            clearTimeout(timer);
          };
          const timer = setTimeout(release, 0);
          window.addEventListener('click', swallow, true);
        }
        endDragRef.current(true);
      };
      const onCancel = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        endDragRef.current(false);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [autoScrollTick, refreshTarget],
  );

  // Escape aborts an in-flight drag and the row stays put (§5.5.1), mirroring the
  // armed-placement cancel (§2.4.2). Mounted only while dragging.
  useEffect(() => {
    if (!drag) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') endDragRef.current(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drag]);

  // A drag can't outlive the component (or a scene swap that unmounts rows).
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return { treeRef, drag, onRowPointerDown };
}

function dotColor(rate: number | undefined, flagged: boolean): string {
  if (flagged) return '#ff7d7d';
  if (rate === undefined) return '#5da9e0';
  const t = Math.max(0, Math.min(1, rate));
  const hue = (t * 120) / 360;
  return `hsl(${hue * 360}, 85%, 55%)`;
}

/**
 * A fixed-positioned popover's resolved place: which way it opens, its top, and
 * both candidate horizontal edges (spec §5.5).
 */
interface Placement {
  side: 'right' | 'left';
  top: number;
  /** Left edge in CSS px, used when `side` is `'right'`. */
  left: number;
  /** Distance from the window's right edge, used when `side` is `'left'`. */
  right: number;
}

/**
 * Measure `anchor` and resolve where an outward-opening popover goes, or null when
 * there is no anchor to measure (the popover then stays closed).
 *
 * `edges` names the anchor edges to open from: `outward` is where the popover's left
 * edge lands normally, `inward` the edge its right edge pins to on the flip.
 */
function placeOutward(
  anchor: HTMLElement | null,
  edges: (rect: DOMRect) => { outward: number; top: number; inward: number },
): Placement | null {
  if (!anchor) return null;
  const { outward, top, inward } = edges(anchor.getBoundingClientRect());
  return {
    side: popoverSide(outward, MENU_WIDTH_PX, window.innerWidth),
    top,
    left: outward,
    right: window.innerWidth - inward,
  };
}

export function SceneHierarchy(props: SceneHierarchyProps) {
  const { cameras, probes, sections, zones, volumes, selection, collapsedIds } = props;
  const { constraintGroups, constraints, splats } = props;
  const nodes = useMemo(
    () => buildSceneTree(cameras, probes, sections, zones, volumes, constraintGroups, constraints, splats),
    [cameras, probes, sections, zones, volumes, constraintGroups, constraints, splats],
  );
  const rows = useMemo(() => flattenVisible(nodes, collapsedIds), [nodes, collapsedIds]);
  const rateById = useMemo(
    () => new Map(props.perCamera?.map((p) => [p.id, p.coverageRate])),
    [props.perCamera],
  );
  const volumeById = useMemo(() => new Map(volumes.map((v) => [v.id, v])), [volumes]);
  const constraintById = useMemo(
    () => new Map(props.constraints.map((c) => [c.id, c])),
    [props.constraints],
  );
  const splatById = useMemo(() => new Map(splats.map((s) => [s.id, s])), [splats]);

  /**
   * Which entities are ticked, per kind (spec §5.4, §7.3) — one exhaustive
   * lookup for every row rather than a per-row `find` chain. Probes and zones'
   * own volumes have no checkbox of their own, so they never dim.
   */
  const enabledLookup = useMemo<EnabledLookup>(
    () => ({
      camera: (id) => cameras.find((c) => c.id === id)?.enabled ?? true,
      probe: () => true,
      section: (id) => sections.find((s) => s.id === id)?.enabled ?? true,
      zone: (id) => zones.find((z) => z.id === id)?.enabled ?? true,
      volume: () => true,
      constraintGroup: (id) => constraintGroups.find((g) => g.id === id)?.enabled ?? true,
      constraint: (id) => constraintById.get(id)?.enabled ?? true,
      splat: (id) => splatById.get(id)?.enabled ?? true,
    }),
    [cameras, sections, zones, constraintGroups, constraintById, splatById],
  );

  const selectedNodeId = nodeIdForSelection(selection);

  /**
   * The "+" popover's measured placement, or null when closed (spec §5.5).
   *
   * It opens **outward** — left edge at the button's left edge, extending right —
   * which overhangs `.left-panel`, so like the submenu below it is `position: fixed`
   * placed from the button's rect rather than absolute inside the panel, whose
   * `overflow: hidden` would clip it.
   */
  const [addMenu, setAddMenu] = useState<Placement | null>(null);
  const addMenuOpen = addMenu !== null;
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /**
   * The Constraint submenu's measured placement, or null when closed (spec §5.5).
   * One entry is enough because the "+" menu has exactly one nested row.
   */
  const [submenu, setSubmenu] = useState<Placement | null>(null);
  const constraintRowRef = useRef<HTMLLIElement | null>(null);
  const { treeRef, drag, onRowPointerDown } = useDragReorder(rows, props.onReorder);

  // Close either popover on any outside interaction (spec §5.5 menus are transient).
  useEffect(() => {
    if (!addMenuOpen && !contextMenu) return;
    const close = () => {
      setAddMenu(null);
      setSubmenu(null);
      setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [addMenuOpen, contextMenu]);

  // Hover *or* click opens the Constraint submenu, and the row itself adds nothing
  // (spec §5.5). The side is decided from the row's measured right edge, so a wide
  // left panel flips the popover inward instead of off-screen.
  const openSubmenu = () => {
    // Left edge at the row's right edge; 4px above its top, flush with the parent
    // popover's padding, so the two read as one surface.
    setSubmenu(placeOutward(constraintRowRef.current, (r) => ({ outward: r.right, top: r.top - 4, inward: r.left })));
  };
  // Travelling onto any sibling row closes it, as a desktop menu does.
  const closeSubmenu = () => setSubmenu(null);
  /** Dismiss the whole "+" popover — what picking any entry does. */
  const closeMenus = () => {
    setSubmenu(null);
    setAddMenu(null);
  };

  // The "+" popover opens below the button, its left edge on the button's left edge.
  const openAddMenu = () => {
    setSubmenu(null);
    setContextMenu(null);
    setAddMenu(placeOutward(addButtonRef.current, (r) => ({ outward: r.left, top: r.bottom + 4, inward: r.right })));
  };

  const openContextMenu = (ev: React.MouseEvent, kind: DeletableKind, id: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    setAddMenu(null);
    setContextMenu({ x: ev.clientX, y: ev.clientY, kind, id });
  };

  return (
    <div className="scene-hierarchy">
      <div className="panel-title scene-header">
        <span>Hierarchy</span>
        <div className="add-menu-anchor">
          <button
            type="button"
            className="btn secondary icon-btn add-btn"
            title="Add entity"
            aria-label="Add entity"
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            ref={addButtonRef}
            onClick={(e) => {
              e.stopPropagation();
              if (addMenuOpen) closeMenus();
              else openAddMenu();
            }}
          >
            +
          </button>
          {addMenu && (
            <ul
              className="menu"
              role="menu"
              style={
                addMenu.side === 'right'
                  ? { top: addMenu.top, left: addMenu.left }
                  : { top: addMenu.top, right: addMenu.right }
              }
            >
              <li role="menuitem" onPointerEnter={closeSubmenu} onClick={() => { setAddMenu(null); props.onAddCamera(); }}>
                Camera
              </li>
              <li role="menuitem" onPointerEnter={closeSubmenu} onClick={() => { setAddMenu(null); props.onAddProbe(); }}>
                Probe
              </li>
              <li role="menuitem" onPointerEnter={closeSubmenu} onClick={() => { setAddMenu(null); props.onAddSection(); }}>
                Section
              </li>
              <li role="menuitem" onPointerEnter={closeSubmenu} onClick={() => { setAddMenu(null); props.onAddZone(); }}>
                Zone
              </li>
              <li role="menuitem" onPointerEnter={closeSubmenu} onClick={() => { setAddMenu(null); props.onAddVolume(); }}>
                Volume
              </li>
              {/* The one nested row (spec §5.5): it opens the four constraint entries
                  and never adds anything itself. All four stay enabled with no group
                  present — the reducer creates "Group 1" the way a volume creates
                  "Zone 1" (`camera_placement.md` §7). */}
              <li
                ref={constraintRowRef}
                role="menuitem"
                className={`has-submenu${submenu ? ' open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={submenu !== null}
                onPointerEnter={openSubmenu}
                onClick={(e) => {
                  e.stopPropagation();
                  openSubmenu();
                }}
              >
                Constraint
                <span className="submenu-caret" aria-hidden="true">
                  ▸
                </span>
                {submenu && (
                  <ul
                    className="menu submenu"
                    role="menu"
                    style={
                      submenu.side === 'right'
                        ? { top: submenu.top, left: submenu.left }
                        : { top: submenu.top, right: submenu.right }
                    }
                    // An entry's own handler runs first; stopping here keeps the click
                    // from bubbling to the parent row, which would re-open the submenu
                    // the entry just closed.
                    onClick={(e) => e.stopPropagation()}
                  >
                    <li role="menuitem" onClick={() => { closeMenus(); props.onAddConstraintGroup(); }}>
                      Group
                    </li>
                    <li role="menuitem" onClick={() => { closeMenus(); props.onAddConstraint('point'); }}>
                      Point
                    </li>
                    <li role="menuitem" onClick={() => { closeMenus(); props.onAddConstraint('polyline'); }}>
                      Polyline
                    </li>
                    <li role="menuitem" onClick={() => { closeMenus(); props.onAddConstraint('plane'); }}>
                      Plane
                    </li>
                  </ul>
                )}
              </li>
              {/* The one entry that opens a dialog, and the one that is not
                  always enabled: it lists what is already in the scene folder's
                  `assets/`, so it needs a folder (`gaussian_splats.md` §3.2). */}
              <li
                role="menuitem"
                className={props.addSplatBlocker ? 'disabled' : undefined}
                aria-disabled={props.addSplatBlocker ? true : undefined}
                title={props.addSplatBlocker ?? undefined}
                onPointerEnter={closeSubmenu}
                onClick={() => {
                  if (props.addSplatBlocker) return;
                  setAddMenu(null);
                  props.onAddSplat();
                }}
              >
                3D Gaussian Splat…
              </li>
            </ul>
          )}
        </div>
      </div>

      <ul className="tree" role="tree" ref={treeRef}>
        {rows.map((row) => (
          <TreeRow
            key={row.node.id}
            row={row}
            selected={row.node.id === selectedNodeId}
            dragging={drag?.nodeId === row.node.id}
            onPointerDown={onRowPointerDown}
            rateById={rateById}
            flaggedIds={props.flaggedIds}
            probeSeenCounts={props.probeSeenCounts}
            sectionCellGrids={props.sectionCellGrids}
            zoneSummaries={props.zoneSummaries}
            enabled={enabledLookup}
            sections={sections}
            volumeById={volumeById}
            constraintById={constraintById}
            splatLoadStates={props.splatLoadStates}
            onSelect={props.onSelect}
            onToggleEnabled={props.onToggleEnabled}
            onToggleCollapse={props.onToggleCollapse}
            onContextMenu={openContextMenu}
          />
        ))}
        {drag?.line && (
          // The 2px accent insertion line (§5.5.1), inset to the target row's
          // indent depth so it reads which level the row will land at.
          <li
            role="presentation"
            aria-hidden="true"
            className="tree-insertion-line"
            style={{ top: drag.line.top, left: drag.line.left }}
          />
        )}
      </ul>

      {contextMenu && (
        <ul
          className="menu context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <li
            role="menuitem"
            onClick={() => {
              const { kind, id } = contextMenu;
              setContextMenu(null);
              duplicateHandlers(props)[kind](id);
            }}
          >
            Duplicate
          </li>
          <li
            role="menuitem"
            onClick={() => {
              const { kind, id } = contextMenu;
              setContextMenu(null);
              deleteHandlers(props)[kind](id);
            }}
          >
            Delete
          </li>
        </ul>
      )}
    </div>
  );
}

interface TreeRowProps {
  row: RenderRow;
  selected: boolean;
  /** This row is the one currently being dragged — it dims in place (§5.5.1). */
  dragging: boolean;
  onPointerDown(ev: React.PointerEvent, node: SceneNode): void;
  rateById: Map<string, number>;
  /** Per-kind `enabled` lookup for the row's dimming (spec §5.4, §7.3). */
  enabled: EnabledLookup;
  flaggedIds: Set<string>;
  probeSeenCounts: Map<string, number | null>;
  sectionCellGrids: Map<string, SectionCellGrid | null>;
  zoneSummaries: Map<string, ZoneSummary> | null;
  sections: Section[];
  volumeById: Map<string, SamplingVolume>;
  constraintById: Map<string, CameraConstraint>;
  splatLoadStates: ReadonlyMap<string, SplatLoadState>;
  onSelect(selection: Selection): void;
  onToggleEnabled(kind: ToggleableKind, id: string): void;
  onToggleCollapse(nodeId: string): void;
  onContextMenu(ev: React.MouseEvent, kind: DeletableKind, id: string): void;
}

/** Generic shell: indentation, caret, selection highlight, click routing. */
function TreeRow(props: TreeRowProps) {
  const { row, selected } = props;
  const { node, depth, hasChildren, collapsed } = row;
  const isGroup = node.kind === 'group';
  // Enabled/disabled dims the row (spec §5.4, §7.3): each kind via its own
  // entity `enabled` flag, through the tree's exhaustive lookup rather than a
  // ternary chain ending in a bare `true` (`ai/CONVENTIONS.md`).
  const enabled = nodeEnabled(node, props.enabled);

  const handleClick = () => {
    // A group header only expands/collapses; every other kind selects. A zone
    // node selects (the caret handles its own expand/collapse, §4.1).
    const selection = nodeSelection(node);
    if (selection === null) props.onToggleCollapse(node.id);
    else props.onSelect(selection);
  };

  // The caret toggles expansion in place (for zones, without selecting — §4.1).
  const handleCaretClick = (ev: React.MouseEvent) => {
    if (!hasChildren) return;
    ev.stopPropagation();
    props.onToggleCollapse(node.id);
  };

  const handleContextMenu = (ev: React.MouseEvent) => {
    // The kind→id mapping is `nodeSelection`'s, not a second cascade of its own:
    // the `DeletableKind`s are exactly the selectable kinds, and an if/else
    // chain here is the very shape that once routed `constraint` into
    // `onDeleteVolume` (`ui/entityMenu.ts`, `ai/CONVENTIONS.md`). Group headers
    // select nothing and have no context menu (spec §5.5).
    const target = nodeSelection(node);
    if (target === null) return;
    props.onContextMenu(ev, target.kind, target.id);
  };

  const className = [
    'tree-row',
    isGroup ? 'group' : '',
    selected ? 'selected' : '',
    enabled ? '' : 'disabled',
    props.dragging ? 'dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isGroup ? undefined : selected}
      aria-expanded={hasChildren ? !collapsed : undefined}
      className={className}
      data-node-id={node.id}
      style={{ paddingLeft: 8 + depth * 14 }}
      onPointerDown={(ev) => props.onPointerDown(ev, node)}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {hasChildren ? (
        // A real button so expand/collapse is keyboard-reachable and labeled —
        // the row's own click selects (zones) or is the group header (§4.1).
        <button type="button" className="tree-caret" aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={handleCaretClick}>
          {collapsed ? '▸' : '▾'}
        </button>
      ) : (
        <span className="tree-caret" aria-hidden="true" />
      )}
      {node.kind === 'group' && <GroupRowContent node={node} />}
      {node.kind === 'camera' && (
        <CameraRowContent
          node={node}
          rate={props.rateById.get(node.cameraId)}
          flagged={props.flaggedIds.has(node.cameraId)}
          enabled={enabled}
          onToggleEnabled={props.onToggleEnabled}
        />
      )}
      {node.kind === 'probe' && (
        <ProbeRowContent node={node} seenCount={props.probeSeenCounts.get(node.probeId) ?? null} />
      )}
      {node.kind === 'section' && (
        <SectionRowContent
          node={node}
          section={props.sections.find((s) => s.id === node.sectionId)}
          cellGrid={props.sectionCellGrids.get(node.sectionId) ?? null}
          onToggleEnabled={props.onToggleEnabled}
        />
      )}
      {node.kind === 'zone' && (
        <ZoneRowContent
          node={node}
          summary={props.zoneSummaries?.get(node.zoneId) ?? null}
          enabled={enabled}
          onToggleEnabled={props.onToggleEnabled}
        />
      )}
      {node.kind === 'volume' && <VolumeRowContent node={node} volume={props.volumeById.get(node.volumeId)} />}
      {node.kind === 'constraintGroup' && (
        <ConstraintGroupRowContent
          node={node}
          enabled={enabled}
          onToggleEnabled={props.onToggleEnabled}
        />
      )}
      {node.kind === 'constraint' && (
        <ConstraintRowContent
          node={node}
          constraint={props.constraintById.get(node.constraintId)}
          enabled={enabled}
          onToggleEnabled={props.onToggleEnabled}
        />
      )}
      {node.kind === 'splat' && (
        <SplatRowContent
          node={node}
          enabled={enabled}
          loadState={props.splatLoadStates.get(node.splatId)}
          onToggleEnabled={props.onToggleEnabled}
        />
      )}
    </li>
  );
}

function GroupRowContent({ node }: { node: Extract<SceneNode, { kind: 'group' }> }) {
  return (
    <>
      <span className="label">{node.label}</span>
      <span className="count">{node.childIds.length}</span>
    </>
  );
}

interface CameraRowContentProps {
  node: Extract<SceneNode, { kind: 'camera' }>;
  rate: number | undefined;
  flagged: boolean;
  enabled: boolean;
  onToggleEnabled(kind: ToggleableKind, id: string): void;
}

function CameraRowContent({ node, rate, flagged, enabled, onToggleEnabled }: CameraRowContentProps) {
  return (
    <>
      <input
        type="checkbox"
        className="tree-row-toggle"
        checked={enabled}
        title={enabled ? 'Disable camera' : 'Enable camera'}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggleEnabled('camera', node.cameraId)}
      />
      <span className="dot" style={{ background: dotColor(rate, flagged) }} />
      <span className="label">{node.label}</span>
      {flagged && <span className="badge flagged">inside geometry</span>}
      {enabled && rate !== undefined && <span className="rate">{(rate * 100).toFixed(1)}%</span>}
    </>
  );
}

function ProbeRowContent({
  node,
  seenCount,
}: {
  node: Extract<SceneNode, { kind: 'probe' }>;
  seenCount: number | null;
}) {
  return (
    <>
      <span className="dot probe-dot" />
      <span className="label">{node.label}</span>
      {seenCount !== null && <span className="rate">seen {seenCount}</span>}
    </>
  );
}

function SectionRowContent({
  node,
  section,
  cellGrid,
  onToggleEnabled,
}: {
  node: Extract<SceneNode, { kind: 'section' }>;
  section: Section | undefined;
  cellGrid: SectionCellGrid | null;
  onToggleEnabled(kind: ToggleableKind, id: string): void;
}) {
  if (!section) return null;
  const badge =
    cellGrid !== null
      ? `${ORIENTATION_SHORT[section.orientation]} · ${section.aggregation} ${(averageDisplayValue(cellGrid, section.aggregation) * 100).toFixed(0)}%`
      : null;
  return (
    <>
      <input
        type="checkbox"
        className="tree-row-toggle"
        checked={section.enabled}
        title={section.enabled ? 'Disable section' : 'Enable section'}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggleEnabled('section', node.sectionId)}
      />
      <span className="dot section-dot" />
      <span className="label">{node.label}</span>
      {badge && <span className="rate">{badge}</span>}
    </>
  );
}

function ZoneRowContent({
  node,
  summary,
  enabled,
  onToggleEnabled,
}: {
  node: Extract<SceneNode, { kind: 'zone' }>;
  summary: ZoneSummary | null;
  enabled: boolean;
  onToggleEnabled(kind: ToggleableKind, id: string): void;
}) {
  return (
    <>
      <input
        type="checkbox"
        className="tree-row-toggle"
        checked={enabled}
        title={enabled ? 'Disable zone' : 'Enable zone'}
        aria-label={enabled ? 'Disable zone' : 'Enable zone'}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggleEnabled('zone', node.zoneId)}
      />
      <span className="dot zone-dot" />
      <span className="label">{node.label}</span>
      <span className="count">{node.childIds.length}</span>
      {summary && summary.validVoxels > 0 && (
        <span className="rate">overall {(summary.overallRate * 100).toFixed(0)}%</span>
      )}
    </>
  );
}

function VolumeRowContent({
  node,
  volume,
}: {
  node: Extract<SceneNode, { kind: 'volume' }>;
  volume: SamplingVolume | undefined;
}) {
  if (!volume) return null;
  const [sx, sy, sz] = volume.size;
  return (
    <>
      <span className="dot volume-dot" />
      <span className="label">{node.label}</span>
      <span className="rate">
        {sx.toFixed(1)} × {sy.toFixed(1)} × {sz.toFixed(1)} m
      </span>
    </>
  );
}

/**
 * A constraint-group row (`camera_placement.md` §7): its enabled checkbox and
 * its constraint count.
 *
 * **No search result rides along.** An earlier design appended the selected
 * camera count and that layout's reachable rate, which made sense while the tool
 * lived in the sidebar beside the visible tree. Placement is a mode now (§5):
 * the hierarchy is hidden for a session's whole life and no result outlives it,
 * so that badge could never be seen — and a rate that *did* survive would be a
 * stale aim-free upper bound (§1.3) sitting in the tree with nothing to
 * invalidate it, which is the one misreading this feature can cause.
 */
function ConstraintGroupRowContent({
  node,
  enabled,
  onToggleEnabled,
}: {
  node: Extract<SceneNode, { kind: 'constraintGroup' }>;
  enabled: boolean;
  onToggleEnabled(kind: ToggleableKind, id: string): void;
}) {
  return (
    <>
      <input
        type="checkbox"
        className="tree-row-toggle"
        checked={enabled}
        title={enabled ? 'Disable group' : 'Enable group'}
        aria-label={enabled ? 'Disable group' : 'Enable group'}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggleEnabled('constraintGroup', node.groupId)}
      />
      <span className="dot constraint-dot" />
      <span className="label">{node.label}</span>
      <span className="count">{node.childIds.length}</span>
    </>
  );
}

/**
 * A constraint row (`camera_placement.md` §7): its enabled checkbox, its kind,
 * and its primitive measure — the weight its share of the pool is drawn by
 * (§4.1), so the row explains why one constraint gets more samples than another.
 */
function ConstraintRowContent({
  node,
  constraint,
  enabled,
  onToggleEnabled,
}: {
  node: Extract<SceneNode, { kind: 'constraint' }>;
  constraint: CameraConstraint | undefined;
  enabled: boolean;
  onToggleEnabled(kind: ToggleableKind, id: string): void;
}) {
  if (!constraint) return null;
  const measure = primitiveMeasure(constraint);
  const detail =
    constraint.kind === 'point'
      ? 'point'
      : constraint.kind === 'polyline'
        ? `polyline · ${measure.toFixed(1)} m`
        : `plane · ${measure.toFixed(0)} m²`;
  return (
    <>
      <input
        type="checkbox"
        className="tree-row-toggle"
        checked={enabled}
        title={enabled ? 'Disable constraint' : 'Enable constraint'}
        aria-label={enabled ? 'Disable constraint' : 'Enable constraint'}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggleEnabled('constraint', node.constraintId)}
      />
      <span className="dot constraint-dot" />
      <span className="label">{node.label}</span>
      <span className="rate">{detail}</span>
    </>
  );
}

/**
 * A splat row (`gaussian_splats.md` §6.2): its enabled checkbox and a badge
 * reflecting **load state** — progress while reading, the splat count once
 * decoded, or the reason it is not on screen.
 *
 * The badge is the only place a capture's loading is surfaced, and nothing in
 * the app blocks on it. `loaded` means *decoded*: Spark's sort runs in a worker,
 * so the capture appears a few frames later, and there is deliberately no state
 * between the two (§4.4).
 */
function SplatRowContent({
  node,
  enabled,
  loadState,
  onToggleEnabled,
}: {
  node: Extract<SceneNode, { kind: 'splat' }>;
  enabled: boolean;
  loadState: SplatLoadState | undefined;
  onToggleEnabled(kind: ToggleableKind, id: string): void;
}) {
  const badge = splatBadge(loadState);
  const failed = loadState?.status === 'error';
  return (
    <>
      <input
        type="checkbox"
        className="tree-row-toggle"
        checked={enabled}
        title={enabled ? 'Hide capture' : 'Show capture'}
        aria-label={enabled ? 'Hide capture' : 'Show capture'}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggleEnabled('splat', node.splatId)}
      />
      <span className="dot splat-dot" />
      <span className="label">{node.label}</span>
      {badge && <span className={failed ? 'rate splat-error' : 'rate'}>{badge}</span>}
    </>
  );
}
