import { isValidElement, memo, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FilePathChip, isFilePathLike } from "./FilePathChip";
import type { AppCodeThemePreference, AppTheme } from "@/types/domain";

const remarkPlugins = [remarkGfm];
const LONG_MARKDOWN_CODE_LIMIT = 16_000;
const LONG_MARKDOWN_CODE_LINES = 220;
const STREAM_PLAYBACK_FAST_BACKLOG = 720;
const STREAM_PLAYBACK_MEDIUM_BACKLOG = 240;
const STREAM_PLAYBACK_LARGE_STEP = 28;
const STREAM_PLAYBACK_MEDIUM_STEP = 16;
const STREAM_PLAYBACK_SMALL_STEP = 8;
const STREAM_INLINE_ANIMATION_LIMIT = 72;
const SHIKI_THEME_BY_CODE_THEME: Record<AppCodeThemePreference, Record<AppTheme, string>> = {
  brevyn: { light: "vitesse-light", dark: "vitesse-dark" },
  github: { light: "github-light", dark: "github-dark" },
  rose: { light: "rose-pine-dawn", dark: "rose-pine-moon" },
  mono: { light: "min-light", dark: "min-dark" },
};
const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  shell: "bash",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  py: "python",
  rb: "ruby",
};
const SHIKI_SUPPORTED_LANGUAGES = new Set([
  "bash",
  "css",
  "diff",
  "html",
  "javascript",
  "json",
  "markdown",
  "python",
  "sql",
  "tsx",
  "typescript",
  "xml",
  "yaml",
]);
const highlightedCodeCache = new Map<string, string>();
let shikiCodeToHtmlPromise: Promise<ShikiCodeToHtml> | null = null;

type ShikiCodeToHtml = (code: string, options: {
  lang: string;
  theme: string;
  transformers?: Array<{
    pre?: (node: { properties: Record<string, unknown> }) => void;
  }>;
}) => Promise<string>;

type MarkdownNode = {
  position?: {
    start?: {
      line?: number;
      column?: number;
      offset?: number;
    };
  };
};

type MarkdownComponentProps<T extends keyof JSX.IntrinsicElements> = ComponentProps<T> & {
  node?: MarkdownNode;
};

interface MarkdownishProps {
  content: string;
  threadId?: string;
  preserveSoftBreaks?: boolean;
  streaming?: boolean;
}

type RenderMarkdownChildren = (children: ReactNode, path: string) => ReactNode;
interface StreamingMarkdownBlock {
  key: string;
  content: string;
  startOffset: number;
}

const passthroughChildren: RenderMarkdownChildren = (children) => children;

export const Markdownish = memo(function Markdownish({
  content,
  threadId,
  preserveSoftBreaks = false,
  streaming = false,
}: MarkdownishProps) {
  if (streaming) {
    return (
      <StreamingMarkdownishRenderer
        content={content}
        preserveSoftBreaks={preserveSoftBreaks}
        threadId={threadId}
      />
    );
  }

  return (
    <StaticMarkdownishRenderer
      content={content}
      preserveSoftBreaks={preserveSoftBreaks}
      threadId={threadId}
    />
  );
});

const StaticMarkdownishRenderer = memo(function StaticMarkdownishRenderer({
  content,
  threadId,
  preserveSoftBreaks,
}: Required<Pick<MarkdownishProps, "content" | "preserveSoftBreaks">> & Pick<MarkdownishProps, "threadId">) {
  const components = useMemo(
    () => createMarkdownComponents({ preserveSoftBreaks, renderChildren: passthroughChildren, threadId }),
    [preserveSoftBreaks, threadId],
  );

  return <MarkdownishFrame content={content} components={components} />;
}, areMarkdownishRenderPropsEqual);

const StreamingMarkdownishRenderer = memo(function StreamingMarkdownishRenderer({
  content,
  threadId,
  preserveSoftBreaks,
}: Required<Pick<MarkdownishProps, "content" | "preserveSoftBreaks">> & Pick<MarkdownishProps, "threadId">) {
  const displayContent = useStreamingDisplayContent(content);
  const blocks = useMemo(() => splitStreamingMarkdownBlocks(displayContent), [displayContent]);

  return (
    <StreamingBlockMarkdownishRenderer
      blocks={blocks}
      preserveSoftBreaks={preserveSoftBreaks}
      threadId={threadId}
    />
  );
}, areMarkdownishRenderPropsEqual);

