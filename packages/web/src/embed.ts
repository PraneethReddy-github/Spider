/**
 * Embedded in a host (the VS Code extension's webview iframes this app): editor deep links are
 * handed to the host as `{type: 'spider.openFile', path, line, col}` instead of the OS.
 */
export function postToHost(url: string): boolean {
  if (window.parent === window) return false;
  const m = /^[a-z-]+:\/\/file(\/.*?):(\d+):(\d+)$/.exec(url);
  if (!m) return false;
  let path = decodeURI(m[1]);
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1); // Windows drive paths carry an extra leading slash
  window.parent.postMessage({ type: 'spider.openFile', path, line: Number(m[2]), col: Number(m[3]) }, '*');
  return true;
}
