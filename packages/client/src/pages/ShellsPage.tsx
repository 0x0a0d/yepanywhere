import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Project } from "../types";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { useToastContext } from "../contexts/ToastContext";
import { useProjects } from "../hooks/useProjects";
import { useShells } from "../hooks/useShells";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

export function ShellsPage() {
  const { t } = useI18n();
  const { projects, loading: loadingProjects } = useProjects();
  const { shells, loading: loadingShells, refetch } = useShells();
  const { showToast } = useToastContext();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(null);

  const projectRows = useMemo(() => {
    const byProject = new Map<string, typeof shells>();
    for (const shell of shells) {
      const existing = byProject.get(shell.projectId);
      if (existing) {
        existing.push(shell);
      } else {
        byProject.set(shell.projectId, [shell]);
      }
    }

    return [...projects]
      .sort((a, b) => {
        const aRunningCount =
          byProject.get(a.id)?.filter((shell) => shell.state === "running")
            .length ?? 0;
        const bRunningCount =
          byProject.get(b.id)?.filter((shell) => shell.state === "running")
            .length ?? 0;
        if (aRunningCount !== bRunningCount) return bRunningCount - aRunningCount;

        const aCount = byProject.get(a.id)?.length ?? 0;
        const bCount = byProject.get(b.id)?.length ?? 0;
        if (aCount !== bCount) return bCount - aCount;
        const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
        const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
        return bTime - aTime;
      })
      .map((project) => ({
        project,
        shells: byProject.get(project.id) ?? [],
      }));
  }, [projects, shells]);

  const formatShellCount = (count: number) =>
    count === 1 ? "1 shell" : `${count} shells`;

  const toggleExpanded = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const handleCreateShell = async (project: Project) => {
    setCreatingProjectId(project.id);
    try {
      const { shell } = await api.openProjectTerminal(project.id);
      await refetch();
      setExpandedProjects((prev) => new Set(prev).add(project.id));
      navigate(`${basePath}/shells/${encodeURIComponent(shell.id)}`);
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : t("newSessionOpenTerminalError", { message: "unknown error" }),
        "error",
      );
    } finally {
      setCreatingProjectId(null);
    }
  };

  const isLoading = loadingProjects || loadingShells;

  const PlusIcon = () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );

  const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={expanded ? "shells-chevron expanded" : "shells-chevron"}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner"
        }
      >
        <PageHeader
          title={t("pageTitleShells" as never)}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {isLoading ? (
              <p className="loading">{t("sidebarLoadingSessions")}</p>
            ) : (
              <div className="shells-project-list">
                {projectRows.map(({ project, shells: projectShells }) => {
                  const isExpanded = expandedProjects.has(project.id);
                  const shellCount = projectShells.length;
                  const runningCount = projectShells.filter(
                    (shell) => shell.state === "running",
                  ).length;
                  const exitedCount = shellCount - runningCount;

                  return (
                    <section key={project.id} className="shells-project-card">
                      <div className="shells-project-header">
                        <button
                          type="button"
                          className={`shells-project-main ${shellCount > 0 ? "expandable" : ""}`}
                          onClick={() =>
                            shellCount > 0 && toggleExpanded(project.id)
                          }
                        >
                          <span className="shells-project-name">
                            {project.name}
                          </span>
                          <div className="shells-project-summary">
                            <span className="shells-project-count">
                              {formatShellCount(shellCount)}
                            </span>
                            {runningCount > 0 ? (
                              <span className="shell-page-state shell-state-running">
                                {runningCount} running
                              </span>
                            ) : shellCount > 0 ? (
                              <span className="shell-page-state shell-state-exited">
                                {exitedCount} exited
                              </span>
                            ) : null}
                          </div>
                        </button>
                        <div className="shells-project-actions">
                          <button
                            type="button"
                            className="shells-project-action"
                            onClick={() => void handleCreateShell(project)}
                            disabled={creatingProjectId === project.id}
                            aria-label={t("newSessionOpenTerminalAction")}
                          >
                            <PlusIcon />
                          </button>
                          {shellCount > 0 ? (
                            <button
                              type="button"
                              className="shells-project-action"
                              onClick={() => toggleExpanded(project.id)}
                              aria-label={
                                isExpanded
                                  ? t("actionCollapse" as never)
                                  : t("actionExpand" as never)
                              }
                            >
                              <ChevronIcon expanded={isExpanded} />
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {isExpanded && shellCount > 0 ? (
                        <ul className="shells-active-list">
                          {projectShells.map((shell) => (
                            <li key={shell.id}>
                              <button
                                type="button"
                                className="shells-active-link"
                                onClick={() =>
                                  navigate(
                                    `${basePath}/shells/${encodeURIComponent(shell.id)}`,
                                  )
                                }
                              >
                                <span className="shells-active-path">
                                  {shell.cwd}
                                </span>
                                <span
                                  className={`shell-page-state shell-state-${shell.state}`}
                                >
                                  {shell.state === "running"
                                    ? t("shellRunning")
                                    : t("shellExited")}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
