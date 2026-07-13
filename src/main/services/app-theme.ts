import { BrowserWindow, nativeTheme } from "electron";
import type { AppCodeThemePreference, AppTheme, AppThemePreference, AppThemeState } from "../../types/domain";
import { IPC_CHANNELS } from "../../types/ipc";

const WINDOW_BACKGROUND_BY_THEME: Record<AppTheme, string> = {
  light: "#f7f3ea",
  dark: "#0b0b0c",
};

export function normalizeThemePreference(value: unknown): AppThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function applyThemePreference(preference: AppThemePreference, codeThemePreference: AppCodeThemePreference = "brevyn", fontSmoothingEnabled = true): AppThemeState {
  nativeTheme.themeSource = preference;
  return syncNativeTheme(preference, codeThemePreference, fontSmoothingEnabled);
}

export function currentThemeState(preference: AppThemePreference, codeThemePreference: AppCodeThemePreference = "brevyn", fontSmoothingEnabled = true): AppThemeState {
  return {
    preference,
    effective: currentAppTheme(),
    codeThemePreference,
    fontSmoothingEnabled,
  };
}

export function currentWindowBackgroundColor(): string {
  return WINDOW_BACKGROUND_BY_THEME[currentAppTheme()];
}

export function syncNativeTheme(preference: AppThemePreference, codeThemePreference: AppCodeThemePreference = "brevyn", fontSmoothingEnabled = true): AppThemeState {
  const state = currentThemeState(preference, codeThemePreference, fontSmoothingEnabled);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.setBackgroundColor(WINDOW_BACKGROUND_BY_THEME[state.effective]);
    window.webContents.send(IPC_CHANNELS.appThemeChanged, state);
  }
  return state;
}

function currentAppTheme(): AppTheme {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}
