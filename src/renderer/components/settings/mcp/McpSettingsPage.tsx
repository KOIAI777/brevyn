import { CheckCircle2, Database, FileSearch, FileText, Network, Plus, Search, Server, ShieldCheck } from "lucide-react";
import { BREVYN_MCP_SERVER, BREVYN_MCP_TOOLS, type BrevynMcpToolIcon } from "../../../../shared/brevyn-mcp-catalog";

export function McpSettingsPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <section className="settings-solid-card rounded-[var(--radius-panel)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Server className="h-4 w-4 text-muted-foreground" />
              <span>{BREVYN_MCP_SERVER.displayName}</span>
            </div>
            <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
              {BREVYN_MCP_SERVER.description}
            </div>
          </div>
          <div className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-[hsl(var(--status-success)/0.14)] px-2.5 text-[11px] font-semibold text-[hsl(var(--status-success))] shadow-sm ring-1 ring-[hsl(var(--status-success)/0.2)]">
            <CheckCircle2 className="h-3.5 w-3.5" />
            已启用
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <McpMetric label="服务器" value={BREVYN_MCP_SERVER.name} />
          <McpMetric label="传输" value={BREVYN_MCP_SERVER.transportLabel} />
          <McpMetric label="工具" value={`${BREVYN_MCP_TOOLS.length} 个`} />
        </div>
      </section>

      <section className="settings-solid-card rounded-[var(--radius-panel)] p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <span>内置工具</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {BREVYN_MCP_TOOLS.map((tool) => (
            <div key={tool.name} className="rounded-[var(--radius-card)] border bg-background px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-muted text-muted-foreground">
                  <McpToolIcon name={tool.icon} />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-foreground">{tool.label}</div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{tool.name}</div>
                </div>
              </div>
              <div className="mt-2 text-[11px] leading-5 text-muted-foreground">{tool.description}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-solid-card rounded-[var(--radius-panel)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Plus className="h-4 w-4 text-muted-foreground" />
              <span>自定义 MCP</span>
            </div>
            <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
              后续支持 stdio、HTTP、SSE 服务器配置和连接测试。
            </div>
          </div>
          <span className="rounded-[var(--radius-control)] bg-muted px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
            暂未开放
          </span>
        </div>
      </section>
    </div>
  );
}

function McpToolIcon({ name }: { name: BrevynMcpToolIcon }) {
  const className = "h-3.5 w-3.5";
  if (name === "network") return <Network className={className} />;
  if (name === "fileSearch") return <FileSearch className={className} />;
  if (name === "search") return <Search className={className} />;
  if (name === "database") return <Database className={className} />;
  return <FileText className={className} />;
}

function McpMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="brevyn-control-surface px-3 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs font-semibold text-foreground" title={value}>{value}</div>
    </div>
  );
}
