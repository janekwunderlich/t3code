import type { MarkdownMathDisplay } from "@t3tools/shared/markdownMath";
import { Suspense, memo, use } from "react";

import { RenderErrorBoundary } from "../RenderErrorBoundary";

type MathRenderer = typeof import("./markdownMathRenderer");

interface MathProps {
  readonly tex: string;
  readonly layout: MarkdownMathDisplay;
}

let mathRendererPromise: Promise<MathRenderer> | null = null;

// KaTeX and its stylesheet load only once a formula is actually shown.
function loadMathRenderer(): Promise<MathRenderer> {
  mathRendererPromise ??= import("./markdownMathRenderer").catch((error: unknown) => {
    mathRendererPromise = null;
    throw error;
  });
  return mathRendererPromise;
}

/** The Markdown that reproduces this formula, for copying. */
function mathMarkdown({ tex, layout }: MathProps): string {
  if (layout === "inline") return `\\(${tex}\\)`;
  return layout === "block" ? `$$\n${tex}\n$$\n\n` : `$$\n${tex}\n$$`;
}

function MathSource(props: MathProps) {
  const markdown = mathMarkdown(props);
  return (
    <code
      className="chat-markdown-math-source"
      data-display={props.layout === "inline" ? undefined : ""}
      data-markdown-copy={markdown}
    >
      {markdown.trimEnd()}
    </code>
  );
}

function TypesetMath(props: MathProps) {
  const display = props.layout !== "inline";
  const html = use(loadMathRenderer()).renderMathToHtml(props.tex, display);
  if (html === null) return <MathSource {...props} />;
  return (
    <span
      className="chat-markdown-math"
      data-display={display ? "" : undefined}
      data-markdown-copy={mathMarkdown(props)}
      role="math"
      aria-label={props.tex}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * A formula from the opt-in math syntax. It shows its source until KaTeX has
 * loaded and when KaTeX rejects it.
 */
export const MarkdownMath = memo(function MarkdownMath(props: MathProps) {
  const source = <MathSource {...props} />;
  return (
    <RenderErrorBoundary resetKeys={[props.tex, props.layout]} fallback={source}>
      <Suspense fallback={source}>
        <TypesetMath {...props} />
      </Suspense>
    </RenderErrorBoundary>
  );
});
