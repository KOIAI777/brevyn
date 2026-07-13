export const PIERRE_DIFF_CSS = `
  :root, :host {
    --diffs-bg: transparent;
    --diffs-addition-base: rgb(34, 142, 86);
    --diffs-deletion-base: rgb(206, 72, 59);
    --diffs-addition-bg: color-mix(in srgb, rgb(34, 197, 94) 13%, transparent);
    --diffs-deletion-bg: color-mix(in srgb, rgb(239, 68, 68) 12%, transparent);
    --diffs-separator-bg: hsl(var(--muted));
    --diffs-scrollbar-thumb: hsl(var(--border));
    --diffs-scrollbar-thumb-hover: hsl(var(--muted-foreground) / 0.45);
  }

  [data-code]::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  [data-code]::-webkit-scrollbar-track,
  [data-code]::-webkit-scrollbar-corner {
    background: transparent;
  }

  [data-code]::-webkit-scrollbar-thumb {
    background: var(--diffs-scrollbar-thumb);
    border-radius: 999px;
  }

  [data-code]::-webkit-scrollbar-thumb:hover {
    background: var(--diffs-scrollbar-thumb-hover);
  }

  [data-separator=line-info] {
    display: none !important;
  }

  [data-separator=line-info],
  [data-separator=line-info] [data-separator-wrapper],
  [data-separator=line-info] [data-separator-content],
  [data-separator=line-info] [data-expand-button] {
    background-color: var(--diffs-separator-bg) !important;
  }

  [data-line-type=change-addition] {
    background-color: var(--diffs-addition-bg) !important;
  }

  [data-line-type=change-deletion] {
    background-color: var(--diffs-deletion-bg) !important;
  }

  [data-line-type=change-addition] [data-column-number],
  [data-line-type=change-addition] [data-gutter-buffer]:not([data-gutter-buffer=buffer]) {
    color: var(--diffs-addition-base) !important;
    background-color: var(--diffs-addition-bg) !important;
  }

  [data-line-type=change-deletion] [data-column-number],
  [data-line-type=change-deletion] [data-gutter-buffer]:not([data-gutter-buffer=buffer]) {
    color: var(--diffs-deletion-base) !important;
    background-color: var(--diffs-deletion-bg) !important;
  }

  [data-gutter-buffer=buffer] {
    background: none !important;
  }

  [data-line-type=context] [data-column-number],
  [data-line-type=metadata] [data-column-number],
  [data-line-type=expanded] [data-column-number],
  [data-gutter] {
    background-color: hsl(var(--background)) !important;
  }
`;
