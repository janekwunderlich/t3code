import { markdownLineEnding, markdownSpace } from "micromark-util-character";
import type {
  Code,
  Construct,
  Effects,
  Extension,
  State,
  Token,
  TokenizeContext,
  TokenType,
} from "micromark-util-types";
import type { Processor } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    mathFlow: "mathFlow";
    mathFlowFence: "mathFlowFence";
    mathFlowValue: "mathFlowValue";
    mathText: "mathText";
    mathTextData: "mathTextData";
    mathSequence: "mathSequence";
  }
}

/**
 * TeX math for chat Markdown, tokenized with the same precedence rules as code.
 *
 * Only delimiters that do not occur in ordinary prose are recognized, and each
 * keeps its TeX meaning: `\(…\)` is inline, `$$…$$` and `\[…\]` are display.
 * Single `$` is deliberately unsupported because prices and shell variables use
 * it. `\[` must start a line, since `\[1\]` is also how Markdown escapes brackets.
 *
 * Display math that starts a line behaves like a fenced code block: it can
 * interrupt a paragraph and, while unclosed, runs to the end of its container.
 * Inline math never crosses a backtick, so code spans keep their precedence.
 */

const DOLLAR = 36;
const LEFT_PAREN = 40;
const RIGHT_PAREN = 41;
const LEFT_BRACKET = 91;
const BACKSLASH = 92;
const RIGHT_BRACKET = 93;
const GRAVE_ACCENT = 96;

type Delimiters = readonly [opening: number, closing: readonly [number, number]];

const DOLLARS: Delimiters = [DOLLAR, [DOLLAR, DOLLAR]];
const PARENS: Delimiters = [LEFT_PAREN, [BACKSLASH, RIGHT_PAREN]];
const BRACKETS: Delimiters = [LEFT_BRACKET, [BACKSLASH, RIGHT_BRACKET]];

/** `block` is display math that stands alone between other blocks, like a code fence. */
export type MarkdownMathDisplay = "inline" | "display" | "block";

/** Cheap gate so messages without a delimiter skip the math grammar entirely. */
export function mayContainMarkdownMath(markdown: string): boolean {
  return markdown.includes("$$") || markdown.includes("\\(") || markdown.includes("\\[");
}

function isLineEnd(code: Code): boolean {
  return code === null || markdownLineEnding(code);
}

function spaces(effects: Effects, next: State): State {
  const inside: State = (code) => {
    if (markdownSpace(code)) {
      effects.consume(code);
      return inside;
    }
    effects.exit("whitespace");
    return next(code);
  };
  return (code) => {
    if (!markdownSpace(code)) return next(code);
    effects.enter("whitespace");
    return inside(code);
  };
}

/** Opens `$$`, `\(` or `\[`. A third `$` makes it something else, as with code fences. */
function openingSequence(effects: Effects, delimiters: Delimiters, next: State, nok: State): State {
  return (code) => {
    effects.enter("mathSequence");
    effects.consume(code);
    return (second) => {
      if (second !== delimiters[0]) return nok(second);
      effects.consume(second);
      return (after) => {
        if (delimiters === DOLLARS && after === DOLLAR) return nok(after);
        effects.exit("mathSequence");
        return next(after);
      };
    };
  };
}

/** Matches `$$`, `\)` or `\]`; display fences must also end their line. */
function closingSequence(delimiters: Delimiters, fence: boolean): Construct {
  const [first, second] = delimiters[1];
  return {
    partial: true,
    tokenize(effects, ok, nok) {
      const trailing: State = (code) => {
        effects.exit("mathFlowFence");
        return isLineEnd(code) ? ok(code) : nok(code);
      };
      return (code) => {
        if (code !== first) return nok(code);
        if (fence) effects.enter("mathFlowFence");
        effects.enter("mathSequence");
        effects.consume(code);
        return (next) => {
          if (next !== second) return nok(next);
          effects.consume(next);
          return (after) => {
            if (delimiters === DOLLARS && after === DOLLAR) return nok(after);
            effects.exit("mathSequence");
            return fence ? spaces(effects, trailing)(after) : ok(after);
          };
        };
      };
    },
  };
}

