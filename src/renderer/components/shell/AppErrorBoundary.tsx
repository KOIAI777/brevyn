import React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

export class AppErrorBoundary extends React.Component<{
  children: React.ReactNode;
}, {
  error: Error | null;
}> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[renderer] Unhandled render error", error, info);
    document.getElementById("brevyn-startup-splash")?.remove();
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-screen items-center justify-center bg-[radial-gradient(circle_at_20%_0%,rgba(37,99,235,0.08),transparent_34%),linear-gradient(180deg,hsl(var(--background)),#f3f1ea)] px-6 text-foreground">
          <div className="w-full max-w-md rounded-2xl border bg-card/90 p-6 shadow-2xl ring-1 ring-border/70">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <AlertCircle className="h-4 w-4 text-red-600" />
              Something went wrong
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              The renderer crashed while drawing the UI. Reload the app to try again.
            </p>
            <div className="mt-4 rounded-lg border bg-muted/35 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              {this.state.error.message || "Unknown render error."}
            </div>
            <button
              type="button"
              className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90"
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload app
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
