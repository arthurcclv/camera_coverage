/**
 * Minimal ambient types for the parts of the File System Access API this app
 * uses (spec §14) that TypeScript's bundled DOM lib doesn't declare.
 * `FileSystemDirectoryHandle`/`FileSystemFileHandle` (incl. `getFileHandle`,
 * `getDirectoryHandle`, `createWritable`) are already in `lib.dom.d.ts`; only
 * `Window.showDirectoryPicker` is missing.
 */
export {};

declare global {
  interface DirectoryPickerOptions {
    mode?: 'read' | 'readwrite';
  }

  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
