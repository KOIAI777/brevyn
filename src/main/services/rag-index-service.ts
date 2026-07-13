import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Connection, Table } from "@lancedb/lancedb";
import type { IndexingTaskRecord, IndexingWorkerResult } from "../indexing";
import type { CourseFileSectionKind, ModelProviderConfig, RagSearchResult, WorkspaceFileKind } from "../../types/domain";
import { getEmbeddingProviderAdapter } from "../providers";

const SEMESTER_HOME_COURSE_ID = "semester-home";

type RagChunkRow = {
  id: string;
  semester_id: string;
  course_id: string;
  section_id: string;
  file_id: string;
  file_name: string;
  file_path: string;
  source_path: string;
  kind: WorkspaceFileKind;
  week_number: number;
  task_file_bucket: string;
  chunk_index: number;
  chunk_count: number;
  text: string;
  title: string;
  citation: string;
  parser: string;
  coverage_status: string;
  ocr_applied: boolean;
  ocr_provider: string;
  ocr_model: string;
  source_label: string;
  section_type: string;
  section_title: string;
  section_index: number;
  chunk_in_section: number;
  chunks_in_section: number;
  artifact_id: string;
  semantic_unit_id: string;
  element_ids: string;
  page: number;
  slide: number;
  sheet: string;
  range: string;
  bbox: string;
  vector: number[];
  embedding_provider_id: string;
  embedding_model: string;
  embedding_dimension: number;
  created_at: string;
  updated_at: string;
};

type EmbeddingMeta = {
  providerId: string;
  model: string;
  dimension: number;
};

type RagTextIndexChunk = {
  id: string;
  semesterId: string;
  courseId: string;
  sectionId: string;
  fileId: string;
  taskId?: string;
  fileName: string;
  filePath: string;
  sourcePath: string;
  kind: WorkspaceFileKind;
  weekNumber: number;
  taskFileBucket: string;
  chunkIndex: number;
  chunkCount: number;
  title: string;
  citation: string;
  text: string;
  parser: string;
  coverageStatus: string;
  ocrApplied: boolean;
  sourceLabel: string;
  sectionType: string;
  sectionTitle: string;
  sectionIndex: number;
  chunkInSection: number;
  chunksInSection: number;
  artifactId: string;
  semanticUnitId: string;
  elementIds: string;
  page: number;
  slide: number;
  sheet: string;
  range: string;
  bbox: string;
  createdAt: string;
  updatedAt: string;
};

interface RagTextIndexStore {
  upsertRagTextChunks(chunks: RagTextIndexChunk[]): void;
  deleteRagTextChunksByFile(fileId: string): void;
  deleteRagTextChunksByCourse(semesterId: string, courseId: string): void;
  deleteRagTextChunksByTask(semesterId: string, courseId: string, taskId: string): void;
  deleteRagTextChunksBySemester(semesterId: string): void;
};

export interface RagSearchOptions {
  taskId?: string;
  sectionKind?: CourseFileSectionKind;
  perFileMax?: number;
}

interface RagIndexServiceOptions {
  dbPath: string;
  resolveEmbeddingProvider: () => ModelProviderConfig | undefined;
  resolveApiKey: (provider: ModelProviderConfig) => string | undefined;
  textIndex?: RagTextIndexStore;
}

