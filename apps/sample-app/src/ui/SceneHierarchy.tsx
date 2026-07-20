/**
 * Scene hierarchy view (spec §5.5). A generic tree — a `TreeRow` shell plus
 * per-`node.kind` content — rendering a "Cameras" group over camera nodes and,
 * when any probes/sections exist, sibling "Probes"/"Sections" groups. Kind-
 * specific chrome (camera enable toggle / coverage badges; probe "seen by K"
 * badge; section visibility checkbox + orientation/coverage badge) lives in the
 * per-kind row-content components; adding a future entity type means adding a
 * node variant + its own row-content component, not touching the shell.
 *
 * The panel header carries the "+" add-entity menu; right-clicking a camera,
 * probe, or section row opens a Delete context menu.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';

import type { Probe } from '../scene/probeVisibility.ts';
import { averageDisplayValue, type Section, type SectionCellGrid } from '../scene/sectionHeatmap.ts';
import type { Selection } from '../scene/viewportSelection.ts';
import {
  buildSceneTree,
  flattenVisible,
  nodeIdForCamera,
  nodeIdForProbe,
  nodeIdForSection,
  type RenderRow,
  type SceneNode,
} from '../scene/sceneTree.ts';

export interface SceneHierarchyProps {
  cameras: CameraConfig[];
  probes: Probe[];
  sections: Section[];
  /** Unified selection (spec §5.5); drives the highlighted node. */
  selection: Selection;
  flaggedIds: Set<string>;
  disabledIds: Set<string>;
  perCamera: { id: string; coverageRate: number }[] | null;
  /** Per-probe enabled-cameras-that-see count, or null when no usable mask (§5.5). */
  probeSeenCounts: Map<string, number | null>;
  /** Per-section current cell grid, or null when no usable run (§13.4). */
  sectionCellGrids: Map<string, SectionCellGrid | null>;
  /** Ids of collapsed group nodes (ephemeral UI state, §5.5). */
  collapsedIds: Set<string>;
  onSelect(selection: Selection): void;
  onToggleEnabled(id: string): void;
  onToggleSectionVisible(id: string): void;
  onToggleCollapse(nodeId: string): void;
  onAddCamera(): void;
  onAddProbe(): void;
  onAddSection(): void;
  onDeleteCamera(id: string): void;
  onDeleteProbe(id: string): void;
  onDeleteSection(id: string): void;
}

interface ContextMenuState {
  x: number;
  y: number;
  kind: 'camera' | 'probe' | 'section';
  id: string;
}

const ORIENTATION_SHORT: Record<Section['orientation'], string> = {
  horizontal: 'H',
  'vertical-x': 'VX',
  'vertical-z': 'VZ',
};

function dotColor(rate: number | undefined, flagged: boolean): string {
  if (flagged) return '#ff7d7d';
  if (rate === undefined) return '#5da9e0';
  const t = Math.max(0, Math.min(1, rate));
  const hue = (t * 120) / 360;
  return `hsl(${hue * 360}, 85%, 55%)`;
}

