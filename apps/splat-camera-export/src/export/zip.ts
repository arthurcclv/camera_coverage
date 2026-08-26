/**
 * Zip packaging and download of an exported batch (spec §9.3).
 *
 * Impure: fflate plus an object-URL download.
 */
import { zip, type Zippable } from 'fflate';

/** Warn past this accumulated size rather than failing opaquely (§9.3). */
export const SIZE_WARN_BYTES = 512 * 1024 * 1024;

export interface ZipEntry {
  filename: string;
  bytes: Uint8Array;
}

/**
 * Zips entries with **store (level 0)** — PNG and JPEG are already compressed, so
 * deflating them again costs time and saves nothing (§9.3).
 */
export function zipEntries(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const payload: Zippable = {};
  for (const { filename, bytes } of entries) {
    payload[filename] = [bytes, { level: 0 }];
  }
  return new Promise((resolve, reject) => {
    zip(payload, { level: 0 }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

/** Triggers a browser download of `bytes` as `filename`. */
export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'application/zip'): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can race the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A human-readable byte size for the progress readout (§9.5). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
