import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AppCodeThemePreference, AppSettings, AppThemePreference, SkillLibrarySettings, UserProfileSettings } from "../../types/domain";

const UNCATEGORIZED_SKILL_CATEGORY_ID = "uncategorized";
const OBSOLETE_SKILL_CATEGORY_IDS = new Set(["study-assignment"]);

const DEFAULT_APP_SETTINGS: AppSettings = {
  agentGateway: {
    openAiResponsesEnabled: false,
  },
  appearance: {
    themePreference: "system",
    codeThemePreference: "brevyn",
    fontSmoothingEnabled: true,
  },
  profile: {
    displayName: "Brevyn User",
    avatarId: "🧑‍💻",
  },
  skillLibrary: {
    categories: [
      { id: "creative-design", name: "创意设计", system: true },
      { id: "tools", name: "工具", system: true },
      { id: "academic", name: "学术", system: true },
      { id: UNCATEGORIZED_SKILL_CATEGORY_ID, name: "未分类", system: true },
    ],
    assignments: {},
  },
};

interface AppSettingsFile {
  version: 1;
  settings: AppSettings;
}

export class AppSettingsStore {
  private data: AppSettingsFile;

  constructor(private readonly filePath: string) {
    this.data = this.readData();
  }

  get(): AppSettings {
    return cloneSettings(this.data.settings);
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = mergeSettings(this.data.settings, patch);
    this.writeData({ version: 1, settings: next });
    return this.get();
  }

  updateAgentGateway(patch: Partial<AppSettings["agentGateway"]>): AppSettings {
    return this.update({
      agentGateway: {
        ...this.data.settings.agentGateway,
        ...patch,
      },
    });
  }

  updateAppearance(patch: Partial<AppSettings["appearance"]>): AppSettings {
    return this.update({
      appearance: {
        ...this.data.settings.appearance,
        ...patch,
      },
    });
  }

  updateProfile(patch: Partial<UserProfileSettings>): AppSettings {
    return this.update({
      profile: normalizeProfile({
        ...this.data.settings.profile,
        ...patch,
      }),
    });
  }

  skillLibrary(): SkillLibrarySettings {
    return cloneSkillLibrarySettings(this.data.settings.skillLibrary);
  }

  updateSkillLibrary(settings: SkillLibrarySettings): SkillLibrarySettings {
    return this.update({
      skillLibrary: normalizeSkillLibrarySettings(settings),
    }).skillLibrary;
  }

  private readData(): AppSettingsFile {
    if (!existsSync(this.filePath)) {
      return { version: 1, settings: cloneSettings(DEFAULT_APP_SETTINGS) };
    }
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<AppSettingsFile>;
    return {
      version: 1,
      settings: mergeSettings(DEFAULT_APP_SETTINGS, parsed.settings || {}),
    };
  }

  private writeData(data: AppSettingsFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
    this.data = {
      version: 1,
      settings: cloneSettings(data.settings),
    };
  }
}

function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    agentGateway: {
      openAiResponsesEnabled: Boolean(patch.agentGateway?.openAiResponsesEnabled ?? base.agentGateway.openAiResponsesEnabled),
    },
    appearance: {
      themePreference: normalizeThemePreference(patch.appearance?.themePreference ?? base.appearance.themePreference),
      codeThemePreference: normalizeCodeThemePreference(patch.appearance?.codeThemePreference ?? base.appearance.codeThemePreference),
      fontSmoothingEnabled: normalizeFontSmoothingEnabled(patch.appearance?.fontSmoothingEnabled ?? base.appearance.fontSmoothingEnabled),
    },
    profile: normalizeProfile({
      ...base.profile,
      ...(patch.profile || {}),
    }),
    skillLibrary: normalizeSkillLibrarySettings(patch.skillLibrary ?? base.skillLibrary),
  };
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    agentGateway: {
      openAiResponsesEnabled: Boolean(settings.agentGateway.openAiResponsesEnabled),
    },
    appearance: {
      themePreference: normalizeThemePreference(settings.appearance.themePreference),
      codeThemePreference: normalizeCodeThemePreference(settings.appearance.codeThemePreference),
      fontSmoothingEnabled: normalizeFontSmoothingEnabled(settings.appearance.fontSmoothingEnabled),
    },
    profile: normalizeProfile(settings.profile),
    skillLibrary: cloneSkillLibrarySettings(settings.skillLibrary),
  };
}

function normalizeThemePreference(value: unknown): AppThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : DEFAULT_APP_SETTINGS.appearance.themePreference;
}

export function normalizeCodeThemePreference(value: unknown): AppCodeThemePreference {
  return value === "brevyn" || value === "github" || value === "rose" || value === "mono"
    ? value
    : DEFAULT_APP_SETTINGS.appearance.codeThemePreference;
}

function normalizeFontSmoothingEnabled(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_APP_SETTINGS.appearance.fontSmoothingEnabled;
}

function normalizeProfile(profile: Partial<UserProfileSettings>): UserProfileSettings {
  const displayName = String(profile.displayName || DEFAULT_APP_SETTINGS.profile.displayName).trim().slice(0, 40);
  const avatarId = String(profile.avatarId || DEFAULT_APP_SETTINGS.profile.avatarId).trim().slice(0, 500_000);
  return {
    displayName: displayName || DEFAULT_APP_SETTINGS.profile.displayName,
    avatarId: avatarId || DEFAULT_APP_SETTINGS.profile.avatarId,
  };
}

function cloneSkillLibrarySettings(settings: SkillLibrarySettings): SkillLibrarySettings {
  const normalized = normalizeSkillLibrarySettings(settings);
  return {
    categories: normalized.categories.map((category) => ({ ...category })),
    assignments: { ...normalized.assignments },
  };
}

function normalizeSkillLibrarySettings(settings: Partial<SkillLibrarySettings> | undefined): SkillLibrarySettings {
  const defaults = DEFAULT_APP_SETTINGS.skillLibrary;
  const sourceCategories = settings?.categories?.length ? settings.categories : [];
  const categories = [...sourceCategories, ...defaults.categories, uncategorizedCategory()].reduce<SkillLibrarySettings["categories"]>((result, category) => {
    const id = normalizeSkillCategoryId(category?.id || category?.name);
    const name = normalizeSkillCategoryName(category?.name);
    if (OBSOLETE_SKILL_CATEGORY_IDS.has(id)) return result;
    if (!id || !name || result.some((item) => item.id === id)) return result;
    result.push({
      id,
      name,
      system: isDefaultSkillCategoryId(id) || Boolean(category?.system),
    });
    return result;
  }, []);
  const assignments: Record<string, string> = {};
  for (const [skillId, categoryId] of Object.entries(settings?.assignments || {})) {
    const normalizedSkillId = skillId.trim();
    const normalizedCategoryId = normalizeSkillCategoryId(categoryId);
    if (!normalizedSkillId || !categories.some((category) => category.id === normalizedCategoryId)) continue;
    assignments[normalizedSkillId] = normalizedCategoryId;
  }
  return { categories, assignments };
}

function uncategorizedCategory(): SkillLibrarySettings["categories"][number] {
  return DEFAULT_APP_SETTINGS.skillLibrary.categories.find((category) => category.id === UNCATEGORIZED_SKILL_CATEGORY_ID)!;
}

function isDefaultSkillCategoryId(id: string): boolean {
  return DEFAULT_APP_SETTINGS.skillLibrary.categories.some((category) => category.id === id);
}

function normalizeSkillCategoryId(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeSkillCategoryName(value: unknown): string {
  return String(value || "").trim().slice(0, 24);
}
