import type { ClipboardEvent } from "react";
import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import type { WorkspaceFileNode } from "@/types/domain";
import type { MentionedSkill } from "@/components/agent/AgentMentionPicker";
import { clipboardHtmlToMarkdown } from "@/lib/markdown-rich-text";

const MAX_SKILL_MENTION_OPTIONS = 50;
const MAX_FILE_MENTION_OPTIONS = 8;

interface AgentRichPromptInputProps {
  value: string;
  skills: MentionedSkill[];
  files: WorkspaceFileNode[];
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPaste: (event: ClipboardEvent<HTMLElement>, pastedText?: string) => void;
  onMentionFile: (file: WorkspaceFileNode) => void;
}

export function AgentRichPromptInput({
  value,
  skills,
  files,
  placeholder,
  onChange,
  onSubmit,
  onPaste,
  onMentionFile,
}: AgentRichPromptInputProps) {
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onPasteRef = useRef(onPaste);
  const onMentionFileRef = useRef(onMentionFile);
  const isComposingRef = useRef(false);
  const lastEditorValueRef = useRef("");
  const mentionActiveRef = useRef(false);
  const mentionItemCountRef = useRef(0);
  const skillsRef = useRef(skills);
  const filesRef = useRef(files);

  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  onPasteRef.current = onPaste;
  onMentionFileRef.current = onMentionFile;
  skillsRef.current = skills;
  filesRef.current = files;

  const skillSuggestion = useMemo(() => createMentionSuggestion<MentionedSkill>({
    char: "/",
    emptyText: "无匹配 Skill",
    mentionActiveRef,
    mentionItemCountRef,
    items: (query) => {
      return searchMentionItems(
        skillsRef.current,
        query,
        (skill) => [skill.name, skill.slug, skill.slug.replace(/[-_]+/g, " "), skill.description].join(" "),
        MAX_SKILL_MENTION_OPTIONS,
      );
    },
    keyForItem: (skill) => skill.id,
    renderItem: (skill) => `
      <span class="brevyn-mention-option-icon brevyn-mention-option-icon-skill">✦</span>
      <span class="brevyn-mention-option-title">${escapeHtml(skill.name)}</span>
      <span class="brevyn-mention-option-meta">${escapeHtml(skill.description)}</span>
    `,
    commandProps: (skill) => ({
      id: skill.slug,
      label: skill.slug,
      mentionSuggestionChar: "/",
    }),
  }), []);

  const fileSuggestion = useMemo(() => createMentionSuggestion<WorkspaceFileNode>({
    char: "@",
    emptyText: "无匹配文件",
    mentionActiveRef,
    mentionItemCountRef,
    items: (query) => {
      const allFiles = flattenFiles(filesRef.current);
      return searchMentionItems(
        allFiles,
        query,
        (file) => [file.name, file.path].join(" "),
        MAX_FILE_MENTION_OPTIONS,
      );
    },
    keyForItem: (file) => file.id,
    renderItem: (file) => `
      <span class="brevyn-mention-option-file-kind">${escapeHtml(fileKindLabel(file.kind))}</span>
      <span class="brevyn-mention-option-title">${escapeHtml(file.name)}</span>
      <span class="brevyn-mention-option-meta">${escapeHtml(file.path)}</span>
    `,
    commandProps: (file) => {
      onMentionFileRef.current(file);
      return {
        id: file.id,
        label: file.name,
        mentionSuggestionChar: "@",
      };
    },
  }), []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: false,
        blockquote: false,
        horizontalRule: false,
        link: false,
      }),
      Placeholder.configure({ placeholder }),
      Mention.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            mentionSuggestionChar: {
              default: "@",
              parseHTML: (element: HTMLElement) => element.getAttribute("data-mention-suggestion-char") || "@",
              renderHTML: (attrs: Record<string, string>) => ({
                "data-mention-suggestion-char": attrs.mentionSuggestionChar,
              }),
            },
          };
        },
      }).configure({
        HTMLAttributes: {},
        renderHTML({ node, suggestion }) {
          const char = suggestion?.char ?? node.attrs.mentionSuggestionChar ?? "@";
          const label = node.attrs.label ?? node.attrs.id;
          return [
            "span",
            {
              "data-type": "mention",
              "data-id": node.attrs.id,
              "data-label": label,
              "data-mention-suggestion-char": char,
              class: char === "/" ? "brevyn-skill-mention-chip" : "brevyn-file-mention-chip",
            },
            char === "/" ? String(label) : `@${label}`,
          ];
        },
        suggestions: [skillSuggestion as any, fileSuggestion as any],
      }),
    ],
    content: textToTipTapContent(value, skills),
    editorProps: {
      attributes: {
        class: "brevyn-rich-prompt-editor min-h-12 max-h-[15rem] overflow-y-auto px-1 py-0.5 text-sm leading-6 outline-none brevyn-scrollbar",
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
      },
      handleDOMEvents: {
        compositionstart: () => {
          isComposingRef.current = true;
          return false;
        },
        compositionend: () => {
          isComposingRef.current = false;
          return false;
        },
        paste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files || []);
          const plainText = event.clipboardData?.getData("text/plain") || "";
          const html = event.clipboardData?.getData("text/html") || "";
          const pastedText = files.length === 0 ? clipboardHtmlToMarkdown(html, plainText) : undefined;
          onPasteRef.current(event as unknown as ClipboardEvent<HTMLElement>, pastedText);
          return event.defaultPrevented;
        },
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== "Enter") return false;
        if (isComposingRef.current || event.isComposing) return false;
        if (mentionActiveRef.current && mentionItemCountRef.current > 0) return false;
        if (event.shiftKey) return false;
        event.preventDefault();
        onSubmitRef.current();
        return true;
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      const nextValue = editorToPromptText(currentEditor);
      lastEditorValueRef.current = nextValue;
      onChangeRef.current(nextValue);
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const extensions = editor.extensionManager?.extensions ?? [];
    const placeholderExtension = extensions.find((extension) => extension.name === "placeholder");
    if (placeholderExtension) {
      placeholderExtension.options.placeholder = placeholder;
      editor.view.dispatch(editor.state.tr);
    }
  }, [editor, placeholder]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastEditorValueRef.current) return;
    editor.commands.setContent(textToTipTapContent(value, skills), { emitUpdate: false });
    lastEditorValueRef.current = value;
  }, [editor, skills, value]);

  return (
    <div className="relative min-h-12 w-full">
      <EditorContent editor={editor} />
      <style>{`
        .brevyn-rich-prompt-editor:focus,
        .brevyn-rich-prompt-editor:focus-visible,
        .brevyn-rich-prompt-editor.ProseMirror-focused {
          outline: none;
          box-shadow: none;
        }
        .brevyn-rich-prompt-editor p {
          margin: 0;
        }
        .brevyn-rich-prompt-editor p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: hsl(var(--muted-foreground));
          pointer-events: none;
          height: 0;
          opacity: 0.72;
        }
        .brevyn-skill-mention-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          border-radius: 6px;
          padding: 1px 6px 1px 5px;
          background: hsl(var(--primary) / 0.11);
          color: hsl(var(--primary));
          font-size: 12px;
          font-weight: 650;
          line-height: 20px;
          white-space: nowrap;
          vertical-align: baseline;
        }
        .brevyn-skill-mention-chip::before {
          content: "✦";
          font-size: 10px;
          line-height: 1;
        }
        .brevyn-file-mention-chip {
          display: inline-flex;
          align-items: center;
          border-radius: 6px;
          padding: 1px 6px;
          background: hsl(var(--accent) / 0.75);
          color: hsl(var(--foreground));
          font-size: 12px;
          font-weight: 600;
          line-height: 20px;
          white-space: nowrap;
          vertical-align: baseline;
        }
        .brevyn-mention-popup {
          position: fixed;
          z-index: 80;
          width: 280px;
          max-height: 240px;
          overflow-y: auto;
          border: 1px solid hsl(var(--border));
          border-radius: 10px;
          background: hsl(var(--card) / 0.98);
          box-shadow: 0 14px 34px rgba(64, 55, 38, 0.18);
          padding: 4px 0;
          backdrop-filter: blur(16px);
        }
        .brevyn-mention-empty {
          padding: 8px 10px;
          font-size: 11px;
          color: hsl(var(--muted-foreground));
        }
        .brevyn-mention-option {
          display: flex;
          width: 100%;
          min-width: 0;
          align-items: center;
          gap: 8px;
          border: 0;
          background: transparent;
          padding: 6px 10px;
          text-align: left;
          font-size: 12px;
          color: hsl(var(--foreground));
        }
        .brevyn-mention-option:hover,
        .brevyn-mention-option[data-selected="true"] {
          background: hsl(var(--primary) / 0.1);
        }
        .brevyn-mention-option-icon {
          flex-shrink: 0;
          width: 14px;
          color: hsl(var(--primary));
          text-align: center;
        }
        .brevyn-mention-option-file-kind {
          display: inline-flex;
          min-width: 22px;
          justify-content: center;
          border: 1px solid hsl(var(--border));
          border-radius: 5px;
          padding: 1px 4px;
          font-size: 9px;
          font-weight: 700;
          color: hsl(var(--muted-foreground));
        }
        .brevyn-mention-option-title {
          min-width: 0;
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-weight: 600;
        }
        .brevyn-mention-option-meta {
          max-width: 120px;
          flex-shrink: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 10px;
          color: hsl(var(--muted-foreground) / 0.68);
        }
      `}</style>
    </div>
  );
}

