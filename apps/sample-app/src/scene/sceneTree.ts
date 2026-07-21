/**
 * App-level scene hierarchy model (spec §5.5).
 *
 * A generic tree that holds cameras (§5), probes (§12), sections (§13), and
 * sampling zones/volumes (`sampling_volumes.md` §4), structured so future entity
 * types (lights, meshes, …) slot in as new `SceneNode` variants and sibling
 * groups. Nodes carry hierarchy + identity only; entity payload stays in the
 * canonical arrays — cameras in `CameraConfig[]`, probes in `Probe[]`, sections
 * in `Section[]`, zones in `Zone[]`, volumes in `SamplingVolume[]` — which a node
 * references by id. The tree is derived from those arrays via `buildSceneTree` —
 * there is no separate mutable node state.
 *
 * Zones introduce the first **user-created, selectable sub-groups**: a zone node
 * is both selectable (drives the ZonePanel) and expandable (its
 * volume children), unlike today's passive type-group umbrellas.
 */
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';
import type { Probe } from './probeVisibility.ts';
import type { Section } from './sectionHeatmap.ts';
import { zoneLabel, type SamplingVolume, type Zone } from './samplingVolumes.ts';

export type SceneNode =
  | { kind: 'group'; id: string; label: string; childIds: string[] }
  | { kind: 'camera'; id: string; label: string; cameraId: string }
  | { kind: 'probe'; id: string; label: string; probeId: string }
  | { kind: 'section'; id: string; label: string; sectionId: string }
  | { kind: 'zone'; id: string; label: string; zoneId: string; childIds: string[] }
  | { kind: 'volume'; id: string; label: string; volumeId: string };

const CAMERA_GROUP_ID = 'group:cameras';
const PROBE_GROUP_ID = 'group:probes';
const SECTION_GROUP_ID = 'group:sections';
const ZONES_GROUP_ID = 'group:zones';
const CAMERA_NODE_PREFIX = 'cam:';
const PROBE_NODE_PREFIX = 'probe:';
const SECTION_NODE_PREFIX = 'section:';
const ZONE_NODE_PREFIX = 'zone:';
const VOLUME_NODE_PREFIX = 'volume:';

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

/** Stable tree-node id for a section (namespaced to avoid collisions). */
export function nodeIdForSection(sectionId: string): string {
  return `${SECTION_NODE_PREFIX}${sectionId}`;
}

/** Inverse of {@link nodeIdForSection}; null if the node id isn't a section. */
export function sectionIdForNode(nodeId: string): string | null {
  return nodeId.startsWith(SECTION_NODE_PREFIX)
    ? nodeId.slice(SECTION_NODE_PREFIX.length)
    : null;
}

/** Stable tree-node id for a zone (namespaced to avoid collisions). */
export function nodeIdForZone(zoneId: string): string {
  return `${ZONE_NODE_PREFIX}${zoneId}`;
}

/** Inverse of {@link nodeIdForZone}; null if the node id isn't a zone. */
export function zoneIdForNode(nodeId: string): string | null {
  return nodeId.startsWith(ZONE_NODE_PREFIX)
    ? nodeId.slice(ZONE_NODE_PREFIX.length)
    : null;
}

/** Stable tree-node id for a volume (namespaced to avoid collisions). */
export function nodeIdForVolume(volumeId: string): string {
  return `${VOLUME_NODE_PREFIX}${volumeId}`;
}

/** Inverse of {@link nodeIdForVolume}; null if the node id isn't a volume. */
export function volumeIdForNode(nodeId: string): string | null {
  return nodeId.startsWith(VOLUME_NODE_PREFIX)
    ? nodeId.slice(VOLUME_NODE_PREFIX.length)
    : null;
}

/** A node's child ids (groups and zones have children; other kinds don't). */
function childIdsOf(node: SceneNode): string[] {
  return node.kind === 'group' || node.kind === 'zone' ? node.childIds : [];
}

/**
 * Build the scene tree: a "Cameras" group over one node per camera, and — when
 * any exist — sibling "Probes" / "Sections" groups, and a "Zones" umbrella over
 * selectable+expandable zone nodes (each holding its volume children). All in
 * array order. Returned flat, parents before their children; children are
 * reachable via `childIds`.
 */
export function buildSceneTree(
  cameras: CameraConfig[],
  probes: Probe[] = [],
  sections: Section[] = [],
  zones: Zone[] = [],
  volumes: SamplingVolume[] = [],
): SceneNode[] {
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

  if (sections.length > 0) {
    const sectionNodes: SceneNode[] = sections.map((s) => ({
      kind: 'section',
      id: nodeIdForSection(s.id),
      label: s.id,
      sectionId: s.id,
    }));
    const sectionGroup: SceneNode = {
      kind: 'group',
      id: SECTION_GROUP_ID,
      label: 'Sections',
      childIds: sectionNodes.map((n) => n.id),
    };
    nodes.push(sectionGroup, ...sectionNodes);
  }

  // The Zones umbrella + zone subtrees appear once any zone exists — including an
  // empty, freshly-added zone with no volumes yet (`sampling_volumes.md` §4.1).
  // Each zone node carries its volume children; volume nodes follow their zone in
  // array order.
  if (zones.length > 0) {
    const zoneNodes: SceneNode[] = [];
    const volumeNodes: SceneNode[] = [];
    for (const z of zones) {
      const zoneVolumeNodes: SceneNode[] = volumes
        .filter((v) => v.zoneId === z.id)
        .map((v) => ({ kind: 'volume', id: nodeIdForVolume(v.id), label: v.id, volumeId: v.id }));
      zoneNodes.push({
        kind: 'zone',
        id: nodeIdForZone(z.id),
        label: zoneLabel(z),
        zoneId: z.id,
        childIds: zoneVolumeNodes.map((n) => n.id),
      });
      volumeNodes.push(...zoneVolumeNodes);
    }
    const zonesGroup: SceneNode = {
      kind: 'group',
      id: ZONES_GROUP_ID,
      label: 'Zones',
      childIds: zoneNodes.map((n) => n.id),
    };
    // Flat, parent-before-children: umbrella, then each zone immediately
    // followed by its own volumes (via `childIds`, resolved by `flattenVisible`).
    nodes.push(zonesGroup, ...zoneNodes, ...volumeNodes);
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
 * not referenced as any parent's child; a collapsed parent hides its descendants.
 * "Has children" is any node with a non-empty `childIds` (groups *and* zones), so
 * zone nodes expand/collapse too. Order is preserved (root order, then `childIds`
 * order).
 */
export function flattenVisible(nodes: SceneNode[], collapsedIds: Set<string>): RenderRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childIds = new Set<string>();
  for (const n of nodes) for (const c of childIdsOf(n)) childIds.add(c);
  const rootIds = nodes.filter((n) => !childIds.has(n.id)).map((n) => n.id);

  const rows: RenderRow[] = [];
  const visit = (id: string, depth: number) => {
    const node = byId.get(id);
    if (!node) return;
    const children = childIdsOf(node);
    const hasChildren = children.length > 0;
    const collapsed = collapsedIds.has(id);
    rows.push({ node, depth, hasChildren, collapsed });
    if (hasChildren && !collapsed) {
      for (const childId of children) visit(childId, depth + 1);
    }
  };
  for (const id of rootIds) visit(id, 0);
  return rows;
}
