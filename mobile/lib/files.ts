/**
 * Reads a picked file (from expo-document-picker) as a base64 string, for
 * sending to a server-side function as JSON (e.g. extract-schedule).
 *
 * Uses fetch + arrayBuffer rather than expo-file-system: the same pattern
 * already proven working in AddDocumentScreen's upload flow, and it works
 * uniformly for both native `file://` URIs and web `blob:` URIs without
 * platform branching. (expo-file-system's API in this SDK version is a
 * rewritten `File` class with no direct base64 reader — arrayBuffer() is
 * the only overlapping primitive, so there's nothing it would have saved
 * us here.)
 */
export async function readFileAsBase64(uri: string): Promise<string> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

/**
 * Chunked conversion — spreading a large Uint8Array directly into
 * String.fromCharCode(...bytes) risks a "Maximum call stack size exceeded"
 * on big files (each argument counts toward the call's stack frame).
 * 8KB chunks keep this safe well past any routing-sheet-sized document.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x2000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}