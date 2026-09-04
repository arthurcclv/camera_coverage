/**
 * App-level scene hierarchy model (spec §5.5).
 *
 * A generic tree that holds cameras (§5), probes (§12), sections (§13),
 * sampling zones/volumes (`sampling_volumes.md` §4), and camera-constraint
 * groups/constraints (`camera_placement.md` §7), structured so future entity
 * types (lights, meshes, …) slot in as new `SceneNode` variants and sibling
 * groups. Nodes carry hierarchy + identity only; entity payload stays in the
 * canonical arrays — cameras in `CameraConfig[]`, probes in `Probe[]`, sections
 * in `Section[]`, zones in `Zone[]`, volumes in `SamplingVolume[]` — which a node
 * references by id (cameras in `SceneCamera[]`). The tree is derived from those
 * arrays via `buildSceneTree` — there is no separate mutable node state. Row labels
 * resolve to each entity's display name (`cameraLabel`/`probeLabel`/`sectionLabel`/
 * `zoneLabel`, spec §5.6); volume rows are the one exception and show the raw id.
 *
 * Zones introduce the first **user-created, selectable sub-groups**: a zone node
 * is both selectable (drives the ZonePanel) and expandable (its
 * volume children), unlike today's passive type-group umbrellas.
 */
import { cameraLabel, type SceneCamera } from '../cameras/camera.ts';
import { probeLabel, type Probe } from './probeVisibility.ts';
import { sectionLabel, type Section } from './sectionHeatmap.ts';
import { zoneLabel, type SamplingVolume, type Zone } from './samplingVolumes.ts';
import {
  constraintLabel,
  groupLabel,
  type CameraConstraint,
  type ConstraintGroup,
} from '../placement/region.ts';
import type { Selection } from './viewportSelection.ts';

export type SceneNode =
  | { kind: 'group'; id: string; label: string; childIds: string[] }
  | { kind: 'camera'; id: string; label: string; cameraId: string }
  | { kind: 'probe'; id: string; label: string; probeId: string }
  | { kind: 'section'; id: string; label: string; sectionId: string }
  | { kind: 'zone'; id: string; label: string; zoneId: string; childIds: string[] }
  | { kind: 'volume'; id: string; label: string; volumeId: string }
  | {
      kind: 'constraintGroup';
      id: string;
      label: string;
      groupId: string;
      childIds: string[];
    }
  | { kind: 'constraint'; id: string; label: string; constraintId: string };

const CAMERA_GROUP_ID = 'group:cameras';
const PROBE_GROUP_ID = 'group:probes';
const SECTION_GROUP_ID = 'group:sections';
const ZONES_GROUP_ID = 'group:zones';
const CONSTRAINTS_GROUP_ID = 'group:constraints';
const CAMERA_NODE_PREFIX = 'cam:';
const PROBE_NODE_PREFIX = 'probe:';
const SECTION_NODE_PREFIX = 'section:';
const ZONE_NODE_PREFIX = 'zone:';
const VOLUME_NODE_PREFIX = 'volume:';
const CONSTRAINT_GROUP_NODE_PREFIX = 'cg:';
const CONSTRAINT_NODE_PREFIX = 'con:';

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

/** Stable tree-node id for a constraint group (namespaced to avoid collisions). */
export function nodeIdForConstraintGroup(groupId: string): string {
  return `${CONSTRAINT_GROUP_NODE_PREFIX}${groupId}`;
}

/** Inverse of {@link nodeIdForConstraintGroup}; null if the node id isn't a group. */
export function constraintGroupIdForNode(nodeId: string): string | null {
  return nodeId.startsWith(CONSTRAINT_GROUP_NODE_PREFIX)
    ? nodeId.slice(CONSTRAINT_GROUP_NODE_PREFIX.length)
    : null;
}

/** Stable tree-node id for a camera constraint (namespaced to avoid collisions). */
export function nodeIdForConstraint(constraintId: string): string {
  return `${CONSTRAINT_NODE_PREFIX}${constraintId}`;
}

/** Inverse of {@link nodeIdForConstraint}; null if the node id isn't a constraint. */
export function constraintIdForNode(nodeId: string): string | null {
  return nodeId.startsWith(CONSTRAINT_NODE_PREFIX)
    ? nodeId.slice(CONSTRAINT_NODE_PREFIX.length)
    : null;
}

/**
 * The tree node a selection highlights, or null when nothing is selected (spec §5.5).
 *
 * Keyed by an exhaustive `Record` over the selection kinds rather than a ternary
 * chain: the chain this replaced ended in `: null`, so `constraintGroup` and
 * `constraint` — added to `Selection` later — resolved to no node and their rows
 * never highlighted, even though both kinds are selectable
 * (`camera_placement.md` §7) and the row renders a highlight for whatever is
 * selected. The `Record` makes the next kind added to `Selection` a compile error
 * until it names its node here.
 */