/**
 * Formula text up to a possible closer. A backslash and the character after it
 * are read as one unit, the way TeX reads a control symbol, so `\\]` or `\$$`
 * never close a formula early.
 */
function valueChunk(
  effects: Effects,
  type: TokenType,
  delimiters: Delimiters,
  stops: (code: Code) => boolean,
  next: State,
): State {
  const end: State = (code) => {
    effects.exit(type);
    return next(code);
  };
  const character: State = (code) => {
    effects.consume(code);
    if (code !== BACKSLASH) return rest;
    return (escaped) => {
      if (stops(escaped)) return end(escaped);
      effects.consume(escaped);
      return rest;
    };
  };
  const rest: State = (code) =>
    stops(code) || code === delimiters[1][0] ? end(code) : character(code);
  return (code) => {
    effects.enter(type);
    return character(code);
  };
}

// A failed scan proves that later openers of the same kind cannot close before
// this offset either. Keep that knowledge on the content tokenizer, never across
// documents, so malformed/streaming input is scanned once instead of quadratically.
const failedMathText = new WeakMap<TokenizeContext, Partial<Record<number, number>>>();

function tokenizeMathText(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const stops = (code: Code) => isLineEnd(code) || code === GRAVE_ACCENT;
  let delimiters = DOLLARS;
  let close: Construct;
  let value: State;

  const between: State = (code) => {
    if (code === null || code === GRAVE_ACCENT) {
      const failed = failedMathText.get(this) ?? {};
      failed[delimiters[0]] = this.now().offset;
      failedMathText.set(this, failed);
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return between;
    }
    return effects.attempt(close, after, value)(code);
  };
  const after: State = (code) => {
    effects.exit("mathText");
    return ok(code);
  };

  return (code) => {
    delimiters = code === BACKSLASH ? PARENS : DOLLARS;
    if (this.now().offset < (failedMathText.get(this)?.[delimiters[0]] ?? -1)) return nok(code);
    close = closingSequence(delimiters, false);
    value = valueChunk(effects, "mathTextData", delimiters, stops, between);
    effects.enter("mathText");
    return openingSequence(effects, delimiters, between, nok)(code);
  };
}

const nonLazyContinuation: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    return (code) => {
      if (code === null) return nok(code);
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return (next) => (this.parser.lazy[this.now().line] ? nok(next) : ok(next));
    };
  },
};

function tokenizeMathFlow(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let delimiters = DOLLARS;
  let close: Construct;
  let closeMidLine: Construct;
  let value: State;
  let openingLine = true;
  let openingContent = false;

  const done: State = (code) => {
    effects.exit("mathFlow");
    return ok(code);
  };
  const lineEnd: State = (code) => {
    if (openingLine) {
      if (openingContent && delimiters === BRACKETS) return nok(code);
      // Interrupting a paragraph only needs the opening line, like a code fence.
      if (this.interrupt) return ok(code);
      openingLine = false;
    }
    if (code === null) return done(code);
    return effects.check(nonLazyContinuation, nextLine, done)(code);
  };
  const nextLine: State = (code) => {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return content;
  };
  const content: State = (code) => {
    if (isLineEnd(code)) return lineEnd(code);
    // A closer before the end of the opening line makes this inline math.
    const notClosed = openingLine ? effects.check(closeMidLine, nok, value) : value;
    return effects.attempt(close, done, notClosed)(code);
  };
  const afterOpening: State = (code) => {
    effects.exit("mathFlowFence");
    openingContent = !isLineEnd(code);
    return content(code);
  };

  return (code) => {
    delimiters = code === BACKSLASH ? BRACKETS : DOLLARS;
    close = closingSequence(delimiters, true);
    closeMidLine = closingSequence(delimiters, false);
    value = valueChunk(effects, "mathFlowValue", delimiters, isLineEnd, content);
    effects.enter("mathFlow");
    effects.enter("mathFlowFence");
    return openingSequence(effects, delimiters, spaces(effects, afterOpening), nok)(code);
  };
}

