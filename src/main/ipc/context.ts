import type { IndexingQueueService } from "../indexing";
import type { LocalStore } from "../services/local-store";
import type { OpenWithService } from "../services/open-with-service";

export interface IpcContext {
  store: LocalStore;
  indexingQueue?: IndexingQueueService;
  openWithService?: OpenWithService;
}
