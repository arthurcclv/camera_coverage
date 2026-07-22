/**
 * Scene hierarchy view (spec §5.5; `sampling_volumes.md` §4). A generic tree — a
 * `TreeRow` shell plus per-`node.kind` content — rendering a "Cameras" group over
 * camera nodes and, when any exist, sibling "Probes"/"Sections" groups and a
 * "Zones" umbrella over selectable+expandable zone nodes (each holding its volume
 * children). Kind-specific chrome lives in the per-kind row-content components;
 * adding a future entity type means adding a node variant + its row-content
 * component, not touching the shell.
 *
 * The panel header carries the "+" add-entity menu; right-clicking a camera,
 * probe, section, zone, or volume row opens a Duplicate/Delete context menu.
 */
import { useEffect, useMemo, useState } from 'react';

import type { SceneCamera } from '../cameras/camera.ts';
import type { Probe } from '../scene/probeVisibility.ts';
import { averageDisplayValue, type Section, type SectionCellGrid } from '../scene/sectionHeatmap.ts';
import type { SamplingVolume, Zone, ZoneSummary } from '../scene/samplingVolumes.ts';
import type { Selection } from '../scene/viewportSelection.ts';
import {
  buildSceneTree,
  flattenVisible,
  nodeIdForCamera,
  nodeIdForProbe,
  nodeIdForSection,
  nodeIdForVolume,
  nodeIdForZone,
  type RenderRow,
  type SceneNode,
} from '../scene/sceneTree.ts';

export interface SceneHierarchyProps {
  cameras: SceneCamera[];
  probes: Probe[];
  sections: Section[];
  zones: Zone[];
  volumes: SamplingVolume[];
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
  onToggleEnabled(kind: 'camera' | 'section' | 'zone', id: string): void;
  onToggleCollapse(nodeId: string): void;
  onAddCamera(): void;
  onAddProbe(): void;
  onAddSection(): void;
  onAddZone(): void;
  onAddVolume(): void;
  onDeleteCamera(id: string): void;
  onDeleteProbe(id: string): void;
  onDeleteSection(id: string): void;
  onDeleteZone(id: string): void;
  onDeleteVolume(id: string): void;
  onDuplicateCamera(id: string): void;
  onDuplicateProbe(id: string): void;
  onDuplicateSection(id: string): void;
  onDuplicateZone(id: string): void;
  onDuplicateVolume(id: string): void;
}

type DeletableKind = 'camera' | 'probe' | 'section' | 'zone' | 'volume';

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

function dotColor(rate: number | undefined, flagged: boolean): string {
  if (flagged) return '#ff7d7d';
  if (rate === undefined) return '#5da9e0';
  const t = Math.max(0, Math.min(1, rate));
  const hue = (t * 120) / 360;
  return `hsl(${hue * 360}, 85%, 55%)`;
}