const MATH_SYNTAX: Extension = {
  flow: {
    [DOLLAR]: { name: "mathFlow", concrete: true, tokenize: tokenizeMathFlow },
    [BACKSLASH]: { name: "mathFlow", concrete: true, tokenize: tokenizeMathFlow },
  },
  text: {
    // Inside a longer run such as `$$$`, the middle `$$` opens nothing.
    [DOLLAR]: { name: "mathText", tokenize: tokenizeMathText, previous: (code) => code !== DOLLAR },
    [BACKSLASH]: { name: "mathText", tokenize: tokenizeMathText },
  },
};

interface MathNode {
  type: string;
  value?: string;
  children?: MathNode[];
  position?: {
    start: Pick<Token["start"], "line" | "column" | "offset">;
    end: Pick<Token["end"], "line" | "column" | "offset">;
  };
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    hChildren?: Array<{ type: "text"; value: string }>;
  };
  mathLines?: Array<{ line: number; text: string }>;
  mathFences?: number;
}

interface MathCompileContext {
  readonly stack: ReadonlyArray<object>;
  enter(node: { readonly type: string }, token: Token): void;
  exit(token: Token): void;
  sliceSerialize(token: Token): string;
}

function enterMath(this: MathCompileContext, token: Token) {
  const node: MathNode = { type: "math", mathLines: [], mathFences: 0 };
  this.enter(node, token);
}

// Value chunks are collected by line so container prefixes (`> `) never leak in.
function exitMathValue(this: MathCompileContext, token: Token) {
  const node = this.stack.at(-1) as MathNode | undefined;
  node?.mathLines?.push({ line: token.start.line, text: this.sliceSerialize(token) });
}

function exitMathFence(this: MathCompileContext) {
  const node = this.stack.at(-1) as MathNode | undefined;
  if (node?.mathFences !== undefined) node.mathFences += 1;
}

function mathValue(node: MathNode): string {
  let value = "";
  let line: number | undefined;
  for (const chunk of node.mathLines ?? []) {
    if (line !== undefined) value += "\n".repeat(chunk.line - line);
    value += chunk.text;
    line = chunk.line;
  }
  delete node.mathLines;
  delete node.mathFences;
  return value.trim();
}

/** Becomes `<code data-math>`, so anything that does not render math still sees code text. */
function finishMath(node: MathNode, value: string, display: MarkdownMathDisplay) {
  node.value = value;
  node.data = {
    hName: "code",
    hProperties: { dataMath: display },
    hChildren: [{ type: "text", value }],
  };
}

function exitMathText(this: MathCompileContext, token: Token) {
  const node = this.stack.at(-1) as MathNode | undefined;
  this.exit(token);
  if (!node) return;
  const source = this.sliceSerialize(token);
  const value = mathValue(node);
  if (value.length === 0) {
    node.type = "text";
    node.value = source;
    return;
  }
  node.type = "inlineMath";
  finishMath(node, value, source.startsWith("$$") ? "display" : "inline");
}

function exitMathFlow(this: MathCompileContext, token: Token) {
  const node = this.stack.at(-1) as MathNode | undefined;
  this.exit(token);
  if (!node) return;
  const closed = node.mathFences === 2;
  const value = mathValue(node);
  if (closed && value.length > 0) {
    finishMath(node, value, "block");
    return;
  }
  // Unclosed (usually still streaming) or empty: show what was written.
  node.type = "paragraph";
  const position = node.position;
  node.children = [
    {
      type: "text",
      value: this.sliceSerialize(token),
      // Incremental parsing shifts each node's positions independently.
      ...(position ? { position: { start: { ...position.start }, end: { ...position.end } } } : {}),
    },
  ];
}

/** Adds the math grammar. ChatMarkdown registers it only when the user opts in. */
function attachMath(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(MATH_SYNTAX);
  (data.fromMarkdownExtensions ??= []).push({
    enter: { mathFlow: enterMath, mathText: enterMath },
    exit: {
      mathFlow: exitMathFlow,
      mathFlowFence: exitMathFence,
      mathFlowValue: exitMathValue,
      mathText: exitMathText,
      mathTextData: exitMathValue,
    },
  });
}

export const remarkMath = attachMath;
