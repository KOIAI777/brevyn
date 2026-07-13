import { existsSync } from "node:fs";
import type { ModelProviderConfig } from "../../types/domain";
import { readJsonFileSafe, writeJsonFileAtomic } from "./safe-json-file";

interface ProviderConfigFile {
  version: 1;
  providers: ModelProviderConfig[];
}

export class ProviderConfigStore {
  private data: ProviderConfigFile;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  hasConfigFile(): boolean {
    return existsSync(this.filePath);
  }

  listProviders(): ModelProviderConfig[] {
    return this.data.providers.map(cloneProvider);
  }

  replaceProviders(providers: ModelProviderConfig[]): void {
    this.writeData({
      ...this.data,
      providers: providers.map(cloneProvider),
    });
  }

  saveProvider(provider: ModelProviderConfig): ModelProviderConfig {
    const next = cloneProvider(provider);
    const providers = this.data.providers.map(cloneProvider);
    const index = providers.findIndex((item) => item.id === next.id);
    if (index >= 0) providers[index] = next;
    else providers.push(next);
    this.writeData({ ...this.data, providers });
    return cloneProvider(next);
  }

  deleteProvider(providerId: string): boolean {
    const index = this.data.providers.findIndex((item) => item.id === providerId);
    if (index < 0) return false;
    const providers = this.data.providers.map(cloneProvider);
    providers.splice(index, 1);
    this.writeData({ ...this.data, providers });
    return true;
  }

  private load(): ProviderConfigFile {
    if (!existsSync(this.filePath)) {
      return { version: 1, providers: [] };
    }
    const parsed = readJsonFileSafe<Partial<ProviderConfigFile>>(this.filePath);
    if (!parsed || !Array.isArray(parsed.providers)) {
      throw new Error(`Provider profile store is unreadable: ${this.filePath}. Fix or remove the file before saving providers.`);
    }
    return {
      version: 1,
      providers: parsed.providers.map(cloneProvider),
    };
  }

  private writeData(data: ProviderConfigFile): void {
    const next = {
      version: 1 as const,
      providers: data.providers.map(cloneProvider),
    };
    writeJsonFileAtomic(this.filePath, next);
    this.data = next;
  }
}

function cloneProvider(provider: ModelProviderConfig): ModelProviderConfig {
  return {
    id: provider.id,
    purpose: provider.purpose,
    providerKind: provider.providerKind,
    adapterKind: provider.adapterKind,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKeyMasked: provider.apiKeyMasked,
    apiKeySecretRef: provider.apiKeySecretRef,
    authMode: provider.authMode,
    models: Array.isArray(provider.models) ? provider.models.map(cloneProviderModel) : [],
    selectedModel: provider.selectedModel,
    enabled: provider.enabled,
    autoCompactThresholdPercent: provider.autoCompactThresholdPercent,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function cloneProviderModel(model: ModelProviderConfig["models"][number]): ModelProviderConfig["models"][number] {
  return {
    id: model.id,
    name: model.name,
    enabled: model.enabled,
    supportsVision: model.supportsVision,
  };
}
