import { Plus, X, type LucideIcon } from "lucide-react";
import { useEffect, useState, type PointerEvent, type ReactNode } from "react";
import { RailResizeHandle } from "@/components/shell/RailResizeHandle";
import { cx } from "@/lib/cn";

export interface WorkspaceDockTab {
  id: string;
  label: string;
  icon: LucideIcon;
  closable?: boolean;
}

export function WorkspaceDock({
  collapsed,
  resizing,
  width,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onResizeStart,
  children,
}: {
  collapsed: boolean;
  resizing?: boolean;
  width: number;
  tabs: WorkspaceDockTab[];
  activeTabId: string;
  onSelectTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onAddTab?: () => void;
  onResizeStart: (event: PointerEvent) => void;
  children: ReactNode;
}) {
  const [renderContent, setRenderContent] = useState(!collapsed);

  useEffect(() => {
    if (!collapsed) {
      setRenderContent(true);
      return;
    }
    const timeout = window.setTimeout(() => setRenderContent(false), 500);
    return () => window.clearTimeout(timeout);
  }, [collapsed]);

  return (
    <aside aria-hidden={collapsed} className="relative h-full min-h-0 w-full min-w-0 overflow-hidden">
      <div
        className={cx(
          "group/rail absolute inset-y-0 right-0 flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border bg-card/85 shadow-sm ring-1 ring-border/60 transition-[box-shadow,border-color] duration-[480ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
          collapsed && "pointer-events-none border-transparent shadow-none ring-0",
          resizing && "select-none border-border/80 ring-foreground/10 transition-none",
        )}
        style={{ width }}
      >
        <RailResizeHandle collapsed={collapsed} resizing={resizing} label="调整资料宽度" onResizeStart={onResizeStart} />
        {renderContent ? (
          <>
            <WorkspaceDockTabBar
              tabs={tabs}
              activeTabId={activeTabId}
              onSelectTab={onSelectTab}
              onCloseTab={onCloseTab}
              onAddTab={onAddTab}
            />
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function WorkspaceDockTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onAddTab,
}: {
  tabs: WorkspaceDockTab[];
  activeTabId: string;
  onSelectTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onAddTab?: () => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5">
      <div role="tablist" aria-label="右侧工作区" className="flex min-w-0 items-center gap-1 overflow-x-auto brevyn-scrollbar">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const Icon = tab.icon;
          return (
            <div key={tab.id} className="group/tab relative min-w-0 shrink-0">
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className={cx(
                  "inline-flex h-8 max-w-44 min-w-0 items-center gap-2 rounded-md px-3 text-xs font-semibold transition",
                  tab.closable && "pr-8",
                  active
                    ? "bg-accent text-foreground shadow-sm ring-1 ring-black/[0.06]"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                onClick={() => onSelectTab?.(tab.id)}
                title={tab.label}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
              {tab.closable && onCloseTab ? (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-background/75 hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  aria-label={`关闭${tab.label}`}
                  title={`关闭${tab.label}`}
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {onAddTab ? (
        <button
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onClick={onAddTab}
          aria-label="新建标签页"
          title="新建标签页"
        >
          <Plus className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
