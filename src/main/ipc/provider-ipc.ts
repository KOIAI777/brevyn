import { ipcMain } from "electron";
import type { ProviderDraftInput } from "../../types/domain";
import { IPC_CHANNELS } from "../../types/ipc";
import type { IpcContext } from "./context";
import { requireString } from "./validation";

export function registerProvidersIpc({ store }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.providersList, () => store.listProviders());
  ipcMain.handle(IPC_CHANNELS.providersSave, (_event, input: ProviderDraftInput) => store.saveProvider(input));
  ipcMain.handle(IPC_CHANNELS.providersDelete, (_event, providerId: unknown) => store.deleteProvider(requireString(providerId, "Provider id")));
  ipcMain.handle(IPC_CHANNELS.providersDecryptApiKey, async (_event, providerId: unknown) => (await store.providerApiKey(requireString(providerId, "Provider id"))) || "");
  ipcMain.handle(IPC_CHANNELS.providersModels, (_event, input: unknown) => {
    if (typeof input === "string") return store.providerModels(requireString(input, "Provider id"));
    return store.providerModelsFromDraft(input as ProviderDraftInput);
  });
  ipcMain.handle(IPC_CHANNELS.providersTest, (_event, input: unknown) => {
    if (typeof input === "string") return store.testProvider(requireString(input, "Provider id"));
    return store.testProviderDraft(input as ProviderDraftInput);
  });
  ipcMain.handle(IPC_CHANNELS.providersEmbeddingMutable, async () => !(await store.hasActiveIndexingJobs()));
}