function createMentionSuggestion<T>({
  char,
  emptyText,
  mentionActiveRef,
  mentionItemCountRef,
  items,
  keyForItem,
  renderItem,
  commandProps,
}: {
  char: string;
  emptyText: string;
  mentionActiveRef: { current: boolean };
  mentionItemCountRef: { current: number };
  items: (query: string) => T[];
  keyForItem: (item: T) => string;
  renderItem: (item: T) => string;
  commandProps: (item: T) => Record<string, string>;
}) {
  return {
    char,
    allowSpaces: false,
    items: ({ query }: { query: string }) => items(query || ""),
    command: ({ editor, range, props }: { editor: any; range: unknown; props: T }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: "mention", attrs: commandProps(props) },
          { type: "text", text: " " },
        ])
        .run();
    },
    render: () => {
      let popup: HTMLDivElement | null = null;
      let currentItems: T[] = [];
      let selectedIndex = 0;
      let command: ((item: T) => void) | null = null;

      const renderPopup = () => {
        if (!popup) return;
        mentionItemCountRef.current = currentItems.length;
        if (currentItems.length === 0) {
          popup.innerHTML = `<div class="brevyn-mention-empty">${escapeHtml(emptyText)}</div>`;
          return;
        }
        popup.innerHTML = currentItems.map((item, index) => `
          <button type="button" class="brevyn-mention-option" data-index="${index}" data-selected="${index === selectedIndex ? "true" : "false"}">
            ${renderItem(item)}
          </button>
        `).join("");
        popup.querySelectorAll<HTMLButtonElement>(".brevyn-mention-option").forEach((button) => {
          button.addEventListener("mousedown", (event) => {
            event.preventDefault();
            const index = Number(button.dataset.index || "0");
            const item = currentItems[index];
            if (item) command?.(item);
          });
        });
      };

      const positionPopup = (clientRect?: (() => DOMRect | null) | null) => {
        if (!popup) return;
        const rect = clientRect?.();
        if (!rect) return;
        const popupRect = popup.getBoundingClientRect();
        const width = popupRect.width || 280;
        const height = popupRect.height || 240;
        const margin = 8;
        const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
        const aboveTop = rect.top - height - margin;
        const belowTop = rect.bottom + margin;
        const hasAboveRoom = aboveTop >= margin;
        const top = hasAboveRoom
          ? aboveTop
          : Math.min(Math.max(belowTop, margin), window.innerHeight - height - margin);
        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
      };

      return {
        onStart: (props: any) => {
          mentionActiveRef.current = true;
          currentItems = props.items || [];
          selectedIndex = 0;
          command = props.command;
          popup = document.createElement("div");
          popup.className = "brevyn-mention-popup brevyn-scrollbar";
          document.body.appendChild(popup);
          renderPopup();
          positionPopup(props.clientRect);
        },
        onUpdate: (props: any) => {
          currentItems = props.items || [];
          selectedIndex = Math.min(selectedIndex, Math.max(0, currentItems.length - 1));
          command = props.command;
          renderPopup();
          positionPopup(props.clientRect);
        },
        onKeyDown: ({ event }: { event: KeyboardEvent }) => {
          if (!popup || currentItems.length === 0) return false;
          if (event.key === "ArrowUp") {
            selectedIndex = selectedIndex <= 0 ? currentItems.length - 1 : selectedIndex - 1;
            renderPopup();
            return true;
          }
          if (event.key === "ArrowDown") {
            selectedIndex = selectedIndex >= currentItems.length - 1 ? 0 : selectedIndex + 1;
            renderPopup();
            return true;
          }
          if (event.key === "Enter") {
            const item = currentItems[selectedIndex];
            if (item) command?.(item);
            return true;
          }
          if (event.key === "Escape") return true;
          return false;
        },
        onExit: () => {
          mentionActiveRef.current = false;
          mentionItemCountRef.current = 0;
          popup?.remove();
          popup = null;
        },
      };
    },
  };
}

