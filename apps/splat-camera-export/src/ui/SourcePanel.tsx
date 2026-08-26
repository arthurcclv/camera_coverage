/**
 * The source panel (spec §10.1): the splat picker with load state, and the
 * `scene.json` picker with the imported camera count.
 */
import { useRef } from 'react';
import { ACCEPT_ATTRIBUTE } from '../viewport/splatAsset.ts';
import type { LoadProgress } from '../viewport/splatAsset.ts';
import { formatBytes } from '../export/zip.ts';

export interface SourcePanelProps {
  splatName: string | null;
  splatBytes: number | null;
  splatProgress: LoadProgress | null;
  sceneName: string | null;
  cameraCount: number;
  onPickSplat: (files: File[]) => void;
  onPickScene: (file: File) => void;
}

export function SourcePanel({
  splatName,
  splatBytes,
  splatProgress,
  sceneName,
  cameraCount,
  onPickSplat,
  onPickScene,
}: SourcePanelProps) {
  const splatRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<HTMLInputElement>(null);

  const percent =
    splatProgress && splatProgress.total > 0
      ? Math.round((splatProgress.loaded / splatProgress.total) * 100)
      : null;

  return (
    <section className="panel">
      <h2 className="panel-title">Source</h2>

      <div className="button-row">
        <button type="button" className="btn btn-primary" onClick={() => splatRef.current?.click()}>
          Load splat…
        </button>
        <input
          ref={splatRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) onPickSplat(files);
            e.target.value = '';
          }}
        />
      </div>
      {splatProgress !== null ? (
        <p className="hint">Loading{percent !== null ? ` — ${percent}%` : '…'}</p>
      ) : splatName ? (
        <p className="hint">
          {splatName}
          {splatBytes !== null ? ` · ${formatBytes(splatBytes)}` : ''}
        </p>
      ) : (
        <p className="hint">.ply, .sog, or a SOG bundle (select meta.json with its .webp files).</p>
      )}

      <div className="button-row">
        <button type="button" className="btn" onClick={() => sceneRef.current?.click()}>
          Import scene.json…
        </button>
        <input
          ref={sceneRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onPickScene(file);
            e.target.value = '';
          }}
        />
      </div>
      <p className="hint">
        {sceneName
          ? `${sceneName} · ${cameraCount} camera${cameraCount === 1 ? '' : 's'}`
          : 'Cameras from the coverage app.'}
      </p>
    </section>
  );
}
