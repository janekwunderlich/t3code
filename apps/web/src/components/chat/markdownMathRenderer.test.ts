import { describe, expect, it, vi } from "vite-plus/test";
import katex from "katex";
import { renderMathToHtml } from "./markdownMathRenderer";

describe("renderMathToHtml", () => {
  it("reuses successful and failed renders without mixing display modes", () => {
    const typeset = vi.spyOn(katex, "renderToString");
    try {
      const tex = String.raw`\sqrt{123456789}`;
      expect(renderMathToHtml(tex, false)).toContain("katex");
      expect(renderMathToHtml(tex, false)).toContain("katex");
      expect(renderMathToHtml(tex, true)).toContain("katex-display");
      expect(renderMathToHtml(tex, true)).toContain("katex-display");
      expect(renderMathToHtml(String.raw`\invalidCommand`, false)).toBeNull();
      expect(renderMathToHtml(String.raw`\invalidCommand`, false)).toBeNull();
      expect(typeset).toHaveBeenCalledTimes(3);
    } finally {
      typeset.mockRestore();
    }
  });

  it("falls back for excessive input and output, including non-macro expressions", () => {
    expect(renderMathToHtml("x+".repeat(10_000), true)).toBeNull();
    expect(renderMathToHtml("x+".repeat(3_000), true)).toBeNull();
    expect(renderMathToHtml(String.raw`\frac{x^2}{2}`, true)).toContain("katex-display");
  });
});