export function nodeIdForSelection(selection: Selection): string | null {
  if (!selection) return null;
  const nodeIdFor: Record<NonNullable<Selection>['kind'], (id: string) => string> = {
    camera: nodeIdForCamera,
    probe: nodeIdForProbe,
    section: nodeIdForSection,
    zone: nodeIdForZone,
    volume: nodeIdForVolume,
    constraintGroup: nodeIdForConstraintGroup,
    constraint: nodeIdForConstraint,
  };
  return nodeIdFor[selection.kind](selection.id);
}

/**
 * A node's child ids. Groups, zones, and constraint groups have children; other
 * kinds don't.
 */
function childIdsOf(node: SceneNode): string[] {
  return node.kind === 'group' || node.kind === 'zone' || node.kind === 'constraintGroup'
    ? node.childIds
    : [];
}

/**
 * Build the scene tree: a "Cameras" group over one node per camera, and — when
 * any exist — sibling "Probes" / "Sections" groups, and a "Zones" umbrella over
 * selectable+expandable zone nodes (each holding its volume children). All in
 * array order. Returned flat, parents before their children; children are
 * reachable via `childIds`.
 */
export function buildSceneTree(
  cameras: SceneCamera[],
  probes: Probe[] = [],
  sections: Section[] = [],
  zones: Zone[] = [],
  volumes: SamplingVolume[] = [],
  constraintGroups: ConstraintGroup[] = [],
  constraints: CameraConstraint[] = [],
): SceneNode[] {
  const cameraNodes: SceneNode[] = cameras.map((c) => ({
    kind: 'camera',
    id: nodeIdForCamera(c.id),
    label: cameraLabel(c),
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
      label: probeLabel(p),
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
      label: sectionLabel(s),
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

  // The Constraints umbrella + group subtrees appear once any constraint group
  // exists — including an empty one (`camera_placement.md` §7), exactly as the
  // Zones umbrella does. Root order is Cameras → Probes → Sections → Zones →
  // Constraints, fixed (spec §5.5.1).
  if (constraintGroups.length > 0) {
    const groupNodes: SceneNode[] = [];
    const constraintNodes: SceneNode[] = [];
    for (const g of constraintGroups) {
      const own: SceneNode[] = constraints
        .filter((c) => c.groupId === g.id)
        .map((c) => ({
          kind: 'constraint',
          id: nodeIdForConstraint(c.id),
          label: constraintLabel(c),
          constraintId: c.id,
        }));
      groupNodes.push({
        kind: 'constraintGroup',
        id: nodeIdForConstraintGroup(g.id),
        label: groupLabel(g),
        groupId: g.id,
        childIds: own.map((n) => n.id),
      });
      constraintNodes.push(...own);
    }
    const umbrella: SceneNode = {
      kind: 'group',
      id: CONSTRAINTS_GROUP_ID,
      label: 'Constraints',
      childIds: groupNodes.map((n) => n.id),
    };
    nodes.push(umbrella, ...groupNodes, ...constraintNodes);
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

/**
 * What clicking a row selects, or `null` when the row only expands (§4.1).
 *
 * Keyed as an exhaustive `Record<SceneNode['kind'], …>` rather than written as
 * an if/else chain, for the reason `ui/entityMenu.ts` records: a trailing `else`
 * silently claims every kind added to the union afterwards. Here it claimed
 * `constraint`, so a node kind added next would have been selected *as* a
 * constraint — with `node.constraintId` undefined — and the row would have gone
 * quiet rather than failing. This way the next kind is a compile error.
 *
 * `group` is the one kind that selects nothing: a group header toggles its own
 * collapse instead.
 */
export function nodeSelection(node: SceneNode): Selection {
  const pick: { [K in SceneNode['kind']]: (n: Extract<SceneNode, { kind: K }>) => Selection } = {
    group: () => null,
    camera: (n) => ({ kind: 'camera', id: n.cameraId }),
    probe: (n) => ({ kind: 'probe', id: n.probeId }),
    section: (n) => ({ kind: 'section', id: n.sectionId }),
    zone: (n) => ({ kind: 'zone', id: n.zoneId }),
    volume: (n) => ({ kind: 'volume', id: n.volumeId }),
    constraintGroup: (n) => ({ kind: 'constraintGroup', id: n.groupId }),
    constraint: (n) => ({ kind: 'constraint', id: n.constraintId }),
  };
  return (pick[node.kind] as (n: SceneNode) => Selection)(node);
}
