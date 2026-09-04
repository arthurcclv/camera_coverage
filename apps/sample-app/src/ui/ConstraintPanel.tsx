/**
 * Selected-constraint panel (`camera_placement.md` §6): the constraint's name,
 * its group, its `distance` tolerance, and its geometry.
 *
 * A polyline is edited **one vertex at a time** — the panel half of §6.2, beside
 * the viewport's draw mode and vertex handles. Only the *selected* vertex is
 * shown: a rail on the real site runs to dozens of vertices, and a list of them
 * all is a wall of numbers in which the one the user is holding in the viewport
 * is the hardest row to find. Insert is disabled on the last vertex (Extend adds
 * past the end) and delete on a 2-vertex polyline, which the reducer refuses
 * rather than silently converting to a point.
 *
 * `distance` is a **tolerance, not a standoff** (§1.1): at 0 the region is the
 * primitive itself, which is how a fixed bracket or a bare wall surface is said.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import { insertMidpoint } from '../scene/polylineDraw.ts';
import { Slider } from './Slider.tsx';
import { Vec3Field } from './Vec3Field.tsx';
import { NumberInput } from './NumberInput.tsx';
import {
  MIN_PLANE_SIZE,
  constraintLabel,
  groupLabel,
  primitiveMeasure,
  type CameraConstraint,
  type ConstraintGroup,
} from '../placement/region.ts';

export interface ConstraintPanelProps {
  constraint: CameraConstraint | null;
  groups: readonly ConstraintGroup[];
  /**
   * The vertex every editor here acts on (§6.1) — a sub-selection, not a node.
   * Non-null for a polyline, which always has one selected; null otherwise.
   */
  selectedVertex: number | null;
  /** Whether Extend is armed on this constraint (§6.2), so the button reads as active. */
  extending: boolean;
  onRename(id: string, name: string): void;
  onChange(id: string, patch: Partial<CameraConstraint>): void;
  onMoveVertex(id: string, vertex: number, position: Vec3): void;
  onInsertVertex(id: string, at: number, position: Vec3): void;
  onDeleteVertex(id: string, vertex: number): void;
  onExtend(id: string, vertex: number): void;
}

const KIND_LABEL = { point: 'Point', polyline: 'Polyline', plane: 'Plane' } as const;

