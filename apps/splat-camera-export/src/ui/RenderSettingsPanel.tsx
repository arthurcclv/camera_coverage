/**
 * The render-settings panel (spec §10.3). Every setting is inert until the next
 * run — the run in flight copies its settings at start.
 */
import type { ImageFormat } from '../export/manifest.ts';
import { imageSizeFor, type ResolutionMode } from '../render/imageSize.ts';
import type { BackendPreference } from '../viewport/Viewport.tsx';
import { hexToRgb, rgbToHex } from './color.ts';
import { NumberInput } from './NumberInput.tsx';

export interface RenderSettingsState {
  resolution: ResolutionMode;
  format: ImageFormat;
  quality: number;
  samples: number;
  settleFrames: number;
  background: [number, number, number, number];
  transparentBackground: boolean;
  /** `null` clips at each camera's own `far` (§5.2). */
  farOverride: number | null;
  includeDisabled: boolean;
}

export interface RenderSettingsPanelProps {
  settings: RenderSettingsState;
  onChange: (s: RenderSettingsState) => void;
  /** The selected camera's aspect, for the effective-size readout (§10.5). */
  previewAspect: number | null;
  maxTextureSize: number;
  backend: BackendPreference;
  /** The backend actually in use, or `null` before the device exists. */
  backendName: string | null;
  onBackendChange: (b: BackendPreference) => void;
}

