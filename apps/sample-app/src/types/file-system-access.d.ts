/**
 * Minimal ambient types for the parts of the File System Access API this app
 * uses (spec §14) that TypeScript's bundled DOM lib doesn't declare.
 * `FileSystemDirectoryHandle`/`FileSystemFileHandle` (incl. `getFileHandle`,
 * `getDirectoryHandle`, `createWritable`) are already in `lib.dom.d.ts`;
 * `Window.showDirectoryPicker` and the per-handle permission methods (used to
 * upgrade a read handle to readwrite on first save, §14.5) are not.
 */
export {};

declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode?: 'read' | 'readwrite';
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }

  interface DirectoryPickerOptions {
    mode?: 'read' | 'readwrite';
    /** Stable bucket for the browser's remembered directory (spec §14.5). */
    id?: string;
    /** Folder the picker opens in — the current save target, when there is one. */
    startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  }

  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
