import { safeStorage } from "electron";
import { existsSync } from "node:fs";
import { readJsonFileSafe, writeJsonFileAtomic } from "./safe-json-file";

interface ProviderSecretRecord {
  ciphertext: string;
  updatedAt: string;
}

interface ProviderSecretFile {
  version: 1;
  providers: Record<string, ProviderSecretRecord>;
}

export type ProviderSecretSnapshot = ProviderSecretFile;

const now = () => new Date().toISOString();

export class ProviderSecretStore {
  private data: ProviderSecretFile;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  secretRef(providerId: string): string {
    return `provider-secret:${providerId}`;
  }

  hasApiKey(providerId: string): boolean {
    return Boolean(this.data.providers[providerId] && this.isEncryptionAvailable());
  }

  hasStoredApiKeyRecord(providerId: string): boolean {
    return Boolean(this.data.providers[providerId]);
  }

  storedProviderIds(): string[] {
    return Object.keys(this.data.providers);
  }

  snapshot(): ProviderSecretSnapshot {
    return cloneSecretFile(this.data);
  }

  restore(snapshot: ProviderSecretSnapshot): void {
    this.writeData(cloneSecretFile(snapshot));
  }

  snapshotWithApiKey(providerId: string, apiKey: string): { snapshot: ProviderSecretSnapshot; secretRef: string } {
    const trimmed = apiKey.trim();
    if (!trimmed) return { snapshot: this.snapshot(), secretRef: this.secretRef(providerId) };
    if (!this.isEncryptionAvailable()) {
      throw new Error("Secure key storage is unavailable on this system. Brevyn will not save plaintext provider keys.");
    }

    const next = cloneSecretFile(this.data);
    next.providers[providerId] = {
      ciphertext: safeStorage.encryptString(trimmed).toString("base64"),
      updatedAt: now(),
    };
    return { snapshot: next, secretRef: this.secretRef(providerId) };
  }

  snapshotWithoutApiKey(providerId: string): ProviderSecretSnapshot {
    const next = cloneSecretFile(this.data);
    delete next.providers[providerId];
    return next;
  }

  saveApiKey(providerId: string, apiKey: string): string {
    const next = this.snapshotWithApiKey(providerId, apiKey);
    this.writeData(next.snapshot);
    return next.secretRef;
  }

  deleteApiKey(providerId: string): void {
    if (!this.data.providers[providerId]) return;
    this.writeData(this.snapshotWithoutApiKey(providerId));
  }

  readApiKey(providerId: string): string | undefined {
    const record = this.data.providers[providerId];
    if (!record || !this.isEncryptionAvailable()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(record.ciphertext, "base64"));
    } catch (error) {
      console.warn(`[provider-secrets] Failed to decrypt provider key for ${providerId}`, error);
      return undefined;
    }
  }

  private load(): ProviderSecretFile {
    if (!existsSync(this.filePath)) {
      return { version: 1, providers: {} };
    }
    const parsed = readJsonFileSafe<Partial<ProviderSecretFile>>(this.filePath);
    if (!parsed || !parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
      throw new Error(`Provider secret store is unreadable: ${this.filePath}. Fix or remove the file before saving providers.`);
    }
    return {
      version: 1,
      providers: cloneProviders(parsed.providers as Record<string, ProviderSecretRecord>),
    };
  }

  private writeData(data: ProviderSecretFile): void {
    const next = cloneSecretFile(data);
    writeJsonFileAtomic(this.filePath, next);
    this.data = next;
  }
}

function cloneSecretFile(data: ProviderSecretFile): ProviderSecretFile {
  return {
    version: 1,
    providers: cloneProviders(data.providers),
  };
}

function cloneProviders(providers: Record<string, ProviderSecretRecord>): Record<string, ProviderSecretRecord> {
  return Object.fromEntries(
    Object.entries(providers).flatMap(([providerId, record]) => {
      if (!record || typeof record !== "object") return [];
      const ciphertext = typeof record.ciphertext === "string" ? record.ciphertext.trim() : "";
      if (!ciphertext) return [];
      return [[
        providerId,
        {
          ciphertext,
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
        },
      ]];
    }),
  );
}
