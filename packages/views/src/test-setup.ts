/**
 * jsdom test polyfills. jsdom doesn't implement the object-URL APIs the
 * media-uploader uses to preview a staged file, so stub them for component tests.
 */
import { vi } from 'vitest';

if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = vi.fn();
}

// jsdom's Blob/File may lack arrayBuffer(); back it with FileReader (which jsdom
// does implement) so the uploader's byte read works in component tests.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  (Blob.prototype as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
    function (this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    };
}
