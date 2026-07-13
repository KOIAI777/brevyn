import type { ComponentProps } from "react";
import { ExternalLink } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { GitHubRelease } from "@/types/domain";
import { cx } from "@/lib/cn";
import { formatReleaseDate } from "./releaseFormat";

const remarkPlugins = [remarkGfm];

type ReleaseMarkdownProps = {
  body: string;
  maxHeightClassName?: string;
};

export function ReleaseMarkdown({ body, maxHeightClassName = "max-h-64" }: ReleaseMarkdownProps) {
  return (
    <div className={cx("overflow-y-auto pr-1 text-muted-foreground brevyn-scrollbar", maxHeightClassName)}>
      <Markdown
        remarkPlugins={remarkPlugins}
        components={{
          h1: ({ children, ...props }: ComponentProps<"h1">) => <h3 className="mb-2 mt-3 text-sm font-semibold text-foreground first:mt-0" {...props}>{children}</h3>,
          h2: ({ children, ...props }: ComponentProps<"h2">) => <h4 className="mb-2 mt-3 text-sm font-semibold text-foreground first:mt-0" {...props}>{children}</h4>,
          h3: ({ children, ...props }: ComponentProps<"h3">) => <h5 className="mb-2 mt-3 text-xs font-semibold text-foreground first:mt-0" {...props}>{children}</h5>,
          p: ({ children, ...props }: ComponentProps<"p">) => <p className="my-2 text-xs leading-5 first:mt-0 last:mb-0" {...props}>{children}</p>,
          ul: ({ children, ...props }: ComponentProps<"ul">) => <ul className="my-2 list-disc space-y-1 pl-5 text-xs leading-5" {...props}>{children}</ul>,
          ol: ({ children, ...props }: ComponentProps<"ol">) => <ol className="my-2 list-decimal space-y-1 pl-5 text-xs leading-5" {...props}>{children}</ol>,
          li: ({ children, ...props }: ComponentProps<"li">) => <li className="pl-0.5" {...props}>{children}</li>,
          blockquote: ({ children, ...props }: ComponentProps<"blockquote">) => (
            <blockquote className="my-3 border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground" {...props}>{children}</blockquote>
          ),
          a: ({ href, children, ...props }: ComponentProps<"a">) => (
            <a
              className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href?.startsWith("http://") || href?.startsWith("https://")) {
                  void window.brevyn.app.openExternal(href);
                }
              }}
              {...props}
            >
              {children}
            </a>
          ),
          code: ({ className, children, ...props }: ComponentProps<"code">) => {
            const isBlock = /language-/.test(className || "");
            return (
              <code className={cx(isBlock ? className : "rounded-md bg-muted px-1.5 py-0.5 text-[0.92em]", className)} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...props }: ComponentProps<"pre">) => (
            <pre className="my-3 overflow-x-auto rounded-xl border bg-muted/35 p-3 text-[12px] leading-5 text-foreground" {...props}>{children}</pre>
          ),
          table: ({ children, ...props }: ComponentProps<"table">) => (
            <div className="my-3 overflow-x-auto rounded-xl border bg-background/60">
              <table className="w-full border-collapse text-left text-xs" {...props}>{children}</table>
            </div>
          ),
          th: ({ children, ...props }: ComponentProps<"th">) => <th className="border-b px-3 py-2 font-semibold text-foreground" {...props}>{children}</th>,
          td: ({ children, ...props }: ComponentProps<"td">) => <td className="border-b px-3 py-2 align-top last:border-b-0" {...props}>{children}</td>,
          hr: () => <div className="my-3 border-t" />,
        }}
      >
        {body || "这个版本还没有填写更新说明。"}
      </Markdown>
    </div>
  );
}

export function ReleaseNotesViewer({
  release,
  compact = false,
  showHeader = true,
}: {
  release: GitHubRelease;
  compact?: boolean;
  showHeader?: boolean;
}) {
  const title = release.name || release.tagName || "Release";
  return (
    <div className="space-y-3">
      {showHeader ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
              {release.prerelease ? <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">预发布</span> : null}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{formatReleaseDate(release.publishedAt)}</p>
          </div>
          {release.htmlUrl ? (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
              onClick={() => void window.brevyn.app.openExternal(release.htmlUrl)}
            >
              GitHub
              <ExternalLink className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      ) : null}
      <ReleaseMarkdown body={release.body || "这个版本还没有填写更新说明。"} maxHeightClassName={compact ? "max-h-52" : "max-h-72"} />
    </div>
  );
}
