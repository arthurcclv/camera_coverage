/**
 * The app's **only** browser download (spec §15.2).
 *
 * Every other write goes through the File System Access API into the scene folder
 * (§14.5, `sceneIO.ts`), which needs a picked folder and a granted permission. The
 * camera info sidecar deliberately does not: it is a one-way file with no place in
 * the scene folder's contract, and it has to work on the **boot scene**, where no
 * save target exists yet (§14.1). A blob URL and a synthetic click cost nothing and
 * ask for nothing.
 *
 * Impure by nature — DOM and object URLs — so it is kept to this one function with
 * no decisions in it; the decisions (name, bytes) are `cameras/cameraInfo.ts`'s and
 * are unit-tested there (`ai/CONVENTIONS.md`).
 */

/** Hand `text` to the browser as a download named `fileName`. */
export function downloadTextFile(fileName: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // The click is synchronous, but the fetch of the blob is not — revoking in a
  // microtask would cancel the download in some browsers, so yield a turn first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