const TABLE_NAME = "rag_chunks";
const DEFAULT_TOP_K = 6;
const EMBEDDING_BATCH_SIZE = 24;
const MIN_EMBEDDING_BATCH_SIZE = 1;
const EMBEDDING_REQUEST_TIMEOUT_MS = 45_000;
const EMBEDDING_REQUEST_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 800;
const VECTOR_WRITE_TIMEOUT_MS = 60_000;
const SCHEMA_REBUILD_MESSAGE = "Embedding index schema is outdated. Please re-index the current semester from Settings -> Provider.";
const BASE_RAG_RESULT_FIELDS = [
  "id",
  "course_id",
  "file_id",
  "file_name",
  "file_path",
  "section_id",
  "task_file_bucket",
  "chunk_index",
  "chunk_count",
  "text",
  "title",
  "citation",
] as const;
const OPTIONAL_RAG_RESULT_FIELDS = [
  "source_path",
  "source_label",
  "section_type",
  "section_title",
  "artifact_id",
  "semantic_unit_id",
  "element_ids",
  "page",
  "slide",
  "sheet",
  "range",
  "bbox",
] as const;
const REQUIRED_RAG_FIELDS = [
  "id",
  "semester_id",
  "course_id",
  "section_id",
  "file_id",
  "file_name",
  "file_path",
  "source_path",
  "kind",
  "week_number",
  "task_file_bucket",
  "chunk_index",
  "chunk_count",
  "text",
  "title",
  "citation",
  "vector",
  "embedding_provider_id",
  "embedding_model",
  "embedding_dimension",
  "created_at",
  "updated_at",
] as const;

