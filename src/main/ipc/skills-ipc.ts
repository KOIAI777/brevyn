import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { OpenDialogOptions } from "electron";
import { IPC_CHANNELS } from "../../types/ipc";
import type { IpcContext } from "./context";
import { normalizeSkillImportInput, normalizeSkillLibrarySettings, normalizeSkillUpdateInput, normalizeSkillWriteInput, requireString } from "./validation";

export function registerSkillsIpc({ store }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.skillsList, () => store.listSkills());
  ipcMain.handle(IPC_CHANNELS.skillsUpdate, (_event, input: unknown) => store.updateSkill(normalizeSkillUpdateInput(input)));
  ipcMain.handle(IPC_CHANNELS.skillsLibrarySettings, () => store.skillLibrarySettings());
  ipcMain.handle(IPC_CHANNELS.skillsUpdateLibrarySettings, (_event, input: unknown) => store.updateSkillLibrarySettings(normalizeSkillLibrarySettings(input)));
  ipcMain.handle(IPC_CHANNELS.skillsReadContent, (_event, skillId: unknown) => store.readSkillContent(requireString(skillId, "Skill id")));
  ipcMain.handle(IPC_CHANNELS.skillsWriteContent, (_event, input: unknown) => store.writeSkillContent(normalizeSkillWriteInput(input)));
  ipcMain.handle(IPC_CHANNELS.skillsImportFolder, async (event, rawInput: unknown) => {
    const input = normalizeSkillImportInput(rawInput);
    let sourcePath = input.sourcePath?.trim();
    if (!sourcePath) {
      const window = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = {
        title: "Import skill folder",
        properties: ["openDirectory"],
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        throw new Error("Skill import was cancelled.");
      }
      sourcePath = result.filePaths[0];
    }
    return store.importSkillFolder({ ...input, sourcePath });
  });
  ipcMain.handle(IPC_CHANNELS.skillsOpenFolder, async (_event, skillId: unknown) => {
    const result = await shell.openPath(await store.skillFolderPath(requireString(skillId, "Skill id")));
    if (result) throw new Error(result);
  });
}
