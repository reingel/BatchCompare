import { Color } from 'monaco-editor/base/common/color.js';

/** VS Code webview variables use CSS rgba(), while Monaco theme colors require hex. */
export function toMonacoColor(value, fallback) {
  let color;
  try { color = Color.Format.CSS.parse(value.trim()); } catch { /* use the supplied theme default */ }
  return Color.Format.CSS.formatHexA(color ?? Color.fromHex(fallback), true);
}
