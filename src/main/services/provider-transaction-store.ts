import { existsSync, unlinkSync } from "node:fs";
import type { ModelProviderConfig } from "../../types/domain";
import { readJsonFileSafe, writeJsonFileAtomic } from "./safe-json-file";
import type { ProviderConfigStore } from "./provider-config-store";
import type { ProviderSecretSnapshot, ProviderSecretStore } from "./provider-secret-store";

interface ProviderTransactionFile {
  version: 1;
  transaction?: ProviderPendingTransaction;
}

export interface ProviderPendingTransaction {
  id: string;
  type: "save" | "delete";
  providerId: string;
  beforeProfiles: ModelProviderConfig[];
  afterProfiles: ModelProviderConfig[];
  beforeSecrets?: ProviderSecretSnapshot;
  afterSecrets?: ProviderSecretSnapshot;
  createdAt: string;
}

export class ProviderTransactionStore {
  constructor(private readonly filePath: string) {}

  begin(input: Omit<ProviderPendingTransaction, "id" | "createdAt">): ProviderPendingTransaction {
    const transaction: ProviderPendingTransaction = {
      ...input,
      id: `provider-tx-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
    };
    writeJsonFileAtomic(this.filePath, {
      version: 1,
      transaction,
    } satisfies ProviderTransactionFile);
    return transaction;
  }

  clear(transactionId?: string): void {
    const current = this.load();
    if (transactionId && current?.id && current.id !== transactionId) return;
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath);
    } catch {
      writeJsonFileAtomic(this.filePath, { version: 1 } satisfies ProviderTransactionFile);
    }
  }

  reconcile(configs: ProviderConfigStore, secrets?: ProviderSecretStore): void {
    const transaction = this.load();
    if (!transaction) return;
    try {
      configs.replaceProviders(transaction.afterProfiles);
      if (transaction.afterSecrets && secrets) {
        secrets.restore(transaction.afterSecrets);
      }
      this.clear(transaction.id);
    } catch (error) {
      try {
        configs.replaceProviders(transaction.beforeProfiles);
        if (transaction.beforeSecrets && secrets) {
          secrets.restore(transaction.beforeSecrets);
        }
        this.clear(transaction.id);
      } catch (rollbackError) {
        console.warn("[providers] Failed to reconcile or roll back pending provider transaction", rollbackError);
      }
      throw error;
    }
  }

  private load(): ProviderPendingTransaction | null {
    if (!existsSync(this.filePath)) return null;
    const parsed = readJsonFileSafe<Partial<ProviderTransactionFile>>(this.filePath);
    const transaction = parsed?.transaction;
    if (!transaction || typeof transaction !== "object") return null;
    if (!transaction.id || !transaction.providerId || !Array.isArray(transaction.afterProfiles)) return null;
    return transaction;
  }
}
