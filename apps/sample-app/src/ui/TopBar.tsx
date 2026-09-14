/**
 * The app-wide top bar (spec §18.3): spans the full width of the shell, above the
 * three-column layout, and is the one element not gated by the placement mode's
 * show/hide rules (§2.4, §2.4.2) — it stays visible in every mode.
 */
import { SettingsMenu } from './SettingsMenu.tsx';

export function TopBar() {
  return (
    <div className="top-bar">
      <SettingsMenu />
    </div>
  );
}
