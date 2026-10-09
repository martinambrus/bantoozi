/** The browser reads the object URL when the download starts; this is far longer than that takes. */
const RELEASE_AFTER_MS = 40_000;

/** Hands `file` to the browser as a download named `filename`. */
export function saveFile(file: Blob, filename: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), RELEASE_AFTER_MS);
}
