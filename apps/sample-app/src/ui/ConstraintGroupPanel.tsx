/**
 * Selected constraint-group panel (`camera_placement.md` §5): the group's name,
 * its constraint count, its **target zones**, and the button that opens the
 * placement mode.
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
 * **The target zones are the one placement input that stays** (§3.1.2). They are
 * a *reference to other scene entities* rather than a number: they give the group
 * its identity, they must outlive zone deletion and regeneration (§7), and
 * through `restrictMounts` they change what every constraint in the group
 * geometrically *means* — which is visible in the viewport whether or not the
 * mode is open. None of that is true of `fov`, `poolSize`, or `seed`.
 *
 * Nothing here is a coverage input (§1.1), so no edit marks the result stale.
 */
import { useTranslation } from 'react-i18next';
import { groupLabel, type ConstraintGroup } from '../placement/region.ts';
import { zoneLabel, type Zone } from '../scene/samplingVolumes.ts';

export interface ConstraintGroupPanelProps {
  group: ConstraintGroup | null;
  /** Constraints belonging to this group. */
  memberCount: number;
  /** Every zone in the scene — the add control offers the ones not yet listed. */
  zones: readonly Zone[];
  /**
   * The §4.1.1 overlap line — `Dock rail 100% · North wall 4%` — or null when the
   * group has no mount filter.
   *
   * It is the **text cue beside the dimmed gizmos** (§5): dimming alone cannot
   * distinguish "no draw can land here" from "disabled", and `VISUAL_DESIGN.md`
   * requires a redundant text cue for state carried in a visual channel. Resolved
   * outside the panel because it costs 256 draws per constraint.
   */
  overlapText: string | null;
  /** Why the placement mode cannot be opened on this group, or null (§5.1, §10). */
  placementBlocker: string | null;
  onRename(id: string, name: string): void;
  /** Patch the group's target zones or either flag (§3.1.2). */
  onChange(id: string, patch: Partial<ConstraintGroup>): void;
  /** Open the placement mode on this group (§5). */
  onPlaceCameras(id: string): void;
}

export function ConstraintGroupPanel({
  group,
  memberCount,
  zones,
  overlapText,
  placementBlocker,
  onRename,
  onChange,
  onPlaceCameras,
}: ConstraintGroupPanelProps) {
  const { t } = useTranslation(['placement', 'common']);
  if (!group) return null;

  // A zone id naming no live zone is not rendered: the reducer prunes eagerly
  // (§7), so this only ever covers the frame between a load and its first edit.
  const listed = group.zoneIds
    .map((id) => zones.find((z) => z.id === id))
    .filter((z): z is Zone => z !== undefined);
  // The add control offers only what is *not* listed, which is what makes a
  // duplicate impossible by construction rather than by a guard (§5).
  const addable = zones.filter((z) => !group.zoneIds.includes(z.id));
  // Both flags are inert with an empty list (§3.1.2): the alternatives are an
  // empty target set and an unsatisfiable mount test, two spellings of "empty
  // pool". So they render disabled rather than lying about what they do.
  const empty = listed.length === 0;
  const emptyListHint = t('placement:constraintGroupPanel.emptyListHint');

  return (
    <div className="panel">
      <p className="panel-title">{t('placement:constraintGroupPanel.title', { name: groupLabel(group) })}</p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="cg-name">{t('common:name')}</label>
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
          <span>{t('placement:constraintGroupPanel.constraintsLabel')}</span>
          <b>{memberCount}</b>
        </div>

        {/* Target zones (§3.1.2) — the zones this group plans for. The two flags
            sit above the list because they say what the list is *for*, and a
            list whose meaning is read below it is read twice. */}
        <p className="panel-title subhead">{t('placement:constraintGroupPanel.targetZonesTitle')}</p>

        <label className="checkbox-row" title={empty ? emptyListHint : undefined}>
          <input
            type="checkbox"
            checked={group.restrictScoring}
            disabled={empty}
            onChange={(e) => onChange(group.id, { restrictScoring: e.target.checked })}
          />
          <span>{t('placement:constraintGroupPanel.restrictScoringLabel')}</span>
        </label>

        <label className="checkbox-row" title={empty ? emptyListHint : undefined}>
          <input
            type="checkbox"
            checked={group.restrictMounts}
            disabled={empty}
            onChange={(e) => onChange(group.id, { restrictMounts: e.target.checked })}
          />
          <span>{t('placement:constraintGroupPanel.restrictMountsLabel')}</span>
        </label>

        <div className="row">
          <label htmlFor="cg-add-zone">{t('placement:constraintGroupPanel.addZoneLabel')}</label>
          <select
            id="cg-add-zone"
            className="select"
            // Never holds a selection: it is an *action*, not a field. Binding it
            // to a listed zone would make the control claim the group has one
            // "current" target, which is exactly what a list is not.
            value=""
            disabled={addable.length === 0}
            onChange={(e) => {
              if (e.target.value === '') return;
              onChange(group.id, { zoneIds: [...group.zoneIds, e.target.value] });
            }}
          >
            <option value="">
              {addable.length === 0
                ? t('placement:constraintGroupPanel.noZonesToAdd')
                : t('placement:constraintGroupPanel.addZonePrompt')}
            </option>
            {addable.map((z) => (
              <option key={z.id} value={z.id}>
                {zoneLabel(z)}
              </option>
            ))}
          </select>
        </div>

        {listed.map((z) => (
          <div className="row" key={z.id}>
            <span>{zoneLabel(z)}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label={t('placement:constraintGroupPanel.removeZoneAriaLabel', { name: zoneLabel(z) })}
              onClick={() =>
                onChange(group.id, { zoneIds: group.zoneIds.filter((id) => id !== z.id) })
              }
            >
              ×
            </button>
          </div>
        ))}

        {empty && (
          <p className="hint">{t('placement:constraintGroupPanel.noTargetZonesHint')}</p>
        )}

        {/* Which constraints the mount filter can actually draw on, in words
            (§5). The viewport dims the ones at 0%, and a dimmed gizmo reads the
            same as a disabled one — so the percentages, not the dimming, are
            what say which wall to move, widen, or stop listing. */}
        {overlapText && <p className="hint">{overlapText}</p>}

        {/* Placement is a mode, not a panel (§5): this is its only entry point,
            and the group it is pressed on is the group the mode targets for its
            whole life — which is why the mode needs no group selector. */}
        <button
          type="button"
          className="btn block"
          disabled={placementBlocker !== null}
          onClick={() => onPlaceCameras(group.id)}
        >
          {t('placement:constraintGroupPanel.placeCamerasButton')}
        </button>
        {placementBlocker && <p className="hint warn">{placementBlocker}</p>}
      </div>
    </div>
  );
}