export function ConstraintPanel({
  constraint,
  groups,
  selectedVertex,
  extending,
  onRename,
  onChange,
  onMoveVertex,
  onInsertVertex,
  onDeleteVertex,
  onExtend,
}: ConstraintPanelProps) {
  if (!constraint) return null;
  const c = constraint;
  const group = groups.find((g) => g.id === c.groupId) ?? null;
  const measure = primitiveMeasure(c);

  return (
    <div className="panel">
      <p className="panel-title">
        {KIND_LABEL[c.kind]} constraint — {constraintLabel(c)}
      </p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="con-name">Name</label>
          <input
            id="con-name"
            type="text"
            className="text-input"
            value={c.name}
            placeholder={constraintLabel(c)}
            onChange={(e) => onRename(c.id, e.target.value)}
          />
        </div>

        <div className="row">
          <label htmlFor="con-group">Group</label>
          <select
            id="con-group"
            className="text-input"
            value={c.groupId}
            onChange={(e) => onChange(c.id, { groupId: e.target.value })}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {groupLabel(g)}
              </option>
            ))}
          </select>
        </div>

        <Slider
          label="Tolerance (m)"
          value={c.distance}
          min={0}
          max={10}
          step={0.05}
          digits={2}
          onChange={(distance) => onChange(c.id, { distance })}
        />
        <p className="hint">
          A camera may be mounted anywhere within this distance of the {KIND_LABEL[c.kind].toLowerCase()}.
          0 pins it to the {c.kind === 'plane' ? 'surface' : c.kind}.
        </p>

        <div className="stat-line">
          <span>{c.kind === 'plane' ? 'Area' : c.kind === 'polyline' ? 'Length' : 'Weight'}</span>
          <b>
            {c.kind === 'plane'
              ? `${measure.toFixed(0)} m²`
              : c.kind === 'polyline'
                ? `${measure.toFixed(1)} m`
                : '1'}
          </b>
        </div>
        <p className="hint">The pool splits by this weight, so a longer rail gets more samples.</p>

        {c.kind === 'point' && (
          <Vec3Field
            label="Position"
            columns={[
              { label: 'X', value: c.position[0], onCommit: (v) => onChange(c.id, { position: [v, c.position[1], c.position[2]] }) },
              { label: 'Y', value: c.position[1], onCommit: (v) => onChange(c.id, { position: [c.position[0], v, c.position[2]] }) },
              { label: 'Z', value: c.position[2], onCommit: (v) => onChange(c.id, { position: [c.position[0], c.position[1], v] }) },
            ]}
          />
        )}

        {c.kind === 'plane' && (
          <>
            <Vec3Field
              label="Center"
              columns={[
                { label: 'X', value: c.position[0], onCommit: (v) => onChange(c.id, { position: [v, c.position[1], c.position[2]] }) },
                { label: 'Y', value: c.position[1], onCommit: (v) => onChange(c.id, { position: [c.position[0], v, c.position[2]] }) },
                { label: 'Z', value: c.position[2], onCommit: (v) => onChange(c.id, { position: [c.position[0], c.position[1], v] }) },
              ]}
            />
            <div className="row">
              <label className="vec-group-label">Size</label>
              <div className="vec-fields">
                <label className="vec-field">
                  <span className="vec-axis">U</span>
                  <NumberInput
                    value={c.size[0]}
                    min={MIN_PLANE_SIZE}
                    digits={2}
                    seed="display"
                    ariaLabel="Size U"
                    onCommit={(v) => onChange(c.id, { size: [v, c.size[1]] })}
                  />
                </label>
                <label className="vec-field">
                  <span className="vec-axis">V</span>
                  <NumberInput
                    value={c.size[1]}
                    min={MIN_PLANE_SIZE}
                    digits={2}
                    seed="display"
                    ariaLabel="Size V"
                    onCommit={(v) => onChange(c.id, { size: [c.size[0], v] })}
                  />
                </label>
              </div>
            </div>
            <p className="hint">
              The rectangle spans its local X and Z; its normal is local Y. Rotate it with the
              viewport gizmo.
            </p>
          </>
        )}

        {c.kind === 'polyline' && selectedVertex !== null && (
          <PolylineVertex
            constraint={c}
            vertex={selectedVertex}
            extending={extending}
            onMoveVertex={onMoveVertex}
            onInsertVertex={onInsertVertex}
            onDeleteVertex={onDeleteVertex}
            onExtend={onExtend}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The selected vertex of a polyline (§6.2): which one it is, its coordinates, and
 * the three actions that change the vertex set.
 *
 * A separate component because it is the one part of this panel with a
 * sub-selection of its own — and because `insertMidpoint` returning null is what
 * disables Insert, a rule worth reading in one place.
 */
function PolylineVertex({
  constraint: c,
  vertex,
  extending,
  onMoveVertex,
  onInsertVertex,
  onDeleteVertex,
  onExtend,
}: {
  constraint: Extract<CameraConstraint, { kind: 'polyline' }>;
  vertex: number;
  extending: boolean;
  onMoveVertex(id: string, vertex: number, position: Vec3): void;
  onInsertVertex(id: string, at: number, position: Vec3): void;
  onDeleteVertex(id: string, vertex: number): void;
  onExtend(id: string, vertex: number): void;
}) {
  const p = c.points[vertex];
  if (!p) return null;
  const insert = insertMidpoint(c.points, vertex);
  const canDelete = c.points.length > 2;

  return (
    <>
      <div className="vertex-head">
        <p className="panel-title subhead">
          Vertex {vertex + 1} <span className="vertex-count">of {c.points.length}</span>
        </p>
        <button
          type="button"
          className={`btn secondary${extending ? ' active' : ''}`}
          title={
            extending
              ? 'Click the geometry to add vertices — Enter or a double-click to finish'
              : vertex === 0
                ? 'Extend — click the geometry to add vertices before the first one'
                : 'Extend — click the geometry to add vertices past the last one'
          }
          aria-pressed={extending}
          onClick={() => onExtend(c.id, vertex)}
        >
          Extend
        </button>
      </div>
      <p className="hint">
        Click a vertex handle in the viewport to select it, or drag it there. A loop repeats
        its first vertex as the last.
      </p>
      <div className="vertex-row">
        <Vec3Field
          label={`v${vertex + 1}`}
          columns={[
            { label: 'X', value: p[0], onCommit: (v) => onMoveVertex(c.id, vertex, [v, p[1], p[2]]) },
            { label: 'Y', value: p[1], onCommit: (v) => onMoveVertex(c.id, vertex, [p[0], v, p[2]]) },
            { label: 'Z', value: p[2], onCommit: (v) => onMoveVertex(c.id, vertex, [p[0], p[1], v]) },
          ]}
        />
        <div className="vertex-actions">
          <button
            type="button"
            className="btn secondary icon-btn"
            title={
              insert
                ? 'Insert a vertex midway to the next one'
                : 'The last vertex has no next one — use Extend to add past the end'
            }
            aria-label="Insert a vertex"
            disabled={insert === null}
            onClick={() => insert && onInsertVertex(c.id, insert.at, insert.position)}
          >
            +
          </button>
          <button
            type="button"
            className="btn secondary icon-btn"
            title={canDelete ? 'Delete this vertex' : 'A polyline needs at least 2 vertices'}
            aria-label="Delete this vertex"
            disabled={!canDelete}
            onClick={() => onDeleteVertex(c.id, vertex)}
          >
            −
          </button>
        </div>
      </div>
    </>
  );
}
