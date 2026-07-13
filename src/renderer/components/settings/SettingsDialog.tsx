import {
  Archive,
  CalendarDays,
  Check,
  Info,
  Languages,
  Brain,
  PlugZap,
  Server,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AboutUpdateSettingsPage } from "@/components/settings/about/AboutUpdateSettingsPage";
import { ArchiveSettingsPage } from "@/components/settings/archive/ArchiveSettingsPage";
import { GeneralSettingsPage } from "@/components/settings/general/GeneralSettingsPage";
import { MemorySettingsPage } from "@/components/settings/memory/MemorySettingsPage";
import { McpSettingsPage } from "@/components/settings/mcp/McpSettingsPage";
import { ProviderSettingsPage } from "@/components/settings/providers/ProviderSettingsPage";
import { useProviderSettingsState } from "@/components/settings/providers/useProviderSettingsState";
import { SemesterSettingsPage } from "@/components/settings/semesters/SemesterSettingsPage";
import { SkillSettingsPage } from "@/components/settings/skills/SkillSettingsPage";
import { errorMessage } from "@/components/settings/shared/settingsErrors";
import { cx } from "@/lib/cn";
import {
  type AppThemeState,
  type Course,
  type GitStatus,
  type SemesterWorkspace,
  type SkillItem,
  type UserProfileSettings,
} from "../../../types/domain";

type SettingsPage = "general" | "providers" | "semesters" | "archive" | "skills" | "memory" | "mcp" | "about";