export function SceneHierarchy(props: SceneHierarchyProps) {
  const { cameras, probes, sections, zones, volumes, selection, collapsedIds } = props;
  const nodes = useMemo(
    () => buildSceneTree(cameras, probes, sections, zones, volumes),
    [cameras, probes, sections, zones, volumes],
  );
  const rows = useMemo(() => flattenVisible(nodes, collapsedIds), [nodes, collapsedIds]);
  const rateById = useMemo(
    () => new Map(props.perCamera?.map((p) => [p.id, p.coverageRate])),
    [props.perCamera],
  );
  const volumeById = useMemo(() => new Map(volumes.map((v) => [v.id, v])), [volumes]);

  const selectedNodeId =
    selection?.kind === 'camera'
      ? nodeIdForCamera(selection.id)
      : selection?.kind === 'probe'
        ? nodeIdForProbe(selection.id)
        : selection?.kind === 'section'
          ? nodeIdForSection(selection.id)
          : selection?.kind === 'zone'
            ? nodeIdForZone(selection.id)
            : selection?.kind === 'volume'
              ? nodeIdForVolume(selection.id)
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

  const openContextMenu = (ev: React.MouseEvent, kind: DeletableKind, id: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    setAddMenuOpen(false);
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
              <li role="menuitem" onClick={() => { setAddMenuOpen(false); props.onAddZone(); }}>
                Zone
              </li>
              <li role="menuitem" onClick={() => { setAddMenuOpen(false); props.onAddVolume(); }}>
                Volume
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
            probeSeenCounts={props.probeSeenCounts}
            sectionCellGrids={props.sectionCellGrids}
            zoneSummaries={props.zoneSummaries}
            cameras={cameras}
            sections={sections}
            zones={zones}
            volumeById={volumeById}
            onSelect={props.onSelect}
            onToggleEnabled={props.onToggleEnabled}
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
              if (kind === 'camera') props.onDuplicateCamera(id);
              else if (kind === 'probe') props.onDuplicateProbe(id);
              else if (kind === 'section') props.onDuplicateSection(id);
              else if (kind === 'zone') props.onDuplicateZone(id);
              else props.onDuplicateVolume(id);
            }}
          >
            Duplicate
          </li>
          <li
            role="menuitem"
            onClick={() => {
              const { kind, id } = contextMenu;
              setContextMenu(null);
              if (kind === 'camera') props.onDeleteCamera(id);
              else if (kind === 'probe') props.onDeleteProbe(id);
              else if (kind === 'section') props.onDeleteSection(id);
              else if (kind === 'zone') props.onDeleteZone(id);
              else props.onDeleteVolume(id);
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
  probeSeenCounts: Map<string, number | null>;
  sectionCellGrids: Map<string, SectionCellGrid | null>;
  zoneSummaries: Map<string, ZoneSummary> | null;
  cameras: SceneCamera[];
  sections: Section[];
  zones: Zone[];
  volumeById: Map<string, SamplingVolume>;
  onSelect(selection: Selection): void;
  onToggleEnabled(kind: 'camera' | 'section' | 'zone', id: string): void;
  onToggleCollapse(nodeId: string): void;
  onContextMenu(ev: React.MouseEvent, kind: DeletableKind, id: string): void;
}

/** Generic shell: indentation, caret, selection highlight, click routing. */
function TreeRow(props: TreeRowProps) {
  const { row, selected } = props;
  const { node, depth, hasChildren, collapsed } = row;
  const isGroup = node.kind === 'group';
  // Enabled/disabled dims the row (spec §5.4, §7.3): cameras/sections/zones each
  // via their own entity `enabled` flag.
  const enabled =
    node.kind === 'camera'
      ? props.cameras.find((c) => c.id === node.cameraId)?.enabled ?? true
      : node.kind === 'section'
        ? props.sections.find((s) => s.id === node.sectionId)?.enabled ?? true
        : node.kind === 'zone'
          ? props.zones.find((z) => z.id === node.zoneId)?.enabled ?? true
          : true;

  const handleClick = () => {
    // A group header only expands/collapses; every other kind selects. A zone
    // node selects (the caret handles its own expand/collapse, §4.1).
    if (node.kind === 'group') props.onToggleCollapse(node.id);
    else if (node.kind === 'camera') props.onSelect({ kind: 'camera', id: node.cameraId });
    else if (node.kind === 'probe') props.onSelect({ kind: 'probe', id: node.probeId });
    else if (node.kind === 'section') props.onSelect({ kind: 'section', id: node.sectionId });
    else if (node.kind === 'zone') props.onSelect({ kind: 'zone', id: node.zoneId });
    else props.onSelect({ kind: 'volume', id: node.volumeId });
  };

  // The caret toggles expansion in place (for zones, without selecting — §4.1).
  const handleCaretClick = (ev: React.MouseEvent) => {
    if (!hasChildren) return;
    ev.stopPropagation();
    props.onToggleCollapse(node.id);
  };

  const handleContextMenu = (ev: React.MouseEvent) => {
    if (node.kind === 'camera') props.onContextMenu(ev, 'camera', node.cameraId);
    else if (node.kind === 'probe') props.onContextMenu(ev, 'probe', node.probeId);
    else if (node.kind === 'section') props.onContextMenu(ev, 'section', node.sectionId);
    else if (node.kind === 'zone') props.onContextMenu(ev, 'zone', node.zoneId);
    else if (node.kind === 'volume') props.onContextMenu(ev, 'volume', node.volumeId);
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
  onToggleEnabled(kind: 'camera' | 'section' | 'zone', id: string): void;
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
  onToggleEnabled,
}: {
  node: Extract<SceneNode, { kind: 'section' }>;
  section: Section | undefined;
  cellGrid: SectionCellGrid | null;
  onToggleEnabled(kind: 'camera' | 'section' | 'zone', id: string): void;
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
  onToggleEnabled(kind: 'camera' | 'section' | 'zone', id: string): void;
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
