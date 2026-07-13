import { useState } from "react";
import type { SettingsPage } from "@/hooks/useWorkspaceSessionController";

export function useAppDialogState() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPage>("providers");
  const [coursesOpen, setCoursesOpen] = useState(false);

  function openSettings(page: SettingsPage = "providers") {
    setSettingsInitialPage(page);
    setSettingsOpen(true);
  }

  return {
    settingsOpen,
    settingsInitialPage,
    openSettings,
    closeSettings: () => setSettingsOpen(false),
    coursesOpen,
    openCourses: () => setCoursesOpen(true),
    closeCourses: () => setCoursesOpen(false),
  };
}
