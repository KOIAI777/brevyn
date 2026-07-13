import type { ModelProviderConfig, WorkspaceFileKind } from "../../types/domain";
import type { ParsedIndexingFile } from "./parsers";

export type IndexingTaskKind = "parse_chunk" | "embed" | "upsert" | "multimodal";
export type IndexingTaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface IndexingTaskPayload {
  semesterId?: string;
  courseId: string;
  sectionId?: string;
  fileId: string;
  taskId?: string;
  name: string;
  path: string;
  sourcePath?: string;
  kind: WorkspaceFileKind;
  weekNumber?: number;
  taskFileBucket?: string;
  embeddingProvider?: ModelProviderConfig;
}

export interface IndexingTaskRecord {
  id: string;
  jobId: string;
  semesterId?: string;
  courseId: string;
  sectionId?: string;
  fileId: string;
  kind: IndexingTaskKind;
  status: IndexingTaskStatus;
  attempts: number;
  maxAttempts: number;
  lockedBy?: string;
  lockedUntil?: string;
  nextRunAt: string;
  progress: number;
  error?: string;
  payload: IndexingTaskPayload;
  createdAt: string;
  updatedAt: string;
}

export interface IndexingTaskInsert {
  id: string;
  jobId: string;
  semesterId?: string;
  courseId: string;
  sectionId?: string;
  fileId: string;
  kind: IndexingTaskKind;
  maxAttempts?: number;
  nextRunAt?: string;
  payload: IndexingTaskPayload;
}

export interface IndexingWorkerResult {
  fileId: string;
  sourcePath?: string;
  chunkCount: number;
  charCount: number;
  byteCount: number;
  sample: string;
  warnings: string[];
  chunks: string[];
  chunkMetadata?: IndexingChunkMetadata[];
  metadata?: Record<string, string | number | boolean>;
  derivedMarkdown?: string;
  parsed?: ParsedIndexingFile;
  officeArtifact?: unknown;
}

export interface IndexingChunkMetadata {
  sourceLabel?: string;
  title?: string;
  sectionType?: string;
  sectionIndex?: number;
  chunkInSection?: number;
  chunksInSection?: number;
  artifactId?: string;
  semanticUnitId?: string;
  elementIds?: string[];
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  bbox?: string;
}