export function SceneHierarchy(props: SceneHierarchyProps) {
  const { cameras, probes, sections, selection, collapsedIds } = props;
  const nodes = useMemo(() => buildSceneTree(cameras, probes, sections), [cameras, probes, sections]);
  const rows = useMemo(() => flattenVisible(nodes, collapsedIds), [nodes, collapsedIds]);
  const rateById = useMemo(
    () => new Map(props.perCamera?.map((p) => [p.id, p.coverageRate])),
    [props.perCamera],
  );

  const selectedNodeId =
    selection?.kind === 'camera'
      ? nodeIdForCamera(selection.id)
      : selection?.kind === 'probe'
        ? nodeIdForProbe(selection.id)
        : selection?.kind === 'section'
          ? nodeIdForSection(selection.id)
          : null;

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Close either popover on any outside interaction (spec §5.5 menus are transient).
  useEffect(() => {
    if (!addMenuOpen && !contextMenu) return;
    const close = () => {
      setAddMenuOpen(false);
      setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [addMenuOpen, contextMenu]);

  const openContextMenu = (ev: React.MouseEvent, kind: 'camera' | 'probe' | 'section', id: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    setAddMenuOpen(false);
    setContextMenu({ x: ev.clientX, y: ev.clientY, kind, id });
  };

  return (
    <div className="scene-hierarchy">
      <div className="panel-title scene-header">
        <span>Scene</span>
        <div className="add-menu-anchor">
          <button
            type="button"
            className="btn secondary icon-btn add-btn"
            title="Add entity"
            aria-label="Add entity"
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setAddMenuOpen((o) => !o);
              setContextMenu(null);
            }}
          >
            +
          </button>
          {addMenuOpen && (
            <ul className="menu" role="menu">
              <li role="menuitem" onClick={() => { setAddMenuOpen(false); props.onAddCamera(); }}>
                Camera
              </li>
              <li role="menuitem" onClick={() => { setAddMenuOpen(false); props.onAddProbe(); }}>
                Probe
              </li>
              <li role="menuitem" onClick={() => { setAddMenuOpen(false); props.onAddSection(); }}>
                Section
              </li>
            </ul>
          )}
        </div>
      </div>

      <ul className="tree" role="tree">
        {rows.map((row) => (
          <TreeRow
            key={row.node.id}
            row={row}
            selected={row.node.id === selectedNodeId}
            rateById={rateById}
            flaggedIds={props.flaggedIds}
            disabledIds={props.disabledIds}
            probeSeenCounts={props.probeSeenCounts}
            sectionCellGrids={props.sectionCellGrids}
            sections={sections}
            onSelect={props.onSelect}
            onToggleEnabled={props.onToggleEnabled}
            onToggleSectionVisible={props.onToggleSectionVisible}
            onToggleCollapse={props.onToggleCollapse}
            onContextMenu={openContextMenu}
          />
        ))}
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
              if (kind === 'camera') props.onDeleteCamera(id);
              else if (kind === 'probe') props.onDeleteProbe(id);
              else props.onDeleteSection(id);
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
  rateById: Map<string, number>;
  flaggedIds: Set<string>;
  disabledIds: Set<string>;
  probeSeenCounts: Map<string, number | null>;
  sectionCellGrids: Map<string, SectionCellGrid | null>;
  sections: Section[];
  onSelect(selection: Selection): void;
  onToggleEnabled(id: string): void;
  onToggleSectionVisible(id: string): void;
  onToggleCollapse(nodeId: string): void;
  onContextMenu(ev: React.MouseEvent, kind: 'camera' | 'probe' | 'section', id: string): void;
}

/** Generic shell: indentation, caret, selection highlight, click routing. */
function TreeRow(props: TreeRowProps) {
  const { row, selected } = props;
  const { node, depth, hasChildren, collapsed } = row;
  const isGroup = node.kind === 'group';
  const enabled = node.kind === 'camera' ? !props.disabledIds.has(node.cameraId) : true;

  const handleClick = () => {
    if (node.kind === 'group') props.onToggleCollapse(node.id);
    else if (node.kind === 'camera') props.onSelect({ kind: 'camera', id: node.cameraId });
    else if (node.kind === 'probe') props.onSelect({ kind: 'probe', id: node.probeId });
    else props.onSelect({ kind: 'section', id: node.sectionId });
  };

  const handleContextMenu = (ev: React.MouseEvent) => {
    if (node.kind === 'camera') props.onContextMenu(ev, 'camera', node.cameraId);
    else if (node.kind === 'probe') props.onContextMenu(ev, 'probe', node.probeId);
    else if (node.kind === 'section') props.onContextMenu(ev, 'section', node.sectionId);
    // Group headers have no context menu (spec §5.5).
  };

  const className = [
    'tree-row',
    isGroup ? 'group' : '',
    selected ? 'selected' : '',
    enabled ? '' : 'disabled',
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
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <span className="tree-caret" aria-hidden="true">
        {hasChildren ? (collapsed ? '▸' : '▾') : ''}
      </span>
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
          onToggleVisible={props.onToggleSectionVisible}
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
  onToggleEnabled(id: string): void;
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
        onChange={() => onToggleEnabled(node.cameraId)}
      />
      <span className="dot" style={{ background: dotColor(rate, flagged) }} />
      <span className="label">{node.label}</span>
      {flagged && <span className="badge flagged">inside geometry</span>}
      {enabled && rate !== undefined && <span className="rate">{(rate * 100).toFixed(0)}%</span>}
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
  onToggleVisible,
}: {
  node: Extract<SceneNode, { kind: 'section' }>;
  section: Section | undefined;
  cellGrid: SectionCellGrid | null;
  onToggleVisible(id: string): void;
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
        checked={section.visible}
        title={section.visible ? 'Hide section' : 'Show section'}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggleVisible(node.sectionId)}
      />
      <span className="dot section-dot" />
      <span className="label">{node.label}</span>
      {badge && <span className="rate">{badge}</span>}
    </>
  );
}