export function SettingsDialog({
  initialPage = "providers",
  course,
  semester,
  profile,
  themeState,
  skills,
  gitStatus,
  onProfileChange,
  onThemeStateChange,
  onSkillsChange,
  onWorkspaceChanged,
  onSelectSemester,
  onAgentProviderChanged,
  onClose,
}: {
  initialPage?: SettingsPage;
  course?: Course;
  semester?: SemesterWorkspace | null;
  profile: UserProfileSettings;
  themeState: AppThemeState;
  skills: SkillItem[];
  gitStatus: GitStatus | null;
  onProfileChange: (profile: UserProfileSettings) => void;
  onThemeStateChange: (themeState: AppThemeState) => void;
  onSkillsChange: (skills: SkillItem[]) => void;
  onWorkspaceChanged?: () => Promise<void> | void;
  onSelectSemester?: (semesterId: string) => Promise<void> | void;
  onAgentProviderChanged?: (providerSelection: string) => Promise<void> | void;
  onClose: () => void;
}) {
  void course;
  const [activePage, setActivePage] = useState<SettingsPage>(initialPage);
  const {
    providers,
    providerToast,
    providerConfirmDialog,
    providerPageProps,
  } = useProviderSettingsState({ onAgentProviderChanged });
  const [localSkills, setLocalSkills] = useState(skills);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [skillContent, setSkillContent] = useState("");
  const [skillStatusLine, setSkillStatusLine] = useState("");
  const [skillBusy, setSkillBusy] = useState(false);

  useEffect(() => {
    setActivePage(initialPage);
  }, [initialPage]);

  const enabledSkills = localSkills.filter((skill) => skill.enabled).length;
  const chatProviders = providers.filter((provider) => provider.purpose === "agent");
  const embeddingProviders = providers.filter((provider) => provider.purpose === "embedding");
  const visionProviders = providers.filter((provider) => provider.purpose === "vision");
  const activeAgentProviders = chatProviders.filter((provider) => provider.enabled);
  const activeEmbeddingProviders = embeddingProviders.filter((provider) => provider.enabled);
  const activeVisionProviders = visionProviders.filter((provider) => provider.enabled);
  const enabledProviders = activeAgentProviders.length;
  const activeEmbeddingProvider = activeEmbeddingProviders.length === 1 ? activeEmbeddingProviders[0] : undefined;
  const embeddingProviderDetail = activeEmbeddingProviders.length > 1
    ? "多个 Embedding"
    : activeEmbeddingProvider?.selectedModel || "未配置向量模型";
  const visionProviderDetail = activeVisionProviders.length > 1
    ? "多个 Vision"
    : activeVisionProviders[0]?.selectedModel || "未配置视觉模型";

  useEffect(() => {
    setLocalSkills(skills);
  }, [skills]);

  useEffect(() => {
    void window.brevyn.skills
      .list()
      .then((next) => {
        setLocalSkills(next);
        onSkillsChange(next);
      })
      .catch((error) => setSkillStatusLine(`加载 Skill 失败：${errorMessage(error)}`));
  }, [onSkillsChange]);

  useEffect(() => {
    setSelectedSkillId((current) => (localSkills.some((skill) => skill.id === current) ? current : (localSkills[0]?.id ?? "")));
  }, [localSkills]);

  useEffect(() => {
    if (!selectedSkillId) {
      setSkillContent("");
      return;
    }
    let cancelled = false;
    setSkillBusy(true);
    void window.brevyn.skills
      .readContent(selectedSkillId)
      .then((content) => {
        if (cancelled) return;
        setSkillContent(content);
        setSkillStatusLine("");
      })
      .catch((error) => {
        if (cancelled) return;
        setSkillStatusLine(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setSkillBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSkillId]);

  async function toggleSkill(skill: SkillItem) {
    setSkillBusy(true);
    try {
      const updated = await window.brevyn.skills.update({ id: skill.id, enabled: !skill.enabled });
      const next = localSkills.map((item) => (item.id === updated.id ? updated : item));
      setLocalSkills(next);
      onSkillsChange(next);
      setSkillStatusLine(`${updated.enabled ? "已启用" : "已停用"} ${updated.name}。`);
    } catch (error) {
      setSkillStatusLine(errorMessage(error, "更新 Skill 失败。"));
    } finally {
      setSkillBusy(false);
    }
  }

  async function saveSkillContent() {
    if (!selectedSkillId) return;
    setSkillBusy(true);
    try {
      if (!skillContent.trim()) {
        setSkillStatusLine("SKILL.md 不能为空。");
        return;
      }
      const updated = await window.brevyn.skills.writeContent({ id: selectedSkillId, content: skillContent });
      const next = localSkills.map((item) => (item.id === updated.id ? updated : item));
      setLocalSkills(next);
      onSkillsChange(next);
      setSkillStatusLine("已保存 SKILL.md。");
    } catch (error) {
      setSkillStatusLine(errorMessage(error));
    } finally {
      setSkillBusy(false);
    }
  }

  async function importSkillFolder() {
    setSkillBusy(true);
    try {
      const imported = await window.brevyn.skills.importFolder({});
      const next = await window.brevyn.skills.list();
      setLocalSkills(next);
      onSkillsChange(next);
      setSelectedSkillId(imported.id);
      setSkillStatusLine(`已导入 ${imported.name}。`);
    } catch (error) {
      setSkillStatusLine(errorMessage(error));
    } finally {
      setSkillBusy(false);
    }
  }

  async function openSkillFolder(skillId: string) {
    if (!skillId) return;
    try {
      await window.brevyn.skills.openFolder(skillId);
      setSkillStatusLine("已打开 Skill 文件夹。");
    } catch (error) {
      setSkillStatusLine(errorMessage(error));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/32 p-2 md:p-3"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {providerConfirmDialog}
      {providerToast && (
        <div className="pointer-events-none absolute top-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-[var(--radius-pill)] bg-card px-3 py-2 text-xs font-medium text-foreground shadow-lg ring-1 ring-black/[0.06]">
          <Check className="h-3.5 w-3.5 text-emerald-600" />
          {providerToast.message}
        </div>
      )}
      <div className="brevyn-window-surface brevyn-dialog-window flex flex-col overflow-hidden">
        <div className="drag-region flex items-center justify-between bg-[hsl(var(--surface-chrome))] px-4 py-2.5 shadow-[inset_0_-1px_0_hsl(var(--border)/0.62)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <span className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] bg-card text-muted-foreground shadow-sm ring-1 ring-black/[0.045]">
                <Settings className="h-3.5 w-3.5" />
              </span>
              <span>设置</span>
            </div>
          </div>
          <button
            type="button"
            className="no-drag flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-card text-muted-foreground shadow-sm ring-1 ring-black/[0.06] transition hover:bg-background hover:text-foreground active:scale-[0.98]"
            onClick={onClose}
            title="关闭设置"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 min-w-0 flex-1 md:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="min-w-0 bg-[hsl(var(--surface-chrome))] p-2.5 shadow-[inset_-1px_0_0_hsl(var(--border)/0.62)]">
            <div className="space-y-1">
              <SettingsNavButton
                active={activePage === "providers"}
                icon={<PlugZap className="h-4 w-4" />}
                title="模型配置"
                detail={`${enabledProviders} 个启用 · ${embeddingProviderDetail} · ${visionProviderDetail}`}
                onClick={() => setActivePage("providers")}
              />
              <SettingsNavButton
                active={activePage === "general"}
                icon={<Languages className="h-4 w-4" />}
                title="个性化"
                detail="主题 · 代码样式"
                onClick={() => setActivePage("general")}
              />
              <SettingsNavButton
                active={activePage === "semesters"}
                icon={<CalendarDays className="h-4 w-4" />}
                title="学期管理"
                detail={semester?.term || "创建 / 切换 / 归档"}
                onClick={() => setActivePage("semesters")}
              />
              <SettingsNavButton
                active={activePage === "archive"}
                icon={<Archive className="h-4 w-4" />}
                title="归档"
                detail="恢复 / 永久删除"
                onClick={() => setActivePage("archive")}
              />
              <SettingsNavButton
                active={activePage === "skills"}
                icon={<Sparkles className="h-4 w-4" />}
                title="技能"
                detail={`${enabledSkills}/${localSkills.length} 已启用`}
                onClick={() => setActivePage("skills")}
              />
              <SettingsNavButton
                active={activePage === "memory"}
                icon={<Brain className="h-4 w-4" />}
                title="记忆"
                detail="规则 · Auto Memory"
                onClick={() => setActivePage("memory")}
              />
              <SettingsNavButton
                active={activePage === "mcp"}
                icon={<Server className="h-4 w-4" />}
                title="MCP 工具"
                detail="内置课程工具"
                onClick={() => setActivePage("mcp")}
              />
              <SettingsNavButton
                active={activePage === "about"}
                icon={<Info className="h-4 w-4" />}
                title="关于 / 更新"
                detail="版本 · 更新"
                onClick={() => setActivePage("about")}
              />
            </div>
          </aside>

          <main
            data-settings-scroll-root="true"
            className={cx("min-h-0 min-w-0 bg-[hsl(var(--surface-panel))] p-3 [overflow-anchor:none]", activePage === "skills" || activePage === "memory" ? "overflow-hidden" : "overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable] brevyn-scrollbar")}
          >
            {activePage === "general" ? (
              <GeneralSettingsPage profile={profile} themeState={themeState} onProfileChange={onProfileChange} onThemeStateChange={onThemeStateChange} />
            ) : activePage === "providers" ? (
              <ProviderSettingsPage {...providerPageProps} />
            ) : activePage === "semesters" ? (
              <SemesterSettingsPage
                currentSemester={semester}
                onSelectSemester={onSelectSemester}
                onWorkspaceChanged={onWorkspaceChanged}
              />
            ) : activePage === "archive" ? (
              <ArchiveSettingsPage onWorkspaceChanged={onWorkspaceChanged} />
            ) : activePage === "skills" ? (
              <SkillSettingsPage
                skills={localSkills}
                enabledSkills={enabledSkills}
                gitStatus={gitStatus}
                selectedSkillId={selectedSkillId}
                skillContent={skillContent}
                skillBusy={skillBusy}
                skillStatusLine={skillStatusLine}
                onSelectSkill={setSelectedSkillId}
                onSkillContentChange={setSkillContent}
                onSaveSkill={saveSkillContent}
                onImportSkill={importSkillFolder}
                onOpenSkillFolder={openSkillFolder}
                onToggleSkill={toggleSkill}
              />
            ) : activePage === "memory" ? (
              <MemorySettingsPage />
            ) : activePage === "mcp" ? (
              <McpSettingsPage />
            ) : (
              <AboutUpdateSettingsPage />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function SettingsNavButton({ active, icon, title, detail, onClick }: { active: boolean; icon: ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cx("flex w-full min-w-0 items-start gap-2 rounded-[var(--radius-card)] px-3 py-2.5 text-left transition active:scale-[0.99]", active ? "bg-card text-foreground shadow-sm ring-1 ring-black/[0.05]" : "text-muted-foreground hover:bg-card hover:text-foreground")}
      onClick={onClick}
    >
      <span className={cx("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)]", active ? "bg-foreground text-background" : "bg-muted text-muted-foreground")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{title}</span>
        <span className="block truncate text-[11px]">{detail}</span>
      </span>
    </button>
  );
}
