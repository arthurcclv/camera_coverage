/**
 * App-level scene hierarchy model (spec §5.5).
 *
 * A generic tree that today holds only cameras but is structured so future
 * entity types (lights, meshes, …) slot in as new `SceneNode` variants and
 * sibling groups. Nodes carry hierarchy + identity only; camera payload stays
 * in the canonical `CameraConfig[]` (§5), referenced by `cameraId`. The tree is
 * derived from that array — there is no separate mutable node state.
 */
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';

export type SceneNode =
  | { kind: 'group'; id: string; label: string; childIds: string[] }
  | { kind: 'camera'; id: string; label: string; cameraId: string };

const CAMERA_GROUP_ID = 'group:cameras';
const CAMERA_NODE_PREFIX = 'cam:';

/** Stable tree-node id for a camera (namespaced to avoid collisions). */
export function nodeIdForCamera(cameraId: string): string {
  return `${CAMERA_NODE_PREFIX}${cameraId}`;
}

/** Inverse of {@link nodeIdForCamera}; null if the node id isn't a camera. */
export function cameraIdForNode(nodeId: string): string | null {
  return nodeId.startsWith(CAMERA_NODE_PREFIX)
    ? nodeId.slice(CAMERA_NODE_PREFIX.length)
    : null;
}

/**
 * Build the scene tree for the given cameras: a single "Cameras" group whose
 * children are one camera node per config, in array order. Returned flat with
 * the group first; children are reachable via `group.childIds`.
 */
export function buildSceneTree(cameras: CameraConfig[]): SceneNode[] {
  const cameraNodes: SceneNode[] = cameras.map((c) => ({
    kind: 'camera',
    id: nodeIdForCamera(c.id),
    label: c.id,
    cameraId: c.id,
  }));
  const group: SceneNode = {
    kind: 'group',
    id: CAMERA_GROUP_ID,
    label: 'Cameras',
    childIds: cameraNodes.map((n) => n.id),
  };
  return [group, ...cameraNodes];
}

export interface RenderRow {
  node: SceneNode;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

/**
 * Depth-first flatten into the visible, ordered rows to render. Roots are nodes
 * not referenced as any group's child; a collapsed group hides its descendants.
 * Order is preserved (root order, then `childIds` order).
 */
export function flattenVisible(nodes: SceneNode[], collapsedIds: Set<string>): RenderRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childIds = new Set<string>();
  for (const n of nodes) {
    if (n.kind === 'group') for (const c of n.childIds) childIds.add(c);
  }
  const rootIds = nodes.filter((n) => !childIds.has(n.id)).map((n) => n.id);

  const rows: RenderRow[] = [];
  const visit = (id: string, depth: number) => {
    const node = byId.get(id);
    if (!node) return;
    const hasChildren = node.kind === 'group' && node.childIds.length > 0;
    const collapsed = collapsedIds.has(id);
    rows.push({ node, depth, hasChildren, collapsed });
    if (node.kind === 'group' && !collapsed) {
      for (const childId of node.childIds) visit(childId, depth + 1);
    }
  };
  for (const id of rootIds) visit(id, 0);
  return rows;
}