function editorToPromptText(editor: { getJSON: () => TipTapJsonNode }): string {
  const root = editor.getJSON();
  return (root.content || []).map(serializeNode).join("\n").trim();
}

interface TipTapJsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, string>;
  content?: TipTapJsonNode[];
}

function serializeNode(node: TipTapJsonNode): string {
  const typeName = node.type;
  if (typeName === "text") return node.text || "";
  if (typeName === "hardBreak") return "\n";
  if (typeName === "mention") {
    const char = node.attrs?.mentionSuggestionChar || "@";
    const id = node.attrs?.id || "";
    const label = node.attrs?.label || id;
    if (char === "/") return `/skill:${id}`;
    return `@${label}`;
  }
  return (node.content || []).map(serializeNode).join("");
}

function textToTipTapContent(value: string, skills: MentionedSkill[]) {
  const skillBySlug = new Map(skills.map((skill) => [skill.slug, skill]));
  const paragraphs = value ? value.split(/\n/) : [""];
  return {
    type: "doc",
    content: paragraphs.map((paragraph) => ({
      type: "paragraph",
      content: textLineToNodes(paragraph, skillBySlug),
    })),
  };
}

function textLineToNodes(line: string, skillBySlug: Map<string, MentionedSkill>) {
  if (!line) return [];
  const nodes: Array<Record<string, unknown>> = [];
  const pattern = /(?:^|\s)\/(?:skill:)?([^\s/]+)(?=\s|$)/g;
  let lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    const full = match[0] || "";
    const slug = match[1] || "";
    const index = match.index ?? 0;
    const prefixLength = full.startsWith(" ") ? 1 : 0;
    const tokenStart = index + prefixLength;
    const skill = skillBySlug.get(slug);
    if (!skill) continue;
    addTextNode(nodes, line.slice(lastIndex, tokenStart));
    nodes.push({
      type: "mention",
      attrs: {
        id: skill.slug,
        label: skill.slug,
        mentionSuggestionChar: "/",
      },
    });
    lastIndex = index + full.length;
  }
  addTextNode(nodes, line.slice(lastIndex));
  return nodes;
}

