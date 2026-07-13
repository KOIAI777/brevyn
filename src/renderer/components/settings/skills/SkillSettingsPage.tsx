import {
  BookOpen,
  FileText,
  FolderOpen,
  GitBranch,
  Layers3,
  Pencil,
  Plus,
  Save,
  Search,
  Sparkles,
  Tags,
  TerminalSquare,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActionButton } from "@/components/settings/shared/SettingsControls";
import { DropdownSelect, type DropdownOption } from "@/components/ui/DropdownSelect";
import { cx } from "@/lib/cn";
import type { GitStatus, SkillCategory, SkillItem, SkillLibrarySettings } from "../../../../types/domain";

const UNCATEGORIZED_SKILL_CATEGORY_ID = "uncategorized";
const OBSOLETE_SKILL_CATEGORY_IDS = new Set(["study-assignment"]);
const ALL_SKILL_CATEGORY_FILTER = "all";
const DEFAULT_SKILL_LIBRARY_SETTINGS: SkillLibrarySettings = {
  categories: [
    { id: "creative-design", name: "创意设计", system: true },
    { id: "tools", name: "工具", system: true },
    { id: "academic", name: "学术", system: true },
    { id: UNCATEGORIZED_SKILL_CATEGORY_ID, name: "未分类", system: true },
  ],
  assignments: {},
};

