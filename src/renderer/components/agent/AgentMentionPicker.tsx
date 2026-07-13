import { X } from "lucide-react";
import type { SkillItem, WorkspaceFileKind, WorkspaceFileNode } from "@/types/domain";

export interface MentionedSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export function MentionedFileChips({
  files,
  onRemove,
}: {
  files: WorkspaceFileNode[];
  onRemove: (fileId: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background/65 px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:bg-accent"
          title={file.path}
          onClick={() => onRemove(file.id)}
        >
          <FileKindBadge kind={file.kind} />
          <span className="max-w-40 truncate">@{file.name}</span>
          <X className="h-3 w-3 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

function FileKindBadge({ kind }: { kind: WorkspaceFileKind }) {
  return (
    <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border bg-background/70 px-1 text-[9px] font-bold uppercase tracking-[0.04em] text-muted-foreground">
      {fileKindLabel(kind)}
    </span>
  );
}

export function flattenMentionableFiles(files: WorkspaceFileNode[]): WorkspaceFileNode[] {
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

export function flattenMentionableSkills(skills: SkillItem[]): MentionedSkill[] {
  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => {
      const slug = skill.slug || skill.id.replace(/^file:/, "");
      return {
        id: skill.id,
        slug,
        name: skill.name || slug,
        description: skill.description || "Skill",
      };
    })
    .filter((skill) => skill.slug)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildPromptWithMentions(prompt: string, files: WorkspaceFileNode[], skills: MentionedSkill[] = []): string {
  const cleanPrompt = stripSkillMentionTokens(prompt, skills);
  if (files.length === 0) return cleanPrompt;
  const refs = files
    .map((file) => `- ${file.name}: ${file.sourcePath || file.path}`)
    .join("\n");
  return `<attached_files>\n${refs}\n</attached_files>\n\n${cleanPrompt}`;
}

export function skillSlugsForPrompt(skills: MentionedSkill[]): string[] {
  return [...new Set(skills.map((skill) => skill.slug).filter(Boolean))];
}

function stripSkillMentionTokens(prompt: string, skills: MentionedSkill[]): string {
  if (skills.length === 0) return prompt;
  let next = prompt;
  for (const skill of skills) {
    const escaped = escapeRegExp(skill.slug);
    next = next.replace(new RegExp(`(^|\\s)/(?:skill:)?${escaped}(?=\\s|$)`, "g"), "$1");
  }
  return next.replace(/[ \t]{2,}/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fileKindLabel(kind: WorkspaceFileKind): string {
  if (kind === "markdown") return "MD";
  if (kind === "image") return "IMG";
  if (kind === "unknown") return "FILE";
  return kind;
}
