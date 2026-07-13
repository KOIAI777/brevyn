import type { WorkspaceFileNode } from "@/types/domain";

export function findFileNode(nodes: WorkspaceFileNode[], id: string): WorkspaceFileNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = node.children ? findFileNode(node.children, id) : null;
    if (child) return child;
  }
  return null;
}

export function findFileNodeByPath(nodes: WorkspaceFileNode[], filePath: string): WorkspaceFileNode | null {
  const target = normalizePathForMatch(filePath);
  if (!target) return null;
  const all = flattenFileNodes(nodes);

  const exact = all.find((node) => pathMatches(node, target, "exact"));
  if (exact) return exact;

  const suffix = all.find((node) => pathMatches(node, target, "suffix"));
  if (suffix) return suffix;

  const basename = target.split("/").filter(Boolean).at(-1);
  if (!basename) return null;
  const basenameMatches = all.filter((node) => normalizePathForMatch(node.name) === basename);
  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}

function flattenFileNodes(nodes: WorkspaceFileNode[]): WorkspaceFileNode[] {
  const result: WorkspaceFileNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children) result.push(...flattenFileNodes(node.children));
  }
  return result;
}

function pathMatches(node: WorkspaceFileNode, target: string, mode: "exact" | "suffix"): boolean {
  const candidates = [node.path, node.sourcePath, node.name]
    .map((value) => normalizePathForMatch(value || ""))
    .filter(Boolean);
  if (mode === "exact") return candidates.some((candidate) => candidate === target);
  return candidates.some((candidate) => candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`));
}

function normalizePathForMatch(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^file:\/\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
}

export function formatRelative(value: string): string {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