export function RenderSettingsPanel({
  settings,
  onChange,
  previewAspect,
  maxTextureSize,
  backend,
  backendName,
  onBackendChange,
}: RenderSettingsPanelProps) {
  const set = <K extends keyof RenderSettingsState>(key: K, value: RenderSettingsState[K]) =>
    onChange({ ...settings, [key]: value });

  const effective =
    previewAspect !== null ? imageSizeFor(previewAspect, settings.resolution, maxTextureSize) : null;

  return (
    <section className="panel">
      <h2 className="panel-title">Render</h2>

      <div className="field-row" role="radiogroup" aria-label="Resolution mode">
        <button
          type="button"
          className={settings.resolution.kind === 'derive' ? 'btn btn-active' : 'btn'}
          role="radio"
          aria-checked={settings.resolution.kind === 'derive'}
          onClick={() => set('resolution', { kind: 'derive', baseHeight: 1080 })}
        >
          From camera
        </button>
        <button
          type="button"
          className={settings.resolution.kind === 'fixed' ? 'btn btn-active' : 'btn'}
          role="radio"
          aria-checked={settings.resolution.kind === 'fixed'}
          onClick={() => set('resolution', { kind: 'fixed', width: 1920, height: 1080 })}
        >
          Fixed
        </button>
      </div>

      {settings.resolution.kind === 'derive' ? (
        <div className="field-row">
          <NumberInput
            label="Height"
            value={settings.resolution.baseHeight}
            onCommit={(v) => set('resolution', { kind: 'derive', baseHeight: v })}
            min={16}
            max={maxTextureSize}
            digits={0}
          />
          <p className="hint">Width follows each camera's own aspect.</p>
        </div>
      ) : (
        <div className="field-row">
          <NumberInput
            label="Width"
            value={settings.resolution.width}
            onCommit={(v) =>
              set('resolution', { kind: 'fixed', width: v, height: (settings.resolution as { height: number }).height })
            }
            min={16}
            max={maxTextureSize}
            digits={0}
          />
          <NumberInput
            label="Height"
            value={settings.resolution.height}
            onCommit={(v) =>
              set('resolution', { kind: 'fixed', width: (settings.resolution as { width: number }).width, height: v })
            }
            min={16}
            max={maxTextureSize}
            digits={0}
          />
        </div>
      )}

      {effective && (
        <p className="hint">
          Selected camera exports at {effective.width}×{effective.height}
          {effective.clamped ? ' (clamped to device limits)' : ''}
          {settings.resolution.kind === 'fixed' && previewAspect !== null &&
          Math.abs(effective.width / effective.height - previewAspect) > 0.01
            ? ' — differs from the camera’s aspect, so it sees a different amount of the scene'
            : ''}
        </p>
      )}

      <div className="field-row" role="radiogroup" aria-label="Image format">
        <button
          type="button"
          className={settings.format === 'png' ? 'btn btn-active' : 'btn'}
          role="radio"
          aria-checked={settings.format === 'png'}
          onClick={() => set('format', 'png')}
        >
          PNG
        </button>
        <button
          type="button"
          className={settings.format === 'jpeg' ? 'btn btn-active' : 'btn'}
          role="radio"
          aria-checked={settings.format === 'jpeg'}
          onClick={() => set('format', 'jpeg')}
        >
          JPEG
        </button>
      </div>

      {settings.format === 'jpeg' && (
        <div className="field-row">
          <NumberInput
            label="Quality"
            value={settings.quality}
            onCommit={(v) => set('quality', v)}
            min={0.1}
            max={1}
            digits={2}
          />
        </div>
      )}

      <div className="field-row">
        <NumberInput
          label="Samples"
          value={settings.samples}
          onCommit={(v) => set('samples', Math.round(v))}
          min={1}
          max={8}
          digits={0}
          title="Render-target multi-sampling; 1 disables"
        />
        <NumberInput
          label="Settle frames"
          value={settings.settleFrames}
          onCommit={(v) => set('settleFrames', Math.round(v))}
          min={0}
          max={30}
          digits={0}
          title="Frames waited after the splat sort completes, before reading pixels"
        />
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={settings.farOverride !== null}
          onChange={(e) => set('farOverride', e.target.checked ? 1000 : null)}
        />
        <span>Override far plane</span>
      </label>
      {settings.farOverride !== null ? (
        <div className="field-row">
          <NumberInput
            label="Far"
            value={settings.farOverride}
            onCommit={(v) => set('farOverride', v)}
            min={0.01}
            digits={1}
          />
        </div>
      ) : (
        <p className="hint">
          Clipping at each camera's own <code>far</code> — the coverage range, which may slice the splat.
        </p>
      )}

      <label className="check">
        <input
          type="checkbox"
          checked={settings.transparentBackground}
          onChange={(e) => set('transparentBackground', e.target.checked)}
        />
        <span>Transparent background</span>
      </label>

      {!settings.transparentBackground && (
        <label className="field">
          <span className="field-label">Background</span>
          <input
            type="color"
            value={rgbToHex(settings.background)}
            onChange={(e) => {
              const [r, g, b] = hexToRgb(e.target.value);
              set('background', [r, g, b, 1]);
            }}
          />
        </label>
      )}

      <label className="check">
        <input
          type="checkbox"
          checked={settings.includeDisabled}
          onChange={(e) => set('includeDisabled', e.target.checked)}
        />
        <span>Include coverage-disabled cameras</span>
      </label>

      <div className="field-row" role="radiogroup" aria-label="Graphics backend">
        <button
          type="button"
          className={backend === 'auto' ? 'btn btn-active' : 'btn'}
          role="radio"
          aria-checked={backend === 'auto'}
          onClick={() => onBackendChange('auto')}
          title="Prefer WebGPU, fall back to WebGL2"
        >
          Auto
        </button>
        <button
          type="button"
          className={backend === 'webgl2' ? 'btn btn-active' : 'btn'}
          role="radio"
          aria-checked={backend === 'webgl2'}
          onClick={() => onBackendChange('webgl2')}
          title="Force WebGL2 — try this if exported images come out black"
        >
          Force WebGL2
        </button>
      </div>
      <p className="hint">
        {backendName ? `Rendering on ${backendName}.` : 'Initializing graphics…'} Switching
        reloads the 3D view; the splat and cameras stay loaded.
      </p>
    </section>
  );
}
