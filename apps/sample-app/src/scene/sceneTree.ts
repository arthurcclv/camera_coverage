/**
 * App-level scene hierarchy model (spec §5.5).
 *
 * A generic tree that holds cameras (§5) and probes (§12), structured so future
 * entity types (lights, meshes, …) slot in as new `SceneNode` variants and
 * sibling groups. Nodes carry hierarchy + identity only; entity payload stays in
 * the canonical arrays — cameras in `CameraConfig[]`, probes in `Probe[]` — which
 * a node references by id. The tree is derived from those arrays via
 * `buildSceneTree` — there is no separate mutable node state.
 */
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';
import type { Probe } from './probeVisibility.ts';

export type SceneNode =
  | { kind: 'group'; id: string; label: string; childIds: string[] }
  | { kind: 'camera'; id: string; label: string; cameraId: string }
  | { kind: 'probe'; id: string; label: string; probeId: string };

const CAMERA_GROUP_ID = 'group:cameras';
const PROBE_GROUP_ID = 'group:probes';
const CAMERA_NODE_PREFIX = 'cam:';
const PROBE_NODE_PREFIX = 'probe:';

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

/** Stable tree-node id for a probe (namespaced to avoid collisions). */
export function nodeIdForProbe(probeId: string): string {
  return `${PROBE_NODE_PREFIX}${probeId}`;
}

/** Inverse of {@link nodeIdForProbe}; null if the node id isn't a probe. */
export function probeIdForNode(nodeId: string): string | null {
  return nodeId.startsWith(PROBE_NODE_PREFIX)
    ? nodeId.slice(PROBE_NODE_PREFIX.length)
    : null;
}

/**
 * Build the scene tree: a "Cameras" group over one node per camera, and — when
 * any probes exist — a sibling "Probes" group over one node per probe, each in
 * array order. Returned flat, groups before their children; children are reachable
 * via `group.childIds`.
 */
export function buildSceneTree(cameras: CameraConfig[], probes: Probe[] = []): SceneNode[] {
  const cameraNodes: SceneNode[] = cameras.map((c) => ({
    kind: 'camera',
    id: nodeIdForCamera(c.id),
    label: c.id,
    cameraId: c.id,
  }));
  const cameraGroup: SceneNode = {
    kind: 'group',
    id: CAMERA_GROUP_ID,
    label: 'Cameras',
    childIds: cameraNodes.map((n) => n.id),
  };

  const nodes: SceneNode[] = [cameraGroup, ...cameraNodes];

  if (probes.length > 0) {
    const probeNodes: SceneNode[] = probes.map((p) => ({
      kind: 'probe',
      id: nodeIdForProbe(p.id),
      label: p.id,
      probeId: p.id,
    }));
    const probeGroup: SceneNode = {
      kind: 'group',
      id: PROBE_GROUP_ID,
      label: 'Probes',
      childIds: probeNodes.map((n) => n.id),
    };
    nodes.push(probeGroup, ...probeNodes);
  }

  return nodes;
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
