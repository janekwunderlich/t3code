import { describe, expect, it } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import type { Construct } from "micromark-util-types";
import { remarkMath } from "./markdownMath.ts";
import { CHAT_MARKDOWN_REHYPE_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const processor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);

function render(markdown: string) {
  return processor.runSync(processor.parse(markdown)) as HastNode;
}

function textOf(node: HastNode): string {
  return node.value ?? (node.children ?? []).map(textOf).join("");
}

function mathIn(markdown: string) {
  const found: Array<{ display: unknown; tex: string }> = [];
  const visit = (node: HastNode) => {
    if (node.tagName === "code" && node.properties?.dataMath !== undefined) {
      found.push({ display: node.properties.dataMath, tex: textOf(node) });
      return;
    }
    node.children?.forEach(visit);
  };
  visit(render(markdown));
  return found;
}

function blocks(markdown: string) {
  return (render(markdown).children ?? [])
    .filter((node) => node.type === "element")
    .map((node) => [node.tagName, textOf(node)]);
}

describe("remarkMath", () => {
  it("scans repeated unmatched openers only once per content block", () => {
    let consumed = 0;
    const trace = (construct: Construct): Construct => ({
      ...construct,
      tokenize(effects, ok, nok) {
        return construct.tokenize.call(
          this,
          {
            ...effects,
            consume(code) {
              consumed++;
              effects.consume(code);
            },
          },
          ok,
          nok,
        );
      },
    });
    const parser = unified()
      .use(remarkParse)
      .use(remarkMath)
      .use(function () {
        const data = this.data();
        // remarkMath registers one text construct per delimiter character.
        data.micromarkExtensions = (data.micromarkExtensions ?? []).map((extension) => ({
          ...extension,
          text: Object.fromEntries(
            Object.entries(extension.text ?? {}).map(([code, construct]) => [
              code,
              trace(construct as Construct),
            ]),
          ),
        }));
      });
    const source = String.raw`x \(a `.repeat(4_000);
    expect(parser.parse(source).children).toHaveLength(1);
    // Count tokenizer work, not wall-clock time, so slower CI is equally reliable.
    expect(consumed).toBeLessThan(source.length * 2);
    expect(mathIn(source + "`code` then \\(valid\\)")).toEqual([
      { display: "inline", tex: "valid" },
    ]);
    expect(mathIn("fresh \\(closed\\)")).toEqual([{ display: "inline", tex: "closed" }]);
  });

  it("keeps the TeX meaning of each delimiter", () => {
    expect(mathIn("Energy \\(E = mc^2\\) here")).toEqual([{ display: "inline", tex: "E = mc^2" }]);
    expect(mathIn("$$\n\\frac{a}{b}\n$$")).toEqual([{ display: "block", tex: "\\frac{a}{b}" }]);
    expect(mathIn("\\[\n\\sum_i x_i\n\\]")).toEqual([{ display: "block", tex: "\\sum_i x_i" }]);
    expect(mathIn("\\[ a + b \\]")).toEqual([{ display: "block", tex: "a + b" }]);
    expect(mathIn("so $$x^2$$ grows")).toEqual([{ display: "display", tex: "x^2" }]);
  });

  it("lets display math interrupt a paragraph, like a code fence", () => {
    expect(blocks("The energy is\n$$\nE = mc^2\n$$\nwhich is large.")).toEqual([
      ["p", "The energy is"],
      ["code", "E = mc^2"],
      ["p", "which is large."],
    ]);
  });

  it("keeps multi-line environments and closers that end a line", () => {
    expect(mathIn("$$\\begin{aligned}\na &= b \\\\\n+ c &= d\n\\end{aligned}$$")).toEqual([
      { display: "block", tex: "\\begin{aligned}\na &= b \\\\\n+ c &= d\n\\end{aligned}" },
    ]);
    expect(mathIn("$$\n\\begin{cases}\n1 \\\\\n2\n\\end{cases}\n$$")).toEqual([
      { display: "block", tex: "\\begin{cases}\n1 \\\\\n2\n\\end{cases}" },
    ]);
  });

  it("only continues a display block when its opening line does not close", () => {
    expect(blocks("$$x^2$$ grows quickly\nand so on")).toEqual([
      ["p", "x^2 grows quickly\nand so on"],
    ]);
    expect(blocks("Then\n$$\\begin{aligned}\na &= 1\n\\end{aligned}$$")).toEqual([
      ["p", "Then"],
      ["code", "\\begin{aligned}\na &= 1\n\\end{aligned}"],
    ]);
  });

  it("reads math inside lists and blockquotes without their prefixes", () => {
    expect(mathIn("> $$\n> x +\n> y\n> $$")).toEqual([{ display: "block", tex: "x +\ny" }]);
    expect(mathIn("- item \\(a_1\\)\n  $$\n  b\n  $$")).toEqual([
      { display: "inline", tex: "a_1" },
      { display: "block", tex: "b" },
    ]);
  });

  it("leaves prose that only looks like math alone", () => {
    for (const prose of [
      "It costs $5 and $10.",
      "Set $HOME and $PATH.",
      "See \\[1\\] and \\[2\\] for details.",
      "\\[1\\] Smith et al.",
      "Match \\\\(group\\\\) in the regex.",
      "Three $$$ signs, then $$$x$$$.",
      "Nothing between $$ $$ here.",
    ]) {
      expect(mathIn(prose), prose).toEqual([]);
    }
    expect(blocks("\\[1\\] Smith et al.")).toEqual([["p", "[1] Smith et al."]]);
  });

  it("gives code precedence over math", () => {
    expect(mathIn("Write `\\(x\\)` literally")).toEqual([]);
    expect(mathIn("Use `$$` and `$$` for PIDs")).toEqual([]);
    expect(mathIn("\\(a `b\\) c`")).toEqual([]);
    expect(mathIn("```tex\n$$\nx\n$$\n```")).toEqual([]);
  });

  it("reads a backslash and the next character as one TeX token", () => {
    expect(mathIn("\\(\\{a\\} \\\\\\)")).toEqual([{ display: "inline", tex: "\\{a\\} \\\\" }]);
    expect(mathIn("$$\\$5 + x$$")).toEqual([{ display: "block", tex: "\\$5 + x" }]);
    expect(mathIn("\\[\na \\\\]\n\\]")).toEqual([{ display: "block", tex: "a \\\\]" }]);
  });

  it("shows unclosed math as written until it closes", () => {
    expect(mathIn("Partial \\(x^")).toEqual([]);
    expect(blocks("$$\nE = mc")).toEqual([["p", "$$\nE = mc"]]);
    expect(blocks("$$\n$$")).toEqual([["p", "$$\n$$"]]);
    expect(blocks("> $$\n> x\n\nafter")).toEqual([
      ["blockquote", "\n$$\nx\n"],
      ["p", "after"],
    ]);
  });

  it("parses every streaming prefix of an answer", () => {
    const answer = [
      "The roots of \\(ax^2 + bx + c\\) are",
      "$$",
      "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
      "$$",
      "> \\[ \\Delta = b^2 - 4ac \\]",
      "- costs $5, see `$$` and \\[1\\]",
    ].join("\n");
    for (let end = 0; end <= answer.length; end++) render(answer.slice(0, end));
    expect(mathIn(answer)).toEqual([
      { display: "inline", tex: "ax^2 + bx + c" },
      { display: "block", tex: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}" },
      { display: "block", tex: "\\Delta = b^2 - 4ac" },
    ]);
  });
});
