/**
 * Placement mode, left column, card 3 (`camera_placement.md` §5.1).
 *
 * The group's **camera template** — the optics every camera this run creates
 * starts at: `Name prefix`, `FOV`, `Range`. Persisted on the group (§3.1.1) so a
 * layout stays explicable months later, and shown only here, inside the mode
 * that reads it.
 *
 * **It sits under the two cards that have buttons, not above them.** These three
 * fields are set once for a group and then left alone, while `Size`/`Seed` and
 * `Max cams`/`Trials` are what a session iterates on — putting the settled card
 * first would push Build and Analyze down the column for the whole of every
 * session. The card carries no button of its own, which is what lets it sit
 * below two that do: nothing in it needs a press to take effect.
 *
 * `Range` is the one field that is also a *search* input — the capture rig
 * runs at it (§2.1) — so editing it moves the pool's fingerprint and Build's
 * label two cards up flips to **Rebuild** (§3.3.1). That is the whole of its
 * feedback, and it is stated where the cost is paid rather than here.
 *
 * There is no `Aspect` and no `Near`: both are placement-wide constants
 * (§3.1.1). `aspect` cannot change a reachable set and Apply never writes it
 * onto an existing camera, and `near` is a build-step input with no decision behind
 * it — exposing either only offered a way to rebuild a pool for a difference
 * no plot can show.
 */
import { useTranslation } from 'react-i18next';
import { Slider } from './Slider.tsx';
import type { ConstraintGroup } from '../placement/region.ts';

export interface NewCameraDefaultsPanelProps {
  group: ConstraintGroup;
  onChangeGroup(id: string, patch: Partial<ConstraintGroup>): void;
}

export function NewCameraDefaultsPanel({ group, onChangeGroup }: NewCameraDefaultsPanelProps) {
  const { t } = useTranslation('placement');
  const set = (patch: Partial<ConstraintGroup>) => onChangeGroup(group.id, patch);

  return (
    <div className="panel placement-defaults">
      <p className="panel-title">{t('newCameraDefaultsPanel.title')}</p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="cg-prefix">{t('newCameraDefaultsPanel.namePrefixLabel')}</label>
          <input
            id="cg-prefix"
            type="text"
            className="text-input"
            value={group.namePrefix}
            placeholder={t('newCameraDefaultsPanel.namePrefixPlaceholder')}
            onChange={(e) => set({ namePrefix: e.target.value })}
          />
        </div>
        <Slider
          label={t('newCameraDefaultsPanel.fovLabel')}
          value={group.fov}
          min={10}
          max={170}
          step={1}
          digits={0}
          onChange={(fov) => set({ fov })}
        />
        <Slider
          label={t('newCameraDefaultsPanel.rangeLabel')}
          value={group.far}
          min={0.5}
          max={100}
          step={0.1}
          digits={1}
          onChange={(far) => set({ far })}
        />
      </div>
    </div>
  );
}
