/**
 * Selected constraint-group panel (`camera_placement.md` §5): the group's name,
 * its constraint count, and the button that opens the placement mode.
 *
 * These are the group's own fields, so they live in the left column's selection
 * inspector (`spec.md` §2.2). **The camera template is not here** — it is the
 * mode's third card (§5.1). It is an input to a placement run rather than a
 * description of the group, and none of it is read until the mode is open; out
 * here it cost this panel a heading and a second thought, in a panel whose one
 * job is to get the user into the tool.
 *
 * The **strategy** is persisted on the group too, and is shown in the mode for
 * the same reason: it is the analysis's parameters, not the group's description.
 *
 * Nothing here is a coverage input (§1.1), so no edit marks the result stale.
 */
import { groupLabel, type ConstraintGroup } from '../placement/region.ts';

export interface ConstraintGroupPanelProps {
  group: ConstraintGroup | null;
  /** Constraints belonging to this group. */
  memberCount: number;
  /** Why the placement mode cannot be opened on this group, or null (§5.1, §10). */
  placementBlocker: string | null;
  onRename(id: string, name: string): void;
  /** Open the placement mode on this group (§5). */
  onPlaceCameras(id: string): void;
}

export function ConstraintGroupPanel({
  group,
  memberCount,
  placementBlocker,
  onRename,
  onPlaceCameras,
}: ConstraintGroupPanelProps) {
  if (!group) return null;

  return (
    <div className="panel">
      <p className="panel-title">Constraint group — {groupLabel(group)}</p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="cg-name">Name</label>
          <input
            id="cg-name"
            type="text"
            className="text-input"
            value={group.name}
            placeholder={groupLabel(group)}
            onChange={(e) => onRename(group.id, e.target.value)}
          />
        </div>

        <div className="stat-line">
          <span>Constraints</span>
          <b>{memberCount}</b>
        </div>

        {/* Placement is a mode, not a panel (§5): this is its only entry point,
            and the group it is pressed on is the group the mode targets for its
            whole life — which is why the mode needs no group selector. */}
        <button
          type="button"
          className="btn block"
          disabled={placementBlocker !== null}
          onClick={() => onPlaceCameras(group.id)}
        >
          Place cameras
        </button>
        {placementBlocker && <p className="hint warn">{placementBlocker}</p>}
      </div>
    </div>
  );
}