function addTextNode(nodes: Array<Record<string, unknown>>, text: string) {
  if (!text) return;
  nodes.push({ type: "text", text });
}

function flattenFiles(files: WorkspaceFileNode[]): WorkspaceFileNode[] {
  const result: WorkspaceFileNode[] = [];
  const visit = (node: WorkspaceFileNode) => {
    if (node.children?.length) {
      node.children.forEach(visit);
      return;
    }
    result.push(node);
  };
  files.forEach(visit);
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function searchMentionItems<T>(items: T[], query: string, getText: (item: T) => string, limit: number): T[] {
  const normalizedQuery = normalizeMentionSearchText(query);
  if (!normalizedQuery) return items.slice(0, limit);
  return items
    .map((item, index) => ({
      item,
      index,
      score: scoreMentionSearch(normalizedQuery, getText(item)),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

function scoreMentionSearch(normalizedQuery: string, value: string): number {
  const normalizedValue = normalizeMentionSearchText(value);
  if (!normalizedValue) return Number.POSITIVE_INFINITY;
  const queryCompact = compactMentionSearchText(normalizedQuery);
  const valueCompact = compactMentionSearchText(normalizedValue);
  if (valueCompact === queryCompact) return -40;
  if (valueCompact.startsWith(queryCompact)) return -20;
  if (valueCompact.includes(queryCompact)) return 0;

  let score = 0;
  for (const token of normalizedQuery.split(" ").filter(Boolean)) {
    const tokenCompact = compactMentionSearchText(token);
    const tokenIndex = normalizedValue.indexOf(token);
    if (tokenIndex >= 0) {
      score += tokenIndex;
      continue;
    }
    const compactIndex = valueCompact.indexOf(tokenCompact);
    if (compactIndex >= 0) {
      score += 40 + compactIndex;
      continue;
    }
    const fuzzyScore = fuzzySubsequenceScore(tokenCompact, valueCompact);
    if (!Number.isFinite(fuzzyScore)) return Number.POSITIVE_INFINITY;
    score += 120 + fuzzyScore;
  }
  return score;
}

function normalizeMentionSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compactMentionSearchText(value: string): string {
  return value.replace(/\s+/g, "");
}

function fuzzySubsequenceScore(query: string, value: string): number {
  if (!query) return 0;
  let cursor = 0;
  let score = 0;
  for (const char of query) {
    const index = value.indexOf(char, cursor);
    if (index < 0) return Number.POSITIVE_INFINITY;
    score += index - cursor;
    cursor = index + 1;
  }
  return score + value.length - cursor;
}

function fileKindLabel(kind: WorkspaceFileNode["kind"]): string {
  if (kind === "markdown") return "MD";
  if (kind === "image") return "IMG";
  if (kind === "unknown") return "FILE";
  return kind;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
