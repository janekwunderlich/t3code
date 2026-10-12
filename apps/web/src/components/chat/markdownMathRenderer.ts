import katex from "katex";
import "katex/dist/katex.min.css";
import { LRUCache } from "../../lib/lruCache";

const MAX_TEX_LENGTH = 8_192;
const MAX_HTML_LENGTH = 512 * 1024;
// Keyed by mode and source. Streaming re-renders a message on every token, and
// each settled formula must cost a map lookup there, not another typeset.
const cache = new LRUCache<{ html: string | null }>(512, 4 * 1024 * 1024);

/** KaTeX HTML for one formula, or null when KaTeX cannot typeset it. */
export function renderMathToHtml(tex: string, display: boolean): string | null {
  // Macro expansion limits do not bound ordinary input or the generated DOM.
  // Oversized formulas keep the same copyable source fallback as invalid TeX.
  if (tex.length > MAX_TEX_LENGTH) return null;
  const key = `${display ? "D" : "I"}${tex}`;
  const cached = cache.get(key);
  if (cached !== null) return cached.html;
  let html: string | null;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      // The wrapper carries the TeX as its accessible name; MathML would double
      // the DOM and put a second, hidden copy of the text in selections.
      output: "html",
      throwOnError: true,
      strict: "ignore",
      maxExpand: 500,
      maxSize: 20,
    });
    if (html.length > MAX_HTML_LENGTH) html = null;
  } catch {
    html = null;
  }
  cache.set(key, { html }, 2 * (key.length + (html?.length ?? 0)));
  return html;
}
