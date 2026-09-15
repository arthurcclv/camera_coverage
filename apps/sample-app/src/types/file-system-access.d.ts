/**
 * Minimal ambient types for the parts of the File System Access API this app
 * uses (spec §14) that TypeScript's bundled DOM lib doesn't declare.
 * `FileSystemDirectoryHandle`/`FileSystemFileHandle` (incl. `getFileHandle`,
 * `getDirectoryHandle`, `createWritable`) are already in `lib.dom.d.ts`;
 * `Window.showDirectoryPicker`, `Window.showOpenFilePicker` (the asset import
 * picker, `asset_import.md` §3.2), the per-handle permission methods (used to
 * upgrade a read handle to readwrite on first save, §14.5), `isSameEntry` (used
 * to tell whether a picked file already lives in `assets/`, §8.3) and the
 * directory async iterators (used to list a folder's scene files, §14.4) are not.
 */
export {};

declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode?: 'read' | 'readwrite';
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    /**
     * Whether two handles name the **same entry on disk** — identity, not a path
     * comparison, which is the only way to answer "is this picked file already
     * in `assets/`?" when the picker exposes no path (`asset_import.md` §8.3).
     */
    isSameEntry(other: FileSystemHandle): Promise<boolean>;
  }

  interface FileSystemDirectoryHandle {
    /** Enumerates the folder's immediate children — how the Load dialog finds `*.json` (§14.4). */
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }

  interface DirectoryPickerOptions {
    mode?: 'read' | 'readwrite';
    /** Stable bucket for the browser's remembered directory (spec §14.5). */
    id?: string;
    /** Folder the picker opens in — the current save target, when there is one. */
    startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  }

  /** `showOpenFilePicker`'s options, as `asset_import.md` §3.2 uses them. */
  interface OpenFilePickerOptions {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    /** Stable bucket for the browser's remembered directory, as the scene pickers use. */
    id?: string;
    startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
    types?: { description?: string; accept: Record<string, string[]> }[];
  }

  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  }
}