const StreamingBlockMarkdownishRenderer = memo(function StreamingBlockMarkdownishRenderer({
  blocks,
  threadId,
  preserveSoftBreaks,
}: {
  blocks: StreamingMarkdownBlock[];
} & Required<Pick<MarkdownishProps, "preserveSoftBreaks">> & Pick<MarkdownishProps, "threadId">) {
  return (
    <div className="markdownish-stream-blocks">
      {blocks.map((block, index) => {
        const streaming = index === blocks.length - 1;
        return (
          <div key={block.key} className="markdownish-stream-block">
            {streaming ? (
              <StreamingPlainTextBlock
                content={block.content}
                preserveSoftBreaks={preserveSoftBreaks}
              />
            ) : (
              <StaticMarkdownishRenderer
                content={block.content}
                preserveSoftBreaks={preserveSoftBreaks}
                threadId={threadId}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}, areStreamingBlockRenderPropsEqual);

function useStreamingDisplayContent(content: string): string {
  const [displayContent, setDisplayContent] = useState(content);
  const displayContentRef = useRef(content);
  const targetContentRef = useRef(content);

  useEffect(() => {
    targetContentRef.current = content;
    let frame = 0;
    let cancelled = false;

    function tick() {
      if (cancelled) return;
      const target = targetContentRef.current;
      const current = displayContentRef.current;
      if (!target.startsWith(current)) {
        displayContentRef.current = target;
        setDisplayContent(target);
        return;
      }

      const backlog = target.length - current.length;
      if (backlog <= 0) return;

      const step = playbackStep(backlog);
      const next = advanceByCodePoints(target, current.length, step);
      displayContentRef.current = next;
      setDisplayContent(next);
      frame = window.requestAnimationFrame(tick);
    }

    frame = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [content]);

  return displayContent;
}

function playbackStep(backlog: number): number {
  if (backlog >= STREAM_PLAYBACK_FAST_BACKLOG) return STREAM_PLAYBACK_LARGE_STEP;
  if (backlog >= STREAM_PLAYBACK_MEDIUM_BACKLOG) return STREAM_PLAYBACK_MEDIUM_STEP;
  return STREAM_PLAYBACK_SMALL_STEP;
}

function advanceByCodePoints(value: string, start: number, count: number): string {
  let index = start;
  let remaining = count;
  while (index < value.length && remaining > 0) {
    const codePoint = value.codePointAt(index);
    index += codePoint && codePoint > 0xffff ? 2 : 1;
    remaining -= 1;
  }
  return value.slice(0, index);
}

const StreamingPlainTextBlock = memo(function StreamingPlainTextBlock({
  content,
  preserveSoftBreaks,
}: Required<Pick<MarkdownishProps, "content" | "preserveSoftBreaks">>) {
  const previousContentRef = useRef("");
  const previousContent = previousContentRef.current;

  useEffect(() => {
    previousContentRef.current = content;
  }, [content]);

  return (
    <div className="markdownish markdownish-streaming-tail min-w-0 w-full max-w-full overflow-hidden whitespace-pre-wrap break-words text-sm leading-6">
      <StreamingInlineText previousText={previousContent} text={content} />
    </div>
  );
}, (previous, next) => previous.content === next.content && previous.preserveSoftBreaks === next.preserveSoftBreaks);

function splitStreamingMarkdownBlocks(content: string): StreamingMarkdownBlock[] {
  const lines = content.split("\n");
  const blocks: StreamingMarkdownBlock[] = [];
  let current: string[] = [];
  let currentStartOffset = 0;
  let lineStartOffset = 0;
  let inFence = false;

  function pushCurrent() {
    const blockContent = current.join("\n").trimEnd();
    if (blockContent.trim()) {
      blocks.push({
        key: `block:${currentStartOffset}`,
        content: blockContent,
        startOffset: currentStartOffset,
      });
    }
    current = [];
  }

  for (const line of lines) {
    if (current.length === 0) currentStartOffset = lineStartOffset;
    current.push(line);

    if (isFenceLine(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") pushCurrent();

    lineStartOffset += line.length + 1;
  }

  pushCurrent();
  return blocks;
}

function isFenceLine(line: string): boolean {
  return line.trimStart().startsWith("```");
}

function areStreamingBlockRenderPropsEqual(
  previous: {
    blocks: StreamingMarkdownBlock[];
  } & Required<Pick<MarkdownishProps, "preserveSoftBreaks">> & Pick<MarkdownishProps, "threadId">,
  next: {
    blocks: StreamingMarkdownBlock[];
  } & Required<Pick<MarkdownishProps, "preserveSoftBreaks">> & Pick<MarkdownishProps, "threadId">,
): boolean {
  return previous.blocks.length === next.blocks.length
    && previous.preserveSoftBreaks === next.preserveSoftBreaks
    && previous.threadId === next.threadId
    && previous.blocks.every((block, index) => {
      const nextBlock = next.blocks[index];
      return Boolean(nextBlock) && block.key === nextBlock.key && block.content === nextBlock.content;
    });
}

function createMarkdownComponents({
  preserveSoftBreaks,
  renderChildren,
  threadId,
}: {
  preserveSoftBreaks: boolean;
  renderChildren: RenderMarkdownChildren;
  threadId?: string;
}) {
  return {
    h1: ({ children, node, ...props }: MarkdownComponentProps<"h1">) => (
      <h2 className="mb-2 mt-4 text-base font-semibold tracking-tight first:mt-0" {...props}>
        {renderChildren(children, blockPath("h1", node))}
      </h2>
    ),
    h2: ({ children, node, ...props }: MarkdownComponentProps<"h2">) => (
      <h3 className="mb-2 mt-4 text-sm font-semibold tracking-tight first:mt-0" {...props}>
        {renderChildren(children, blockPath("h2", node))}
      </h3>
    ),
    h3: ({ children, node, ...props }: MarkdownComponentProps<"h3">) => (
      <h4 className="mb-2 mt-3 text-sm font-semibold tracking-tight first:mt-0" {...props}>
        {renderChildren(children, blockPath("h3", node))}
      </h4>
    ),
    p: ({ children, node, ...props }: MarkdownComponentProps<"p">) => (
      <p className={`my-2 leading-6 first:mt-0 last:mb-0 ${preserveSoftBreaks ? "whitespace-pre-wrap" : ""}`} {...props}>
        {renderChildren(children, blockPath("p", node))}
      </p>
    ),
    ul: ({ children, ...props }: ComponentProps<"ul">) => (
      <ul className="my-2 list-disc space-y-1 pl-5 leading-6" {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ...props }: ComponentProps<"ol">) => (
      <ol className="my-2 list-decimal space-y-1 pl-8 leading-6 marker:tabular-nums" {...props}>
        {children}
      </ol>
    ),
    li: ({ children, node, ...props }: MarkdownComponentProps<"li">) => (
      <li className="pl-0.5" {...props}>
        {renderChildren(children, blockPath("li", node))}
      </li>
    ),
    blockquote: ({ children, ...props }: ComponentProps<"blockquote">) => (
      <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground" {...props}>
        {children}
      </blockquote>
    ),
    hr: () => null,
    a: ({ children, node, ...props }: MarkdownComponentProps<"a">) => (
      <a className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground" {...props}>
        {renderChildren(children, blockPath("a", node))}
      </a>
    ),
    code: ({ className, children, node, ...props }: MarkdownComponentProps<"code">) => {
      const isBlock = /language-/.test(className || "");
      if (!isBlock) {
        const text = inlineText(children);
        if (text && isFilePathLike(text)) {
          return <FilePathChip filePath={text.trim()} threadId={threadId} />;
        }
        return (
          <code className="brevyn-inline-code break-words" {...props}>
            {renderChildren(children, blockPath("code", node))}
          </code>
        );
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children, ...props }: ComponentProps<"pre">) => (
      <MarkdownCodePre {...props}>{children}</MarkdownCodePre>
    ),
    table: ({ children, ...props }: ComponentProps<"table">) => (
      <div className="my-3 min-w-0 w-full max-w-full overflow-x-auto rounded-xl border bg-background/60">
        <table className="w-full border-collapse text-left text-xs" {...props}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children, ...props }: ComponentProps<"thead">) => (
      <thead className="bg-muted/45 text-muted-foreground" {...props}>
        {children}
      </thead>
    ),
    th: ({ children, node, ...props }: MarkdownComponentProps<"th">) => (
      <th className="border-b px-3 py-2 font-semibold" {...props}>
        {renderChildren(children, blockPath("th", node))}
      </th>
    ),
    tr: ({ children, ...props }: ComponentProps<"tr">) => (
      <tr className="border-b last:border-b-0" {...props}>
        {children}
      </tr>
    ),
    td: ({ children, node, ...props }: MarkdownComponentProps<"td">) => (
      <td className="px-3 py-2 align-top" {...props}>
        {renderChildren(children, blockPath("td", node))}
      </td>
    ),
  };
}

function MarkdownCodePre({ children, ...props }: ComponentProps<"pre">) {
  const [expanded, setExpanded] = useState(false);
  const text = textContent(children);
  const preview = text && !expanded ? truncateLongText(text, LONG_MARKDOWN_CODE_LIMIT, LONG_MARKDOWN_CODE_LINES) : null;
  const code = preview ?? text;
  const truncated = Boolean(preview && preview !== text);
  const language = codeLanguage(children);
  const { html, loading } = useHighlightedCode(code, language);

  return (
    <div className="brevyn-code-shell my-3 min-w-0 max-w-full overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--code-border)] px-3 py-1.5">
        <div className="brevyn-code-label min-w-0 truncate font-mono text-[10px] font-medium uppercase tracking-[0.16em]">
          {language || "text"}
        </div>
        {loading && <div className="brevyn-code-label shrink-0 text-[10px]">正在高亮</div>}
      </div>
      {html ? (
        <div
          className="max-h-96 max-w-full overflow-auto p-3 [contain:layout_paint_style] brevyn-scrollbar-thin"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="brevyn-code-pre max-h-96 max-w-full overflow-auto p-3 [contain:layout_paint_style] brevyn-scrollbar-thin" {...props}>
          <code>{code}</code>
        </pre>
      )}
      {truncated && (
        <button
          type="button"
          className="w-full border-t border-[var(--code-border)] bg-transparent px-3 py-2 text-left text-[11px] font-medium text-[var(--code-muted)] transition hover:text-[var(--code-fg)]"
          onClick={() => setExpanded(true)}
        >
          展开完整代码块
        </button>
      )}
    </div>
  );
}

function MarkdownishFrame({ content, components }: { content: string; components: ComponentProps<typeof Markdown>["components"] }) {
  return (
    <div className="markdownish min-w-0 w-full max-w-full overflow-hidden break-words text-sm leading-6">
      <Markdown
        remarkPlugins={remarkPlugins}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
}

function areMarkdownishRenderPropsEqual(
  previous: Required<Pick<MarkdownishProps, "content" | "preserveSoftBreaks">> & Pick<MarkdownishProps, "threadId">,
  next: Required<Pick<MarkdownishProps, "content" | "preserveSoftBreaks">> & Pick<MarkdownishProps, "threadId">,
): boolean {
  return previous.content === next.content
    && previous.preserveSoftBreaks === next.preserveSoftBreaks
    && previous.threadId === next.threadId;
}

function StreamingInlineText({ previousText, text }: { previousText: string; text: string }) {
  const canAnimateDelta = text.startsWith(previousText);
  const stableText = canAnimateDelta ? previousText : "";
  const delta = canAnimateDelta ? text.slice(previousText.length) : text;
  const deltaChars = Array.from(delta);

  if (!deltaChars.length) return stableText;
  const animatedChars = deltaChars.slice(-STREAM_INLINE_ANIMATION_LIMIT);
  const immediateDelta = deltaChars.slice(0, Math.max(0, deltaChars.length - animatedChars.length)).join("");
  return (
    <>
      {stableText}
      {immediateDelta}
      {animatedChars.map((char, index) => (
        <span
          key={`${index}-${char}`}
          className="brevyn-stream-inline-char"
          style={{ animationDelay: `${Math.min(index, 18) * 5}ms` }}
        >
          {char}
        </span>
      ))}
    </>
  );
}

function blockPath(kind: string, node?: MarkdownNode): string {
  const start = node?.position?.start;
  return `${kind}:${start?.offset ?? `${start?.line ?? 0}:${start?.column ?? 0}`}`;
}

function inlineText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(inlineText).join("");
  return "";
}

function useHighlightedCode(code: string, language: string): { html: string; loading: boolean } {
  const [state, setState] = useState<{ key: string; html: string; loading: boolean }>({ key: "", html: "", loading: false });
  const themeKey = useCodeThemeKey();
  const normalizedLanguage = normalizeShikiLanguage(language);
  const cacheKey = `${themeKey}:${normalizedLanguage}:${code}`;

  useEffect(() => {
    let cancelled = false;
    if (!code.trim()) {
      setState({ key: cacheKey, html: "", loading: false });
      return () => {
        cancelled = true;
      };
    }
    const cached = highlightedCodeCache.get(cacheKey);
    if (cached) {
      setState({ key: cacheKey, html: cached, loading: false });
      return () => {
        cancelled = true;
      };
    }
    setState((current) => current.key === cacheKey
      ? { ...current, loading: true }
      : { key: cacheKey, html: "", loading: true });
    void highlightCode(code, normalizedLanguage, themeKey)
      .then((html) => {
        if (cancelled) return;
        if (highlightedCodeCache.size > 160) {
          const oldestKey = highlightedCodeCache.keys().next().value;
          if (oldestKey) highlightedCodeCache.delete(oldestKey);
        }
        highlightedCodeCache.set(cacheKey, html);
        setState({ key: cacheKey, html, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ key: cacheKey, html: "", loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, code, normalizedLanguage, themeKey]);

  return state.key === cacheKey ? { html: state.html, loading: state.loading } : { html: "", loading: true };
}

function useCodeThemeKey(): string {
  const [themeKey, setThemeKey] = useState(() => currentShikiThemeKey());
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setThemeKey(currentShikiThemeKey());
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-code-theme"] });
    return () => observer.disconnect();
  }, []);
  return themeKey;
}

async function highlightCode(code: string, language: string, theme: string): Promise<string> {
  const codeToHtml = await shikiCodeToHtml();
  return codeToHtml(code, {
    lang: language,
    theme,
    transformers: [
      {
        pre(node) {
          node.properties.class = "brevyn-code-pre";
          node.properties.style = "";
        },
      },
    ],
  });
}

function shikiCodeToHtml(): Promise<ShikiCodeToHtml> {
  if (!shikiCodeToHtmlPromise) {
    shikiCodeToHtmlPromise = createShikiCodeToHtml();
  }
  return shikiCodeToHtmlPromise;
}

async function createShikiCodeToHtml(): Promise<ShikiCodeToHtml> {
  const [
    { createBundledHighlighter, createSingletonShorthands },
    { createJavaScriptRegexEngine },
  ] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]);
  const createHighlighter = createBundledHighlighter({
    langs: {
      bash: () => import("@shikijs/langs/bash"),
      css: () => import("@shikijs/langs/css"),
      diff: () => import("@shikijs/langs/diff"),
      html: () => import("@shikijs/langs/html"),
      javascript: () => import("@shikijs/langs/javascript"),
      json: () => import("@shikijs/langs/json"),
      markdown: () => import("@shikijs/langs/markdown"),
      python: () => import("@shikijs/langs/python"),
      sql: () => import("@shikijs/langs/sql"),
      tsx: () => import("@shikijs/langs/tsx"),
      typescript: () => import("@shikijs/langs/typescript"),
      xml: () => import("@shikijs/langs/xml"),
      yaml: () => import("@shikijs/langs/yaml"),
    },
    themes: {
      "github-dark": () => import("@shikijs/themes/github-dark"),
      "github-light": () => import("@shikijs/themes/github-light"),
      "min-dark": () => import("@shikijs/themes/min-dark"),
      "min-light": () => import("@shikijs/themes/min-light"),
      "rose-pine-dawn": () => import("@shikijs/themes/rose-pine-dawn"),
      "rose-pine-moon": () => import("@shikijs/themes/rose-pine-moon"),
      "vitesse-dark": () => import("@shikijs/themes/vitesse-dark"),
      "vitesse-light": () => import("@shikijs/themes/vitesse-light"),
    },
    engine: () => createJavaScriptRegexEngine(),
  });
  return createSingletonShorthands(createHighlighter).codeToHtml as ShikiCodeToHtml;
}

function currentShikiThemeKey(): string {
  const appTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const codeTheme = normalizeCodeTheme(document.documentElement.dataset.codeTheme);
  return SHIKI_THEME_BY_CODE_THEME[codeTheme][appTheme];
}

function normalizeCodeTheme(value: unknown): AppCodeThemePreference {
  return value === "github" || value === "rose" || value === "mono" || value === "brevyn" ? value : "brevyn";
}

function normalizeShikiLanguage(value: string): string {
  const language = value.trim().toLowerCase();
  if (!language) return "text";
  const normalized = SHIKI_LANGUAGE_ALIASES[language] || language;
  return SHIKI_SUPPORTED_LANGUAGES.has(normalized) ? normalized : "text";
}

function codeLanguage(value: ReactNode): string {
  if (Array.isArray(value)) {
    for (const child of value) {
      const language = codeLanguage(child);
      if (language) return language;
    }
    return "";
  }
  if (!isValidElement(value)) return "";
  const element = value as ReactElement<{ className?: string; children?: ReactNode }>;
  const className = element.props.className || "";
  const match = /(?:^|\s)language-([\w-]+)/.exec(className);
  if (match?.[1]) return match[1];
  return codeLanguage(element.props.children);
}

function textContent(value: ReactNode): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (isValidElement(value)) {
    const element = value as ReactElement<{ children?: ReactNode }>;
    return textContent(element.props.children);
  }
  return "";
}

function truncateLongText(value: string, maxChars: number, maxLines: number): string {
  if (value.length <= maxChars && lineCount(value) <= maxLines) return value;
  const byChars = value.slice(0, maxChars);
  const lines = byChars.split("\n");
  const preview = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : byChars;
  return `${preview.trimEnd()}\n\n... 已截断长内容，展开后查看完整内容`;
}

function lineCount(value: string): number {
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}