export function SkillSettingsPage({
  skills,
  enabledSkills,
  gitStatus,
  selectedSkillId,
  skillContent,
  skillBusy,
  skillStatusLine,
  onSelectSkill,
  onSkillContentChange,
  onSaveSkill,
  onImportSkill,
  onOpenSkillFolder,
  onToggleSkill,
}: {
  skills: SkillItem[];
  enabledSkills: number;
  gitStatus: GitStatus | null;
  selectedSkillId: string;
  skillContent: string;
  skillBusy: boolean;
  skillStatusLine: string;
  onSelectSkill: (skillId: string) => void;
  onSkillContentChange: (content: string) => void;
  onSaveSkill: () => void;
  onImportSkill: () => void;
  onOpenSkillFolder: (skillId: string) => void;
  onToggleSkill: (skill: SkillItem) => void;
}) {
  const [librarySettings, setLibrarySettings] = useState<SkillLibrarySettings>(DEFAULT_SKILL_LIBRARY_SETTINGS);
  const [categoryFilter, setCategoryFilter] = useState(ALL_SKILL_CATEGORY_FILTER);
  const [skillQuery, setSkillQuery] = useState("");
  const [categoryPanelOpen, setCategoryPanelOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState("");
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryStatusLine, setLibraryStatusLine] = useState("");
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId);
  const selectedSkillCategoryId = selectedSkill ? categoryIdForSkill(selectedSkill, librarySettings) : UNCATEGORIZED_SKILL_CATEGORY_ID;
  const selectedSkillCategoryName = categoryNameForId(librarySettings, selectedSkillCategoryId);
  const categoryFilterOptions = useMemo<DropdownOption[]>(() => [
    { value: ALL_SKILL_CATEGORY_FILTER, label: "全部" },
    ...librarySettings.categories.map((category) => ({ value: category.id, label: category.name })),
  ], [librarySettings.categories]);
  const categoryAssignmentOptions = useMemo<DropdownOption[]>(() => (
    librarySettings.categories.map((category) => ({ value: category.id, label: category.name }))
  ), [librarySettings.categories]);
  const filteredSkills = useMemo(() => {
    const query = skillQuery.trim().toLowerCase();
    return skills
      .filter((skill) => {
        const categoryId = categoryIdForSkill(skill, librarySettings);
        if (categoryFilter !== ALL_SKILL_CATEGORY_FILTER && categoryId !== categoryFilter) return false;
        if (!query) return true;
        return normalizedSkillSearchText(skill, categoryNameForId(librarySettings, categoryId)).includes(query);
      })
      .sort(compareSkillsForList);
  }, [categoryFilter, librarySettings, skillQuery, skills]);

  useEffect(() => {
    let cancelled = false;
    void window.brevyn.skills
      .librarySettings()
      .then((settings) => {
        if (!cancelled) setLibrarySettings(normalizeLibrarySettings(settings));
      })
      .catch((error) => {
        if (!cancelled) setLibraryStatusLine(`加载分类失败：${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveLibrarySettings(next: SkillLibrarySettings, message: string) {
    setLibraryBusy(true);
    setLibraryStatusLine("");
    try {
      const saved = await window.brevyn.skills.updateLibrarySettings(normalizeLibrarySettings(next));
      setLibrarySettings(normalizeLibrarySettings(saved));
      setLibraryStatusLine(message);
    } catch (error) {
      setLibraryStatusLine(`分类更新失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLibraryBusy(false);
    }
  }

  function updateSkillCategory(skillId: string, categoryId: string) {
    const validCategoryId = librarySettings.categories.some((category) => category.id === categoryId) ? categoryId : UNCATEGORIZED_SKILL_CATEGORY_ID;
    void saveLibrarySettings({
      ...librarySettings,
      assignments: {
        ...librarySettings.assignments,
        [skillId]: validCategoryId,
      },
    }, "已更新 Skill 分类。");
  }

  function createCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    const id = uniqueCategoryId(slugFromCategoryName(name), librarySettings.categories);
    void saveLibrarySettings({
      ...librarySettings,
      categories: [...librarySettings.categories.filter((category) => category.id !== UNCATEGORIZED_SKILL_CATEGORY_ID), { id, name }, uncategorizedCategory(librarySettings)],
    }, `已创建分类“${name}”。`);
    setNewCategoryName("");
  }

  function startRenameCategory(category: SkillCategory) {
    setEditingCategoryId(category.id);
    setEditingCategoryName(category.name);
  }

  function commitRenameCategory() {
    const name = editingCategoryName.trim();
    if (!editingCategoryId || !name) return;
    void saveLibrarySettings({
      ...librarySettings,
      categories: librarySettings.categories.map((category) => category.id === editingCategoryId ? { ...category, name } : category),
    }, `已重命名分类“${name}”。`);
    setEditingCategoryId("");
    setEditingCategoryName("");
  }

  function deleteCategory(categoryId: string) {
    const category = librarySettings.categories.find((item) => item.id === categoryId);
    if (!category || category.system) return;
    const assignments = Object.fromEntries(Object.entries(librarySettings.assignments).map(([skillId, assignedCategoryId]) => [
      skillId,
      assignedCategoryId === categoryId ? UNCATEGORIZED_SKILL_CATEGORY_ID : assignedCategoryId,
    ]));
    void saveLibrarySettings({
      categories: librarySettings.categories.filter((item) => item.id !== categoryId),
      assignments,
    }, `已删除分类“${category.name}”。`);
    if (categoryFilter === categoryId) setCategoryFilter(ALL_SKILL_CATEGORY_FILTER);
  }

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-muted/20">
        <div className="shrink-0 border-b bg-card px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-xs font-semibold">
              <BookOpen className="h-3.5 w-3.5" />
              <span>Skill 配置</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">{skills.length} 个 · {enabledSkills} 个启用</span>
            </div>
            <ActionButton icon={<Upload className="h-3.5 w-3.5" />} label="导入" onClick={onImportSkill} />
          </div>

          <div className="mt-3 grid gap-2">
            <div className="flex gap-2">
              <DropdownSelect
                className="min-w-0 flex-1"
                buttonClassName="rounded-[var(--radius-control)] border bg-background text-[11px] font-medium shadow-none"
                menuClassName="text-[11px]"
                value={categoryFilter}
                options={categoryFilterOptions}
                onChange={setCategoryFilter}
                ariaLabel="Skill 分类筛选"
                menuMinWidth={180}
                menuItemHeight={36}
                menuMaxVisibleItems={7}
              />
              <button
                type="button"
                className={cx(
                  "inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-[11px] font-semibold transition",
                  categoryPanelOpen ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setCategoryPanelOpen((open) => !open)}
              >
                <Tags className="h-3.5 w-3.5" />
                分类
              </button>
            </div>

            <label className="flex h-8 items-center gap-2 rounded-[var(--radius-control)] border bg-background px-2 text-[11px] text-muted-foreground">
              <Search className="h-3.5 w-3.5" />
              <input
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
                placeholder="搜索 Skill"
              />
            </label>
          </div>

          {categoryPanelOpen && (
            <CategoryManagerPanel
              settings={librarySettings}
              newCategoryName={newCategoryName}
              editingCategoryId={editingCategoryId}
              editingCategoryName={editingCategoryName}
              busy={libraryBusy}
              onNewCategoryNameChange={setNewCategoryName}
              onCreateCategory={createCategory}
              onStartRename={startRenameCategory}
              onEditingCategoryNameChange={setEditingCategoryName}
              onCommitRename={commitRenameCategory}
              onCancelRename={() => {
                setEditingCategoryId("");
                setEditingCategoryName("");
              }}
              onDeleteCategory={deleteCategory}
            />
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] brevyn-scrollbar-thin">
          {filteredSkills.length > 0 ? filteredSkills.map((skill) => (
            <SkillListItem
              key={skill.id}
              skill={skill}
              categoryName={categoryNameForId(librarySettings, categoryIdForSkill(skill, librarySettings))}
              selected={skill.id === selectedSkillId}
              onSelect={() => onSelectSkill(skill.id)}
              onToggle={() => onToggleSkill(skill)}
            />
          )) : (
            <div className="px-3 py-8 text-center text-[11px] leading-5 text-muted-foreground">没有匹配的 Skill。</div>
          )}
        </div>
        {libraryStatusLine && <div className="shrink-0 border-t bg-card px-3 py-2 text-[11px] text-muted-foreground">{libraryStatusLine}</div>}
      </section>

      <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-xs font-semibold">
                <FileText className="h-3.5 w-3.5" />
                <span className="min-w-0 truncate" title={selectedSkill?.name || "技能内容"}>{selectedSkill?.name || "技能内容"}</span>
              </div>
              <div className="flex items-center gap-2">
                <ActionButton
                  icon={<FolderOpen className="h-3.5 w-3.5" />}
                  label="打开"
                  onClick={() => selectedSkill && onOpenSkillFolder(selectedSkill.id)}
                />
                <ActionButton icon={<Save className="h-3.5 w-3.5" />} label="保存" onClick={onSaveSkill} primary disabled={!selectedSkill || skillBusy || !skillContent.trim()} />
              </div>
            </div>
          </div>

          {selectedSkill ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 [backface-visibility:hidden] [contain:layout_paint] [scrollbar-gutter:stable] brevyn-scrollbar">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded bg-muted px-1.5 py-0.5">{selectedSkill.version}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5">{selectedSkillCategoryName}</span>
                  {!!selectedSkill.resources?.length && <span className="rounded bg-muted px-1.5 py-0.5">{selectedSkill.resources.length} 个资源</span>}
                  {selectedSkill.sourcePath && <span className="min-w-0 max-w-full break-all rounded bg-muted px-1.5 py-0.5" title={selectedSkill.sourcePath}>{selectedSkill.sourcePath}</span>}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background p-2">
                  <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                    <Tags className="h-3.5 w-3.5" />
                    <span>分类</span>
                  </div>
                  <DropdownSelect
                    className="min-w-[10rem]"
                    buttonClassName="rounded-[var(--radius-control)] border bg-card text-[11px] font-medium shadow-none"
                    menuClassName="text-[11px]"
                    value={selectedSkillCategoryId}
                    options={categoryAssignmentOptions}
                    disabled={libraryBusy}
                    onChange={(value) => updateSkillCategory(selectedSkill.id, value)}
                    ariaLabel="当前 Skill 分类"
                    menuMinWidth={180}
                    menuItemHeight={36}
                    menuMaxVisibleItems={7}
                  />
                </div>
                <div className="grid gap-2 rounded-lg border bg-background p-2 text-[11px] text-muted-foreground sm:grid-cols-2">
                  <SkillMetaRow label="触发词" values={selectedSkill.triggers} />
                  <SkillMetaRow label="标签" values={selectedSkill.tags} />
                  <SkillMetaRow label="范围" values={selectedSkill.scopes} />
                  <SkillMetaRow label="允许工具" values={selectedSkill.allowedTools} />
                </div>
                {!!selectedSkill.resources?.length && (
                  <div className="rounded-lg border bg-background p-2">
                    <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold">
                      <Layers3 className="h-3.5 w-3.5" />
                      Skill 资源
                    </div>
                    <div className="max-h-40 space-y-1 overflow-auto pr-1 brevyn-scrollbar">
                      {selectedSkill.resources.slice(0, 24).map((resource) => (
                        <div key={resource.relativePath} className="flex items-center gap-2 rounded bg-muted/45 px-2 py-1 text-[11px] text-muted-foreground">
                          <span className="shrink-0 rounded bg-background px-1 py-0.5 text-[10px]">{resource.kind}</span>
                          <span className="min-w-0 flex-1 truncate">{resource.relativePath}</span>
                          <span className="shrink-0">{resource.sizeLabel}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <textarea
                  className="h-[360px] min-h-[280px] w-full resize-none rounded-lg border bg-background px-3 py-3 font-mono text-[12px] leading-5 text-foreground outline-none [scrollbar-gutter:stable] brevyn-scrollbar"
                  value={skillContent}
                  onChange={(event) => onSkillContentChange(event.target.value)}
                  spellCheck={false}
                />
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border bg-background p-3">
                    <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
                      <Layers3 className="h-3.5 w-3.5" />
                      Skill 运行时
                    </div>
                    <div className="space-y-2 text-[12px] leading-5 text-muted-foreground">
                      <MetricRow label="路由" value="已启用 Skill" />
                      <MetricRow label="范围" value="全局" />
                      <MetricRow label="上下文" value="感知上下文窗口" />
                    </div>
                  </div>

                  <div className="rounded-lg border bg-background p-3">
                    <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
                      <GitBranch className="h-3.5 w-3.5" />
                      Git / 编辑工具
                    </div>
                    <div className="space-y-2 text-[12px] leading-5 text-muted-foreground">
                      <div className="rounded-md bg-muted/50 px-2 py-2">
                        <span className="font-medium text-foreground">{gitStatus?.branch || "本地/mock"}</span>
                        <span> · </span>
                        <span>{gitStatus?.summary || "Git 服务占位实现已就绪。"}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        <ToolChip icon={<Wrench className="h-3 w-3" />} label="编辑文件" />
                        <ToolChip icon={<TerminalSquare className="h-3 w-3" />} label="运行命令" />
                        <ToolChip icon={<GitBranch className="h-3 w-3" />} label="git diff" />
                        <ToolChip icon={<Sparkles className="h-3 w-3" />} label="技能路由" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="m-3 rounded-md border border-dashed px-3 py-8 text-center text-[12px] text-muted-foreground">
              选择一个 Skill 查看或编辑它的 `SKILL.md`。
            </div>
          )}

          {skillStatusLine && <div className="mx-3 mb-3 mt-3 shrink-0 rounded-md bg-muted/55 px-2 py-2 text-[11px] text-muted-foreground">{skillStatusLine}</div>}
          {skillBusy && !skillStatusLine && <div className="mx-3 mb-3 mt-3 shrink-0 rounded-md bg-muted/55 px-2 py-2 text-[11px] text-muted-foreground">正在处理 Skill 文件...</div>}
        </section>
      </aside>
    </div>
  );
}

function CategoryManagerPanel({
  settings,
  newCategoryName,
  editingCategoryId,
  editingCategoryName,
  busy,
  onNewCategoryNameChange,
  onCreateCategory,
  onStartRename,
  onEditingCategoryNameChange,
  onCommitRename,
  onCancelRename,
  onDeleteCategory,
}: {
  settings: SkillLibrarySettings;
  newCategoryName: string;
  editingCategoryId: string;
  editingCategoryName: string;
  busy: boolean;
  onNewCategoryNameChange: (value: string) => void;
  onCreateCategory: () => void;
  onStartRename: (category: SkillCategory) => void;
  onEditingCategoryNameChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDeleteCategory: (categoryId: string) => void;
}) {
  return (
    <div className="mt-3 rounded-[var(--radius-card)] border bg-background p-2">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-foreground">
        <Tags className="h-3.5 w-3.5" />
        管理分类
      </div>
      <div className="space-y-1.5">
        {settings.categories.map((category) => (
          <div key={category.id} className="flex items-center gap-1.5 rounded-[var(--radius-control)] bg-muted/45 px-2 py-1.5">
            {editingCategoryId === category.id ? (
              <>
                <input
                  className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-[11px] outline-none"
                  value={editingCategoryName}
                  maxLength={24}
                  onChange={(event) => onEditingCategoryNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onCommitRename();
                    if (event.key === "Escape") onCancelRename();
                  }}
                  autoFocus
                />
                <button type="button" className="rounded bg-foreground px-2 py-1 text-[10px] font-semibold text-background disabled:opacity-50" disabled={busy || !editingCategoryName.trim()} onClick={onCommitRename}>保存</button>
                <button type="button" className="rounded px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground" disabled={busy} onClick={onCancelRename}>取消</button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{category.name}</span>
                {category.system ? <span className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">默认</span> : null}
                <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40" disabled={busy || category.system} title="重命名" onClick={() => onStartRename(category)}>
                  <Pencil className="h-3 w-3" />
                </button>
                <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-destructive disabled:opacity-40" disabled={busy || category.system} title="删除分类" onClick={() => onDeleteCategory(category.id)}>
                  <Trash2 className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          className="min-w-0 flex-1 rounded-[var(--radius-control)] border bg-card px-2 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
          value={newCategoryName}
          maxLength={24}
          onChange={(event) => onNewCategoryNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onCreateCategory();
          }}
          placeholder="新分类名称"
        />
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-control)] bg-foreground px-2.5 text-[11px] font-semibold text-background transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !newCategoryName.trim()}
          onClick={onCreateCategory}
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>
    </div>
  );
}

function SkillListItem({ skill, categoryName, selected, onSelect, onToggle }: { skill: SkillItem; categoryName: string; selected: boolean; onSelect: () => void; onToggle: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cx(
        "group flex h-11 w-full cursor-pointer items-center gap-2 border-b border-border/45 px-3 text-left transition-colors",
        selected ? "bg-accent text-accent-foreground" : "bg-transparent hover:bg-muted/45",
        !skill.enabled && "opacity-55",
      )}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      title={`${skill.name}\n${skill.description}`}
    >
      <span className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", selected ? "bg-background/70 text-foreground" : "bg-background text-muted-foreground")}>
        <BookOpen className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1 leading-none">
        <div className="truncate text-sm font-medium" title={skill.name}>{skill.name}</div>
        <div className={cx("mt-1 truncate text-[10px]", selected ? "text-accent-foreground/65" : "text-muted-foreground")}>
          {categoryName} · {skill.enabled ? "已启用" : "已停用"}
        </div>
      </div>
      <SkillSwitch enabled={skill.enabled} onClick={onToggle} />
    </div>
  );
}

function SkillSwitch({ enabled, onClick }: { enabled: boolean; onClick: () => void }) {
  const label = enabled ? "停用 Skill" : "启用 Skill";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cx(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-200",
        enabled ? "border-emerald-500 bg-emerald-500" : "border-border bg-muted hover:bg-muted/80",
      )}
    >
      <span
        className={cx(
          "pointer-events-none h-6 w-6 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200",
          enabled ? "translate-x-[21px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function SkillMetaRow({ label, values }: { label: string; values?: string[] }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">{label}</div>
      {values?.length ? (
        <div className="flex flex-wrap gap-1">
          {values.slice(0, 6).map((value) => (
            <span key={value} className="max-w-full truncate rounded-full border bg-background/70 px-1.5 py-0.5 text-[10px] leading-none">
              {value}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground/60">暂无</div>
      )}
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-2 py-2">
      <span>{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function ToolChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-card px-2 py-1.5">
      {icon}
      <span className="truncate">{label}</span>
    </div>
  );
}

function normalizeLibrarySettings(settings: SkillLibrarySettings): SkillLibrarySettings {
  const sourceCategories = settings.categories?.length ? settings.categories : [];
  const mergedCategories = [...sourceCategories, ...DEFAULT_SKILL_LIBRARY_SETTINGS.categories, uncategorizedCategory(DEFAULT_SKILL_LIBRARY_SETTINGS)].reduce<SkillCategory[]>((result, category) => {
    const id = slugFromCategoryName(category.id || category.name);
    const name = category.name.trim().slice(0, 24);
    if (OBSOLETE_SKILL_CATEGORY_IDS.has(id)) return result;
    if (!id || !name || result.some((item) => item.id === id)) return result;
    result.push({ id, name, system: isDefaultSkillCategoryId(id) || Boolean(category.system) });
    return result;
  }, []);
  const assignments: Record<string, string> = {};
  for (const [skillId, categoryId] of Object.entries(settings.assignments || {})) {
    if (mergedCategories.some((category) => category.id === categoryId)) assignments[skillId] = categoryId;
  }
  const withoutUncategorized = mergedCategories.filter((category) => category.id !== UNCATEGORIZED_SKILL_CATEGORY_ID);
  return {
    categories: [...withoutUncategorized, uncategorizedCategory({ categories: mergedCategories })],
    assignments,
  };
}

function categoryIdForSkill(skill: SkillItem, settings: SkillLibrarySettings): string {
  const assigned = settings.assignments[skill.id];
  return settings.categories.some((category) => category.id === assigned) ? assigned : inferredCategoryIdForSkill(skill, settings);
}

function inferredCategoryIdForSkill(skill: SkillItem, settings: SkillLibrarySettings): string {
  const text = normalizedSkillSearchText(skill, skill.category || "");
  const hasCategory = (id: string) => settings.categories.some((category) => category.id === id);
  if (hasCategory("academic") && includesAny(text, [
    "ppt-master",
    "paper reading",
    "academic blueprint",
    "journal club",
    "presentation",
    "slides",
    "deck",
    "pptx",
    "生成ppt",
    "做ppt",
    "演示文稿",
    "汇报",
    "展示",
  ])) return "academic";
  if (hasCategory("academic") && includesAny(text, [
    "nature-",
    "academic",
    "citation",
    "literature",
    "manuscript",
    "paper",
    "publication",
    "research",
    "reviewer",
    "journal",
    "patent",
    "experiment",
    "科研",
    "学术",
    "论文",
    "文献",
    "期刊",
    "引用",
    "审稿",
    "专利",
    "实验",
  ])) return "academic";
  if (hasCategory("creative-design") && includesAny(text, ["design", "creative", "canvas", "image", "frontend", "theme", "slides", "pptx", "创意", "设计"])) return "creative-design";
  if (hasCategory("tools") && includesAny(text, ["tool", "file", "workspace", "editor", "pdf", "docx", "xlsx", "script", "git", "工具", "文件"])) return "tools";
  return UNCATEGORIZED_SKILL_CATEGORY_ID;
}

function categoryNameForId(settings: SkillLibrarySettings, categoryId: string): string {
  return settings.categories.find((category) => category.id === categoryId)?.name || "未分类";
}

function uncategorizedCategory(settings: Pick<SkillLibrarySettings, "categories">): SkillCategory {
  return settings.categories.find((category) => category.id === UNCATEGORIZED_SKILL_CATEGORY_ID) ?? DEFAULT_SKILL_LIBRARY_SETTINGS.categories.find((category) => category.id === UNCATEGORIZED_SKILL_CATEGORY_ID)!;
}

function isDefaultSkillCategoryId(id: string): boolean {
  return DEFAULT_SKILL_LIBRARY_SETTINGS.categories.some((category) => category.id === id);
}

function normalizedSkillSearchText(skill: SkillItem, categoryName: string): string {
  return [
    skill.slug,
    skill.id,
    skill.name,
    skill.description,
    skill.category,
    categoryName,
    ...(skill.tags || []),
    ...(skill.triggers || []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function compareSkillsForList(left: SkillItem, right: SkillItem): number {
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function uniqueCategoryId(baseId: string, categories: SkillCategory[]): string {
  const normalizedBase = baseId || "category";
  let candidate = normalizedBase;
  let suffix = 2;
  while (categories.some((category) => category.id === candidate)) {
    candidate = `${normalizedBase}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function slugFromCategoryName(value: string): string {
  const ascii = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (ascii) return ascii;
  let hash = 0;
  for (const char of value.trim()) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return hash ? `category-${hash.toString(36)}` : "";
}
