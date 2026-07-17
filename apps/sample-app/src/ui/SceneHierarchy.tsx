/**
 * Scene hierarchy view (spec §5.5). A generic tree — a `TreeRow` shell plus
 * per-`node.kind` content — that currently renders a "Cameras" group over the
 * camera nodes. Camera-only chrome (enable toggle, coverage dot, rate/flag
 * badges) lives in `CameraRowContent`; adding a future entity type means adding
 * a node variant + its own row-content component, not touching the shell.
 */
import { useMemo } from 'react';
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';

import {
  buildSceneTree,
  cameraIdForNode,
  flattenVisible,
  nodeIdForCamera,
  type RenderRow,
  type SceneNode,
} from '../scene/sceneTree.ts';

export interface SceneHierarchyProps {
  cameras: CameraConfig[];
  /** Currently selected camera id (§5.2); drives the highlighted camera node. */
  selectedId: string | null;
  flaggedIds: Set<string>;
  disabledIds: Set<string>;
  perCamera: { id: string; coverageRate: number }[] | null;
  /** Ids of collapsed group nodes (ephemeral UI state, §5.5). */
  collapsedIds: Set<string>;
  onSelectCamera(id: string): void;
  onToggleEnabled(id: string): void;
  onToggleCollapse(nodeId: string): void;
}

function dotColor(rate: number | undefined, flagged: boolean): string {
  if (flagged) return '#ff7d7d';
  if (rate === undefined) return '#5da9e0';
  const t = Math.max(0, Math.min(1, rate));
  const hue = (t * 120) / 360;
  return `hsl(${hue * 360}, 85%, 55%)`;
}

export function SceneHierarchy(props: SceneHierarchyProps) {
  const { cameras, selectedId, collapsedIds } = props;
  const nodes = useMemo(() => buildSceneTree(cameras), [cameras]);
  const rows = useMemo(() => flattenVisible(nodes, collapsedIds), [nodes, collapsedIds]);
  const rateById = useMemo(
    () => new Map(props.perCamera?.map((p) => [p.id, p.coverageRate])),
    [props.perCamera],
  );
  const selectedNodeId = selectedId ? nodeIdForCamera(selectedId) : null;

  return (
    <ul className="tree" role="tree">
      {rows.map((row) => (
        <TreeRow
          key={row.node.id}
          row={row}
          selected={row.node.id === selectedNodeId}
          rateById={rateById}
          flaggedIds={props.flaggedIds}
          disabledIds={props.disabledIds}
          onSelectCamera={props.onSelectCamera}
          onToggleEnabled={props.onToggleEnabled}
          onToggleCollapse={props.onToggleCollapse}
        />
      ))}
    </ul>
  );
}

interface TreeRowProps {
  row: RenderRow;
  selected: boolean;
  rateById: Map<string, number>;
  flaggedIds: Set<string>;
  disabledIds: Set<string>;
  onSelectCamera(id: string): void;
  onToggleEnabled(id: string): void;
  onToggleCollapse(nodeId: string): void;
}

/** Generic shell: indentation, caret, selection highlight, click routing. */
function TreeRow(props: TreeRowProps) {
  const { row, selected } = props;
  const { node, depth, hasChildren, collapsed } = row;
  const isGroup = node.kind === 'group';
  const enabled = node.kind === 'camera' ? !props.disabledIds.has(node.cameraId) : true;

  const handleClick = () => {
    if (node.kind === 'group') props.onToggleCollapse(node.id);
    else props.onSelectCamera(node.cameraId);
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