export class RagIndexService {
  private connectionPromise: Promise<Connection> | null = null;
  private tablePromise: Promise<Table | null> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: RagIndexServiceOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
  }

  async ingestTask(task: IndexingTaskRecord, result: IndexingWorkerResult, canWrite: () => boolean | Promise<boolean> = () => true): Promise<boolean> {
    if (!(await canWrite())) return false;
    if (result.chunks.length === 0) {
      if (!(await canWrite())) return false;
      await this.deleteFile(task.payload.fileId);
      return true;
    }
    const provider = this.resolveEmbeddingProviderForTask(task);
    if (!provider) {
      throw new Error("No embedding provider is configured. Save an embedding-enabled provider before indexing files.");
    }
    const apiKey = this.options.resolveApiKey(provider);
    if (!apiKey) {
      throw new Error(`No API key is available for embedding provider ${provider.name}.`);
    }

    const vectors = await this.embedTexts(result.chunks, provider, apiKey);
    assertEmbeddingVectors(vectors, result.chunks.length);
    const providerMeta = embeddingMeta(provider, vectors);
    const rows = result.chunks.map((chunk, index) => this.toRow(task, result, index, chunk, vectors[index], providerMeta));

    return this.withWriteLock(async () => {
      if (!(await canWrite())) return false;
      const table = await this.ensureWritableTable(rows);
      if (!(await canWrite())) return false;
      try {
        await withTimeout(
          table
            .mergeInsert("id")
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .whenNotMatchedBySourceDelete({ where: `file_id = '${escapeSql(task.payload.fileId)}'` })
            .execute(rows),
          VECTOR_WRITE_TIMEOUT_MS,
          `Embedding index write timed out after ${Math.round(VECTOR_WRITE_TIMEOUT_MS / 1000)}s.`,
        );
      } catch (error) {
        if (isLanceSchemaMismatch(error)) {
          const rebuiltTable = await this.recreateWritableTable(rows);
          await withTimeout(
            rebuiltTable
              .mergeInsert("id")
              .whenMatchedUpdateAll()
              .whenNotMatchedInsertAll()
              .whenNotMatchedBySourceDelete({ where: `file_id = '${escapeSql(task.payload.fileId)}'` })
              .execute(rows),
            VECTOR_WRITE_TIMEOUT_MS,
            `Embedding index write timed out after ${Math.round(VECTOR_WRITE_TIMEOUT_MS / 1000)}s.`,
          );
        } else {
          throw error;
        }
      }
      if (!(await canWrite())) return false;
      this.options.textIndex?.upsertRagTextChunks(rows.map(rowToTextIndexChunk));
      return true;
    });
  }

  async search(
    query: string,
    semesterId: string,
    courseId?: string,
    maxResults = DEFAULT_TOP_K,
    excludeCourseIds: string[] = [],
    options: RagSearchOptions = {},
  ): Promise<RagSearchResult[]> {
    const table = await this.getReadableTable();
    if (!table) return [];

    const normalized = query.trim() || "course materials";
    const filterParts = [`semester_id = '${escapeSql(semesterId)}'`];
    if (courseId && courseId !== SEMESTER_HOME_COURSE_ID) {
      filterParts.push(`course_id = '${escapeSql(courseId)}'`);
    }
    filterParts.push(...ragFilterParts(courseId, options));
    for (const archivedCourseId of excludeCourseIds) {
      filterParts.push(`course_id != '${escapeSql(archivedCourseId)}'`);
    }
    const filter = filterParts.join(" AND ");
    const rowCount = await table.countRows(filter);
    if (rowCount === 0) return [];
    const schemaFields = await tableFieldNames(table);
    if (!fieldNamesHaveRequiredCoreSchema(schemaFields)) {
      throw new Error("Embedding index schema is outdated. Please re-index this course.");
    }

    const provider = this.resolveEmbeddingProvider();
    if (!provider) return [];
    const apiKey = this.options.resolveApiKey(provider);
    if (!apiKey) return [];

    const [queryVector] = await this.embedTexts([normalized], provider, apiKey);
    const currentMeta = embeddingMeta(provider, [queryVector]);
    const mismatch = await this.firstEmbeddingMetaMismatch(table, filter, currentMeta);
    if (mismatch) {
      throw new Error(
        `Embedding index was built with "${mismatch.model}" (dim=${mismatch.dimension}), but the current embedding provider uses "${currentMeta.model}" (dim=${currentMeta.dimension}). Please re-index this course.`,
      );
    }

    const rows = await table
      .search(Float32Array.from(queryVector))
      .where(filter)
      .select([...BASE_RAG_RESULT_FIELDS, ...OPTIONAL_RAG_RESULT_FIELDS.filter((field) => schemaFields.has(field)), "_distance"])
      .limit(Math.max(maxResults, maxResults * 3))
      .toArray();

    const perFileMax = clampInteger(options.perFileMax ?? 2, 1, Math.max(1, maxResults));
    const seenByFile = new Map<string, number>();
    const filteredRows: any[] = [];
    for (const row of rows) {
      const fileId = String(row.file_id || row.file_path || row.id);
      const currentCount = seenByFile.get(fileId) || 0;
      if (currentCount >= perFileMax) continue;
      seenByFile.set(fileId, currentCount + 1);
      filteredRows.push(row);
      if (filteredRows.length >= maxResults) break;
    }

    return filteredRows.map((row) => {
      const distance = Number(row._distance);
      const score = Number.isFinite(distance) ? 1 / (1 + Math.max(0, distance)) : 0;
      return rowToRagSearchResult(row, normalized, score);
    });
  }

  async deleteChunksByCourse(semesterId: string, courseId: string): Promise<void> {
    const table = await this.getReadableTable();
    if (table) await table.delete(`semester_id = '${escapeSql(semesterId)}' AND course_id = '${escapeSql(courseId)}'`);
    this.options.textIndex?.deleteRagTextChunksByCourse(semesterId, courseId);
  }

  async deleteChunksByTask(semesterId: string, courseId: string, taskId: string, fileIds: string[] = []): Promise<void> {
    const table = await this.getReadableTable();
    const sectionId = `${courseId}:task-${taskId}`;
    if (table) {
      await table.delete(`semester_id = '${escapeSql(semesterId)}' AND course_id = '${escapeSql(courseId)}' AND section_id = '${escapeSql(sectionId)}'`);
      for (const fileId of fileIds) {
        await table.delete(`file_id = '${escapeSql(fileId)}'`);
      }
    }
    this.options.textIndex?.deleteRagTextChunksByTask(semesterId, courseId, taskId);
    for (const fileId of fileIds) this.options.textIndex?.deleteRagTextChunksByFile(fileId);
  }

  async deleteChunksByFile(fileId: string): Promise<void> {
    await this.deleteFile(fileId);
  }

  async deleteChunksBySemester(semesterId: string): Promise<void> {
    const table = await this.getReadableTable();
    if (table) await table.delete(`semester_id = '${escapeSql(semesterId)}'`);
    this.options.textIndex?.deleteRagTextChunksBySemester(semesterId);
  }

  async close(): Promise<void> {
    const tablePromise = this.tablePromise;
    const connectionPromise = this.connectionPromise;
    this.tablePromise = null;
    this.connectionPromise = null;

    if (tablePromise) {
      try {
        const table = await tablePromise;
        table?.close();
      } catch (error) {
        console.warn("[rag-index] Failed to close table", error);
      }
    }

    if (connectionPromise) {
      try {
        const connection = await connectionPromise;
        connection?.close();
      } catch (error) {
        console.warn("[rag-index] Failed to close connection", error);
      }
    }
  }

  async rebuildOutdatedSchemaForExplicitReindex(): Promise<boolean> {
    const conn = await this.connection();
    if (!(await this.tableNeedsRebuild(conn))) return false;
    await this.closeCurrentTable();
    await conn.dropTable(TABLE_NAME);
    return true;
  }

  private resolveEmbeddingProvider(): ModelProviderConfig | undefined {
    const provider = this.options.resolveEmbeddingProvider();
    if (!provider || provider.purpose !== "embedding" || provider.protocol !== "openai_compatible" || provider.adapterKind !== "openai_embedding" || !provider.enabled || !provider.selectedModel || !provider.baseUrl) return undefined;
    return provider;
  }

  private resolveEmbeddingProviderForTask(task: IndexingTaskRecord): ModelProviderConfig | undefined {
    const provider = task.payload.embeddingProvider;
    if (
      provider?.purpose === "embedding" &&
      provider.protocol === "openai_compatible" &&
      provider.adapterKind === "openai_embedding" &&
      provider.selectedModel &&
      provider.baseUrl
    ) {
      return provider;
    }
    return this.resolveEmbeddingProvider();
  }

  private async embedTexts(texts: string[], provider: ModelProviderConfig, apiKey: string): Promise<number[][]> {
    const filtered = texts.map((text) => text.trim()).filter((text) => text.length > 0);
    if (filtered.length === 0) return [];

    const vectors: number[][] = [];
    const adapter = getEmbeddingProviderAdapter(provider);
    const batchSize = clampInteger(adapter.embeddingBatchSize?.(provider) ?? EMBEDDING_BATCH_SIZE, MIN_EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_SIZE);
    for (const batch of chunkArray(filtered, batchSize)) {
      vectors.push(...await this.embedBatchWithAdaptiveSplit(batch, provider, apiKey, adapter));
    }
    return vectors;
  }

  private async embedBatchWithAdaptiveSplit(
    batch: string[],
    provider: ModelProviderConfig,
    apiKey: string,
    adapter = getEmbeddingProviderAdapter(provider),
  ): Promise<number[][]> {
    for (let attempt = 1; attempt <= EMBEDDING_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.embedBatchOnceWithAdaptiveSplit(batch, provider, apiKey, adapter);
      } catch (error) {
        if (attempt >= EMBEDDING_REQUEST_MAX_ATTEMPTS || !isRetryableEmbeddingError(error)) {
          throw error;
        }
        await delay(EMBEDDING_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
    throw new Error("Embedding request failed after retries.");
  }

  private async embedBatchOnceWithAdaptiveSplit(
    batch: string[],
    provider: ModelProviderConfig,
    apiKey: string,
    adapter = getEmbeddingProviderAdapter(provider),
  ): Promise<number[][]> {
    const request = adapter.buildEmbeddingRequest(provider, apiKey, batch);
    const response = await fetchWithTimeout(request.url, request.init, EMBEDDING_REQUEST_TIMEOUT_MS);
    if (response.ok) {
      return adapter.parseEmbeddingResponse(await response.json());
    }

    const body = await responseText(response);
    if (batch.length > MIN_EMBEDDING_BATCH_SIZE && isEmbeddingBatchSizeError(response.status, body)) {
      const midpoint = Math.ceil(batch.length / 2);
      const left = await this.embedBatchWithAdaptiveSplit(batch.slice(0, midpoint), provider, apiKey, adapter);
      const right = await this.embedBatchWithAdaptiveSplit(batch.slice(midpoint), provider, apiKey, adapter);
      return [...left, ...right];
    }
    throw new Error(`Embedding request failed (${response.status}): ${body}`);
  }

  private async ensureWritableTable(rows: RagChunkRow[]): Promise<Table> {
    const conn = await this.connection();
    if (await this.tableNeedsRebuild(conn)) {
      await this.rebuildTable(conn);
    }
    try {
      const table = await conn.createTable(TABLE_NAME, rows, { mode: "create", existOk: true });
      this.tablePromise = Promise.resolve(table);
      return table;
    } catch (error) {
      if (isLanceSchemaMismatch(error)) {
        return this.recreateWritableTable(rows, conn);
      }
      throw error;
    }
  }

  private async recreateWritableTable(rows: RagChunkRow[], conn?: Connection): Promise<Table> {
    const connection = conn ?? await this.connection();
    await this.rebuildTable(connection);
    const table = await connection.createTable(TABLE_NAME, rows, { mode: "create", existOk: true });
    this.tablePromise = Promise.resolve(table);
    return table;
  }

  private async getReadableTable(): Promise<Table | null> {
    if (this.tablePromise) return this.tablePromise;
    this.tablePromise = this.openTable();
    return this.tablePromise;
  }

  private async openTable(): Promise<Table | null> {
    const conn = await this.connection();
    try {
      return await conn.openTable(TABLE_NAME);
    } catch {
      return null;
    }
  }

  private async deleteFile(fileId: string): Promise<void> {
    const table = await this.getReadableTable();
    if (table) await table.delete(`file_id = '${escapeSql(fileId)}'`);
    this.options.textIndex?.deleteRagTextChunksByFile(fileId);
  }

  private async connection(): Promise<Connection> {
    if (!this.connectionPromise) {
      this.connectionPromise = import("@lancedb/lancedb").then(({ connect }) => connect(this.options.dbPath));
    }
    return this.connectionPromise;
  }

  private async tableNeedsRebuild(conn: Connection): Promise<boolean> {
    const tableNames = await conn.tableNames();
    if (!tableNames.includes(TABLE_NAME)) return false;
    const table = await conn.openTable(TABLE_NAME);
    try {
      return !(await tableHasRequiredCoreSchema(table));
    } finally {
      table.close();
    }
  }

  private async closeCurrentTable(): Promise<void> {
    const tablePromise = this.tablePromise;
    this.tablePromise = null;
    if (!tablePromise) return;
    try {
      const table = await tablePromise;
      table?.close();
    } catch {
      // The table is about to be rebuilt; ignore stale handle close failures.
    }
  }

  private async rebuildTable(conn: Connection): Promise<void> {
    await this.closeCurrentTable();
    try {
      await conn.dropTable(TABLE_NAME);
    } catch {
      // If another cleanup already removed it, the next createTable call will recreate it.
    }
  }

  private withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release: () => void = () => {};
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(action, action).finally(release);
  }

  private async firstEmbeddingMetaMismatch(table: Table, filter: string, current: EmbeddingMeta): Promise<EmbeddingMeta | null> {
    const mismatchFilter = [
      filter,
      "AND",
      "(",
      `embedding_provider_id IS NULL OR embedding_provider_id != '${escapeSql(current.providerId)}'`,
      `OR embedding_model IS NULL OR embedding_model != '${escapeSql(current.model)}'`,
      `OR embedding_dimension IS NULL OR embedding_dimension != ${current.dimension}`,
      ")",
    ].join(" ");
    const rows = await table
      .query()
      .where(mismatchFilter)
      .select(["embedding_provider_id", "embedding_model", "embedding_dimension"])
      .limit(1)
      .toArray();
    const row = rows[0];
    return row ? rowToEmbeddingMeta(row) : null;
  }

  private toRow(task: IndexingTaskRecord, result: IndexingWorkerResult, chunkIndex: number, text: string, vector: number[], providerMeta: EmbeddingMeta): RagChunkRow {
    const metadata = result.chunkMetadata?.[chunkIndex];
    const sourceLabel = metadata?.sourceLabel;
    const sectionChunkLabel = metadata?.chunksInSection && metadata.chunksInSection > 1
      ? `${sourceLabel || "section"} ${metadata.chunkInSection || 1}/${metadata.chunksInSection}`
      : sourceLabel;
    const citationParts = [result.sourcePath || task.payload.path, sectionChunkLabel || `chunk ${chunkIndex + 1}/${result.chunks.length}`];
    return {
      id: `${task.payload.fileId}:${chunkIndex}`,
      semester_id: task.semesterId || task.payload.semesterId || "",
      course_id: task.courseId || task.payload.courseId,
      section_id: task.sectionId || task.payload.sectionId || "",
      file_id: task.payload.fileId,
      file_name: task.payload.name,
      file_path: task.payload.path,
      source_path: task.payload.sourcePath || "",
      kind: task.payload.kind,
      week_number: task.payload.weekNumber ?? -1,
      task_file_bucket: task.payload.taskFileBucket || "",
      chunk_index: chunkIndex,
      chunk_count: result.chunks.length,
      text,
      title: metadata?.title ? `${task.payload.name} · ${metadata.title}` : task.payload.name,
      citation: citationParts.filter(Boolean).join(" · "),
      parser: metadataString(result.metadata?.parser),
      coverage_status: metadataString(result.metadata?.coverageStatus),
      ocr_applied: metadataBoolean(result.metadata?.ocrApplied),
      ocr_provider: metadataString(result.metadata?.ocrProvider),
      ocr_model: metadataString(result.metadata?.ocrModel),
      source_label: metadataString(metadata?.sourceLabel),
      section_type: metadataString(metadata?.sectionType),
      section_title: metadataString(metadata?.title),
      section_index: metadataNumber(metadata?.sectionIndex, -1),
      chunk_in_section: metadataNumber(metadata?.chunkInSection, -1),
      chunks_in_section: metadataNumber(metadata?.chunksInSection, -1),
      artifact_id: metadataString(metadata?.artifactId),
      semantic_unit_id: metadataString(metadata?.semanticUnitId),
      element_ids: Array.isArray(metadata?.elementIds) ? metadata.elementIds.join(",") : "",
      page: metadataNumber(metadata?.page, -1),
      slide: metadataNumber(metadata?.slide, -1),
      sheet: metadataString(metadata?.sheet),
      range: metadataString(metadata?.range),
      bbox: metadataString(metadata?.bbox),
      vector,
      embedding_provider_id: providerMeta.providerId,
      embedding_model: providerMeta.model,
      embedding_dimension: providerMeta.dimension,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
}

function metadataString(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function metadataBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function metadataNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  if (size <= 0) return [values];
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isEmbeddingBatchSizeError(status: number, body: string): boolean {
  if (status !== 400 && status !== 413 && status !== 422) return false;
  return /batch size|too many|larger than|maximum.*input|input\.contents/i.test(body);
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function ragFilterParts(courseId: string | undefined, options: RagSearchOptions): string[] {
  const parts: string[] = [];
  if (courseId && courseId !== SEMESTER_HOME_COURSE_ID) {
    if (options.taskId) {
      const escapedTaskId = escapeSql(options.taskId);
      parts.push(`(section_id = '${escapeSql(`${courseId}:task-${options.taskId}`)}' OR file_path LIKE '%${escapedTaskId}%')`);
    }
    if (options.sectionKind) {
      parts.push(sectionKindFilter(courseId, options.sectionKind));
    }
  }
  return parts.filter(Boolean);
}

function sectionKindFilter(courseId: string, sectionKind: CourseFileSectionKind): string {
  if (sectionKind === "course_shared") {
    return `(section_id = '${escapeSql(`${courseId}:shared`)}' OR file_path LIKE '%/Course shared/%' OR file_path LIKE '%/Semester shared/%')`;
  }
  if (sectionKind === "lecture") {
    return `(section_id = '${escapeSql(`${courseId}:lecture`)}' OR file_path LIKE '%/Lecture/%')`;
  }
  return `(section_id LIKE '${escapeSql(`${courseId}:task-`)}%' OR file_path LIKE '%/Task/%')`;
}

function sectionKindForRow(sectionId: string, filePath: string): CourseFileSectionKind | undefined {
  if (sectionId.includes(":lecture") || filePath.includes("/Lecture/")) return "lecture";
  if (sectionId.includes(":task-") || filePath.includes("/Task/")) return "task";
  if (sectionId.includes(":shared") || filePath.includes("/Course shared/") || filePath.includes("/Semester shared/")) return "course_shared";
  return undefined;
}

function taskIdForRow(sectionId: string, filePath: string): string | undefined {
  const sectionMatch = sectionId.match(/:task-(.+)$/);
  if (sectionMatch?.[1]) return normalizeTaskId(sectionMatch[1]);
  const pathMatch = filePath.match(/\/Task\/(task-[^/]+)/);
  return pathMatch?.[1];
}

function normalizeTaskId(value: string): string {
  return value.startsWith("task-task-") ? value.slice("task-".length) : value;
}

function assertEmbeddingVectors(vectors: number[][], expectedCount: number): void {
  if (vectors.length !== expectedCount) {
    throw new Error(`Embedding provider returned ${vectors.length} vectors for ${expectedCount} chunks. Check the selected embedding model and re-index.`);
  }
  vectors.forEach((vector, index) => {
    if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`Embedding provider returned an invalid vector for chunk ${index + 1}. Check the selected embedding model and re-index.`);
    }
  });
}

function embeddingMeta(provider: ModelProviderConfig, vectors: number[][]): EmbeddingMeta {
  const dimension = vectors[0]?.length ?? 0;
  if (!dimension || vectors.length === 0 || vectors.some((vector) => vector.length !== dimension)) {
    throw new Error("Embedding provider returned empty or inconsistent vectors. Check the selected embedding model and re-index.");
  }
  return {
    providerId: provider.id,
    model: provider.selectedModel,
    dimension,
  };
}

async function tableFieldNames(table: Table): Promise<Set<string>> {
  const schema = await table.schema();
  return new Set(schema.fields.map((field: { name: string }) => field.name));
}

async function tableHasRequiredCoreSchema(table: Table): Promise<boolean> {
  return fieldNamesHaveRequiredCoreSchema(await tableFieldNames(table));
}

function fieldNamesHaveRequiredCoreSchema(fieldNames: Set<string>): boolean {
  return REQUIRED_RAG_FIELDS.every((field) => fieldNames.has(field));
}

function rowToEmbeddingMeta(row: Record<string, unknown>): EmbeddingMeta {
  return {
    providerId: stringValue(row.embedding_provider_id) || "unknown provider",
    model: stringValue(row.embedding_model) || "unknown model",
    dimension: numberValue(row.embedding_dimension) || 0,
  };
}

function rowToRagSearchResult(row: Record<string, unknown>, query: string, score: number): RagSearchResult {
  const filePath = String(row.file_path || row.file_name || "workspace");
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    fileId: String(row.file_id || ""),
    fileName: String(row.file_name || filePath),
    title: String(row.file_name || row.file_path || "RAG chunk"),
    source: filePath,
    sourcePath: String(row.source_path || ""),
    citation: String(row.citation || filePath),
    excerpt: excerptText(String(row.text || ""), query),
    score,
    path: filePath,
    sectionKind: sectionKindForRow(String(row.section_id || ""), filePath),
    taskId: taskIdForRow(String(row.section_id || ""), filePath),
    chunkIndex: numberValue(row.chunk_index),
    chunkCount: numberValue(row.chunk_count),
    sourceLabel: stringValue(row.source_label),
    sectionType: stringValue(row.section_type),
    sectionTitle: stringValue(row.section_title),
    artifactId: stringValue(row.artifact_id),
    semanticUnitId: stringValue(row.semantic_unit_id),
    elementIds: objectAnchorElementIds(row.section_type, row.element_ids),
    page: positiveNumberValue(row.page),
    slide: positiveNumberValue(row.slide),
    sheet: stringValue(row.sheet),
    range: stringValue(row.range),
    bbox: stringValue(row.bbox),
  };
}

function rowToTextIndexChunk(row: RagChunkRow): RagTextIndexChunk {
  return {
    id: row.id,
    semesterId: row.semester_id,
    courseId: row.course_id,
    sectionId: row.section_id,
    fileId: row.file_id,
    taskId: taskIdForRow(row.section_id, row.file_path),
    fileName: row.file_name,
    filePath: row.file_path,
    sourcePath: row.source_path,
    kind: row.kind,
    weekNumber: row.week_number,
    taskFileBucket: row.task_file_bucket,
    chunkIndex: row.chunk_index,
    chunkCount: row.chunk_count,
    title: row.title,
    citation: row.citation,
    text: row.text,
    parser: row.parser,
    coverageStatus: row.coverage_status,
    ocrApplied: row.ocr_applied,
    sourceLabel: row.source_label,
    sectionType: row.section_type,
    sectionTitle: row.section_title,
    sectionIndex: row.section_index,
    chunkInSection: row.chunk_in_section,
    chunksInSection: row.chunks_in_section,
    artifactId: row.artifact_id,
    semanticUnitId: row.semantic_unit_id,
    elementIds: row.element_ids,
    page: row.page,
    slide: row.slide,
    sheet: row.sheet,
    range: row.range,
    bbox: row.bbox,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function stringListValue(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const normalized = values.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
  return normalized.length > 0 ? normalized : undefined;
}

function objectAnchorElementIds(sectionType: unknown, value: unknown): string[] | undefined {
  const type = stringValue(sectionType);
  return type === "chart" || type === "shape" || type === "image" ? stringListValue(value) : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumberValue(value: unknown): number | undefined {
  const parsed = numberValue(value);
  return typeof parsed === "number" && parsed > 0 ? parsed : undefined;
}

function excerptText(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = normalized.toLowerCase();
  const matchIndex = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (matchIndex === undefined) return normalized.slice(0, 900);
  const start = Math.max(0, matchIndex - 260);
  const end = Math.min(normalized.length, matchIndex + 900);
  return normalized.slice(start, end).trim();
}

async function responseText(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, " ").slice(0, 1200);
  } catch {
    return "";
  }
}

function isRetryableEmbeddingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("429") ||
    normalized.includes("408") ||
    normalized.includes("500") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("terminated") ||
    normalized.includes("fetch failed") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("socket") ||
    normalized.includes("connection") ||
    normalized.includes("network") ||
    normalized.includes("rate limit") ||
    normalized.includes("temporar") ||
    normalized.includes("overloaded") ||
    normalized.includes("try again")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Embedding request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function isLanceSchemaMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /schema/i.test(message) && /match|mismatch|provided/i.test(message);
}
