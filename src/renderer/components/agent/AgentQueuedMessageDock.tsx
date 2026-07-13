import { Loader2, Pencil, Send, Trash2 } from "lucide-react";
import type { QueuedAgentMessage } from "@/components/agent/agentComposerTypes";
import { quoteLabel, stripQuotedSelections } from "@/components/agent/quotedSelection";

export function QueuedMessageDock({
  messages,
  sendingMessageIds,
  running,
  onSend,
  onDelete,
  onEdit,
}: {
  messages: QueuedAgentMessage[];
  sendingMessageIds: string[];
  running: boolean;
  onSend: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onEdit: (message: QueuedAgentMessage) => void;
}) {
  const helperText = running
    ? "待确认；立即追加会沿用当前运行，等完成后会作为下一轮发送"
    : "待发送；将作为新一轮运行";
  const sendTitle = running ? "立即追加到当前运行" : "立即发送";
  const sendingLabel = running ? "追加中" : "发送中";

  return (
    <div className="brevyn-composer-tray pointer-events-auto w-full rounded-2xl px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-foreground">待确认消息</p>
          <p className="text-[10px] text-muted-foreground">{helperText}</p>
        </div>
        <span className="rounded-full bg-[hsl(var(--foreground)/0.065)] px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{messages.length}</span>
      </div>
      <div className="max-h-32 space-y-1 overflow-y-auto pr-1 brevyn-scrollbar">
        {messages.map((message, index) => {
          const sending = sendingMessageIds.includes(message.id);
          const quotes = message.quotedSelections || (message.quotedSelection ? [message.quotedSelection] : []);
          const preview = stripQuotedSelections(message.prompt) || (quotes.length > 0 ? "请根据引用内容继续。" : message.prompt);
          const quoteLabelText = quotes.length === 1 ? `引用 ${quoteLabel(quotes[0])}` : `引用 ${quotes.length} 段`;
          return (
            <div
              key={message.id}
              className="group flex min-w-0 items-center gap-2 rounded-xl bg-[hsl(var(--foreground)/0.045)] px-2 py-1.5 text-[11px] transition hover:bg-[hsl(var(--foreground)/0.07)]"
            >
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[hsl(var(--foreground)/0.07)] text-[10px] font-semibold text-muted-foreground">
                {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-left text-foreground/86" title={preview}>
                {quotes.length > 0 ? `${quoteLabelText} · ${preview}` : preview}
              </span>
              {sending && <span className="shrink-0 text-[10px] font-medium text-muted-foreground">{sendingLabel}</span>}
              <div className="flex shrink-0 items-center gap-0.5 opacity-75 transition group-hover:opacity-100">
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                  onClick={() => onSend(message.id)}
                  disabled={sending}
                  title={sendTitle}
                  aria-label="Send queued message"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                  onClick={() => onEdit(message)}
                  disabled={sending}
                  title="重新编辑"
                  aria-label="Edit queued message"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition hover:bg-[hsl(var(--status-danger)/0.11)] hover:text-[hsl(var(--status-danger))] disabled:cursor-not-allowed disabled:opacity-45"
                  onClick={() => onDelete(message.id)}
                  disabled={sending}
                  title="删除"
                  aria-label="Delete queued message"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
