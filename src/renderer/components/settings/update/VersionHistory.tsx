import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink, RefreshCw } from "lucide-react";
import type { GitHubRelease } from "@/types/domain";
import { cx } from "@/lib/cn";
import { formatReleaseDate } from "./releaseFormat";
import { ReleaseNotesViewer } from "./ReleaseNotesViewer";

export function VersionHistory() {
  const [releases, setReleases] = useState<GitHubRelease[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedReleaseIds, setExpandedReleaseIds] = useState<Record<number, boolean>>({});

  useEffect(() => {
    void loadReleases();
  }, []);

  async function loadReleases() {
    setLoading(true);
    setError("");
    try {
      const next = await window.brevyn.updater.listReleases({ perPage: 5, includePrerelease: false });
      setReleases(next);
    } catch (reason) {
      setError(errorMessage(reason, "加载版本历史失败。"));
    } finally {
      setLoading(false);
    }
  }

  function toggleRelease(releaseId: number) {
    setExpandedReleaseIds((current) => ({ ...current, [releaseId]: !current[releaseId] }));
  }

  return (
    <section className="rounded-[var(--radius-panel)] border border-border/55 bg-background/70 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">版本历史</h3>
          <p className="mt-1 text-xs text-muted-foreground">从 GitHub Releases 读取最近发布记录。</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border bg-card px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void loadReleases()}
          disabled={loading}
        >
          <RefreshCw className={cx("h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </button>
      </div>
      {error ? <p className="px-5 py-3 text-xs text-destructive">{error}</p> : null}
      <div className="divide-y">
        {loading && releases.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">正在加载版本历史...</div>
        ) : releases.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-muted-foreground">暂无版本历史。发布 GitHub Release 后会显示在这里。</div>
        ) : (
          releases.map((release, index) => {
            const expanded = Boolean(expandedReleaseIds[release.id]);
            return (
              <div key={release.id} className="px-5 py-3">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-[var(--radius-control)] py-2 text-left transition hover:bg-muted/45"
                  onClick={() => toggleRelease(release.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-sm font-semibold text-foreground">{release.tagName}</span>
                      {index === 0 ? <span className="rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-semibold text-background">最新</span> : null}
                      {release.prerelease ? <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">预发布</span> : null}
                    </span>
                    {release.name && release.name !== release.tagName ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{release.name}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatReleaseDate(release.publishedAt)}</span>
                  <ChevronDown className={cx("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
                </button>
                {expanded ? (
                  <div className="mt-3 rounded-[var(--radius-control)] border bg-card p-3">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-muted-foreground">{release.assets.length} 个附件</span>
                      {release.htmlUrl ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
                          onClick={() => void window.brevyn.app.openExternal(release.htmlUrl)}
                        >
                          打开 Release
                          <ExternalLink className="h-3 w-3" />
                        </button>
                      ) : null}
                    </div>
                    <ReleaseNotesViewer release={release} showHeader={false} compact />
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function errorMessage(error: unknown, fallback = "操作失败。"): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
