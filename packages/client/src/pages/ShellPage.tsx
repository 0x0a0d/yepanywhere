import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type ShellInfo } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { useToastContext } from "../contexts/ToastContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

const SHELL_STATE_POLL_INTERVAL_MS = 2000;
const SSE_RECONNECT_BASE_MS = 1000;
const SSE_RECONNECT_MAX_MS = 10000;
type ShellConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
type ModifierKey = "ctrl" | "alt" | "meta" | "shift";
type ArrowDirection = "left" | "up" | "down" | "right";
type DpadStage = "idle" | "once" | "repeat";
type VirtualModifierMode = "off" | "armed" | "locked";

function applyCtrlToData(data: string): string {
  if (data.length !== 1) return data;
  if (data >= "a" && data <= "z") {
    return String.fromCharCode(data.charCodeAt(0) - 96);
  }
  if (data >= "A" && data <= "Z") {
    return String.fromCharCode(data.charCodeAt(0) - 64);
  }
  if (data === " ") return "\u0000";
  if (data === "[") return "\u001b";
  if (data === "\\") return "\u001c";
  if (data === "]") return "\u001d";
  if (data === "^") return "\u001e";
  if (data === "_") return "\u001f";
  if (data === "?") return "\u007f";
  return data;
}

function applyVirtualModifiers(
  data: string,
  modifiers: Record<ModifierKey, VirtualModifierMode | boolean>,
): string {
  let next = data;
  const ctrl = modifiers.ctrl === true || modifiers.ctrl === "armed" || modifiers.ctrl === "locked";
  const alt = modifiers.alt === true || modifiers.alt === "armed" || modifiers.alt === "locked";
  const meta = modifiers.meta === true || modifiers.meta === "armed" || modifiers.meta === "locked";
  const shift =
    modifiers.shift === true ||
    modifiers.shift === "armed" ||
    modifiers.shift === "locked";

  if (shift && next.length === 1 && next >= "a" && next <= "z") {
    next = next.toUpperCase();
  }

  if (ctrl) {
    next = applyCtrlToData(next);
  }

  if (alt || meta) {
    next = `\u001b${next}`;
  }

  return next;
}

export function ShellPage() {
  const { shellId } = useParams<{ shellId: string }>();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const basePath = useRemoteBasePath();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const [shell, setShell] = useState<ShellInfo | null>(null);
  const [afterSeq, setAfterSeq] = useState(0);
  const [isClosing, setIsClosing] = useState(false);
  const [connectionState, setConnectionState] =
    useState<ShellConnectionState>("connecting");
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const afterSeqRef = useRef(0);
  const resizeFrameRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const closedByServerRef = useRef(false);
  const arrowRepeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const arrowPressingRef = useRef(false);
  const arrowOriginRef = useRef<{ x: number; y: number } | null>(null);
  const arrowRepeatDelayRef = useRef(110);
  const [dpadDirection, setDpadDirection] = useState<ArrowDirection | null>(null);
  const [dpadStage, setDpadStage] = useState<DpadStage>("idle");
  const dpadLastTriggeredModeRef = useRef<DpadStage>("idle");
  const dpadLastTriggeredDirectionRef = useRef<ArrowDirection | null>(null);
  const [virtualModifiers, setVirtualModifiers] = useState<
    Record<ModifierKey, VirtualModifierMode>
  >({
    ctrl: "off",
    alt: "off",
    meta: "off",
    shift: "off",
  });
  const [physicalModifiers, setPhysicalModifiers] = useState<
    Record<ModifierKey, boolean>
  >({
    ctrl: false,
    alt: false,
    meta: false,
    shift: false,
  });

  const effectiveModifiers = useMemo(
    (): Record<ModifierKey, boolean | VirtualModifierMode> => ({
      ctrl:
        physicalModifiers.ctrl || virtualModifiers.ctrl !== "off"
          ? virtualModifiers.ctrl === "off"
            ? true
            : virtualModifiers.ctrl
          : "off",
      alt:
        physicalModifiers.alt || virtualModifiers.alt !== "off"
          ? virtualModifiers.alt === "off"
            ? true
            : virtualModifiers.alt
          : "off",
      meta:
        physicalModifiers.meta || virtualModifiers.meta !== "off"
          ? virtualModifiers.meta === "off"
            ? true
            : virtualModifiers.meta
          : "off",
      shift:
        physicalModifiers.shift || virtualModifiers.shift !== "off"
          ? virtualModifiers.shift === "off"
            ? true
            : virtualModifiers.shift
          : "off",
    }),
    [physicalModifiers, virtualModifiers],
  );
  const effectiveModifiersRef = useRef(effectiveModifiers);

  useEffect(() => {
    effectiveModifiersRef.current = effectiveModifiers;
  }, [effectiveModifiers]);

  useEffect(() => {
    afterSeqRef.current = afterSeq;
  }, [afterSeq]);

  useEffect(() => {
    if (!terminalHostRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#0b1220",
        foreground: "#d6deeb",
        cursor: "#d6deeb",
        selectionBackground: "rgba(148, 163, 184, 0.28)",
      },
      fontSize: 13,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
      cursorBlink: true,
      convertEol: false,
      allowProposedApi: false,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalHostRef.current);
    fitAddon.fit();
    term.focus();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const disposeData = term.onData((data) => {
      if (!shellId) return;
      const nextData = applyVirtualModifiers(data, effectiveModifiersRef.current);
      void api.writeShellInput(shellId, nextData).catch(() => {
        // Ignore transient input failures; shell polling will surface state changes.
      });
      setVirtualModifiers((prev) => ({
        ctrl: prev.ctrl === "armed" ? "off" : prev.ctrl,
        alt: prev.alt === "armed" ? "off" : prev.alt,
        meta: prev.meta === "armed" ? "off" : prev.meta,
        shift: prev.shift === "armed" ? "off" : prev.shift,
      }));
    });

    const disposeKey = term.onKey(({ domEvent }) => {
      setPhysicalModifiers({
        ctrl: domEvent.ctrlKey,
        alt: domEvent.altKey,
        meta: domEvent.metaKey,
        shift: domEvent.shiftKey,
      });
    });

    const sendResize = () => {
      if (!shellId || !fitAddonRef.current || !terminalRef.current) return;
      fitAddonRef.current.fit();
      const cols = terminalRef.current.cols;
      const rows = terminalRef.current.rows;
      const lastSize = lastSizeRef.current;
      if (lastSize?.cols === cols && lastSize?.rows === rows) return;
      lastSizeRef.current = { cols, rows };
      void api.resizeShell(shellId, cols, rows).catch(() => {
        // Resize is best-effort.
      });
    };

    const scheduleResize = () => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        sendResize();
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      scheduleResize();
    });
    resizeObserver.observe(terminalHostRef.current);
    scheduleResize();

    return () => {
      disposeData.dispose();
      disposeKey.dispose();
      resizeObserver.disconnect();
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [shellId]);

  useEffect(() => {
    const syncModifiers = (event: KeyboardEvent) => {
      setPhysicalModifiers({
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      });
    };

    const clearModifiers = () => {
      setPhysicalModifiers({
        ctrl: false,
        alt: false,
        meta: false,
        shift: false,
      });
    };

    window.addEventListener("keydown", syncModifiers);
    window.addEventListener("keyup", syncModifiers);
    window.addEventListener("blur", clearModifiers);

    return () => {
      window.removeEventListener("keydown", syncModifiers);
      window.removeEventListener("keyup", syncModifiers);
      window.removeEventListener("blur", clearModifiers);
    };
  }, []);

  useEffect(() => {
    if (!shellId) return;

    let cancelled = false;
    const loadShell = async () => {
      try {
        const result = await api.getShell(shellId);
        if (!cancelled) {
          setShell(result.shell);
        }
      } catch (error) {
        if (!cancelled) {
          showToast(
            error instanceof Error ? error.message : t("shellNotFound"),
            "error",
          );
          navigate("/projects");
        }
      }
    };

    void loadShell();
    return () => {
      cancelled = true;
    };
  }, [navigate, shellId, showToast, t]);

  useEffect(() => {
    if (!shellId || !terminalRef.current) return;

    let cancelled = false;
    let currentSource: EventSource | null = null;

    const connect = () => {
      if (cancelled) return;
      setConnectionState(
        reconnectAttemptRef.current === 0 ? "connecting" : "reconnecting",
      );

      const eventSource = new EventSource(
        `${basePath}/api/shells/${encodeURIComponent(shellId)}/stream?after=${afterSeqRef.current}`,
        { withCredentials: true },
      );
      currentSource = eventSource;

      eventSource.addEventListener("ready", () => {
        reconnectAttemptRef.current = 0;
        setConnectionState("connected");
      });

      eventSource.addEventListener("output", (event) => {
        if (cancelled || !terminalRef.current) return;
        const chunk = JSON.parse((event as MessageEvent).data) as {
          seq: number;
          data: string;
        };
        terminalRef.current.write(chunk.data);
        afterSeqRef.current = chunk.seq;
        setAfterSeq(chunk.seq);
      });

      eventSource.addEventListener("done", () => {
        closedByServerRef.current = true;
        setConnectionState("disconnected");
        eventSource.close();
      });

      eventSource.onerror = () => {
        eventSource.close();
        if (cancelled || closedByServerRef.current) {
          setConnectionState("disconnected");
          return;
        }

        reconnectAttemptRef.current += 1;
        setConnectionState("reconnecting");
        const delayMs = Math.min(
          SSE_RECONNECT_BASE_MS * 2 ** (reconnectAttemptRef.current - 1),
          SSE_RECONNECT_MAX_MS,
        );
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delayMs);
      };
    };

    closedByServerRef.current = false;
    reconnectAttemptRef.current = 0;
    connect();

    return () => {
      cancelled = true;
      closedByServerRef.current = true;
      setConnectionState("disconnected");
      currentSource?.close();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [basePath, shellId]);

  useEffect(() => {
    if (!shellId) return;

    let cancelled = false;
    const pollShellState = async () => {
      try {
        const result = await api.getShell(shellId);
        if (!cancelled) {
          setShell(result.shell);
        }
      } catch {
        // Best-effort metadata refresh.
      }
    };

    void pollShellState();
    const timer = setInterval(() => {
      void pollShellState();
    }, SHELL_STATE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [shellId]);

  const handleStop = async () => {
    if (!shellId) return;
    setIsClosing(true);
    try {
      await api.closeShell(shellId);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("shellCloseError"),
        "error",
      );
    } finally {
      setIsClosing(false);
    }
  };

  const handleRemove = async () => {
    if (!shellId) return;
    setIsClosing(true);
    try {
      await api.closeShell(shellId);
      navigate("/shells");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("shellCloseError"),
        "error",
      );
    } finally {
      setIsClosing(false);
    }
  };

  const toggleVirtualModifier = (key: ModifierKey, locked = false) => {
    setVirtualModifiers((prev) => {
      const current = prev[key];
      if (locked) {
        return { ...prev, [key]: current === "locked" ? "off" : "locked" };
      }
      if (current === "off") return { ...prev, [key]: "armed" };
      if (current === "armed") return { ...prev, [key]: "off" };
      return { ...prev, [key]: "off" };
    });
  };

  const handleEsc = async () => {
    if (!shellId || shell?.state !== "running") return;
    try {
      await api.writeShellInput(shellId, "\u001b");
      terminalRef.current?.focus();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("shellInputError"),
        "error",
      );
    }
  };

  const handleSpecialInput = async (data: string) => {
    if (!shellId || shell?.state !== "running") return;
    try {
      await api.writeShellInput(shellId, applyVirtualModifiers(data, effectiveModifiersRef.current));
      terminalRef.current?.focus();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("shellInputError"),
        "error",
      );
    }
  };

  const handlePaste = async () => {
    if (!shellId || shell?.state !== "running") return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      await api.writeShellInput(shellId, text);
      terminalRef.current?.focus();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("shellPasteError" as never),
        "error",
      );
    }
  };

  const preserveTerminalFocus = (
    event: React.MouseEvent<HTMLButtonElement> | React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    if (isWideScreen) {
      terminalRef.current?.focus();
    }
  };

  const createModifierHandlers = (key: ModifierKey) => {
    let tapTimer: ReturnType<typeof setTimeout> | null = null;
    return {
      onClick: () => {
        if (tapTimer) {
          clearTimeout(tapTimer);
          tapTimer = null;
          toggleVirtualModifier(key, true);
          return;
        }
        tapTimer = setTimeout(() => {
          tapTimer = null;
          toggleVirtualModifier(key, false);
        }, 220);
      },
    };
  };

  const ctrlHandlers = createModifierHandlers("ctrl");
  const altHandlers = createModifierHandlers("alt");
  const metaHandlers = createModifierHandlers("meta");
  const shiftHandlers = createModifierHandlers("shift");

  const sendArrow = async (direction: ArrowDirection) => {
    const mapping: Record<ArrowDirection, string> = {
      left: "\u001b[D",
      up: "\u001b[A",
      down: "\u001b[B",
      right: "\u001b[C",
    };
    await handleSpecialInput(mapping[direction]);
  };

  const stopArrowRepeat = () => {
    arrowPressingRef.current = false;
    arrowOriginRef.current = null;
    setDpadDirection(null);
    setDpadStage("idle");
    dpadLastTriggeredModeRef.current = "idle";
    dpadLastTriggeredDirectionRef.current = null;
    if (arrowRepeatRef.current) {
      clearInterval(arrowRepeatRef.current);
      arrowRepeatRef.current = null;
    }
  };

  const startArrowRepeat = (
    event: React.PointerEvent<HTMLButtonElement>,
    initialDirection?: ArrowDirection,
  ) => {
    preserveTerminalFocus(event);
    arrowPressingRef.current = true;
    arrowOriginRef.current = { x: event.clientX, y: event.clientY };
    setDpadDirection(null);
    setDpadStage("idle");
    dpadLastTriggeredModeRef.current = "idle";
    dpadLastTriggeredDirectionRef.current = null;

    const ONCE_THRESHOLD = 28;
    const REPEAT_THRESHOLD = 56;

    const resolveDirection = (
      clientX: number,
      clientY: number,
    ): { direction: ArrowDirection | null; distance: number; mode: DpadStage } => {
      if (!arrowOriginRef.current) {
        return { direction: initialDirection ?? null, distance: 0, mode: "idle" };
      }
      const dx = clientX - arrowOriginRef.current.x;
      const dy = clientY - arrowOriginRef.current.y;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      if (distance < ONCE_THRESHOLD) {
        return { direction: null, distance, mode: "idle" };
      }
      const mode: DpadStage = distance < REPEAT_THRESHOLD ? "once" : "repeat";
      if (Math.abs(dx) > Math.abs(dy)) {
        return { direction: dx > 0 ? "right" : "left", distance, mode };
      }
      return { direction: dy > 0 ? "down" : "up", distance, mode };
    };

    let lastDirection: ArrowDirection | null = null;
    const getRepeatDelay = (distance: number) => {
      const extra = Math.max(0, distance - REPEAT_THRESHOLD);
      return Math.max(35, 110 - Math.min(70, extra * 2.2));
    };

    const startRepeatLoop = () => {
      if (arrowRepeatRef.current) return;
      arrowRepeatRef.current = setInterval(() => {
        if (!arrowPressingRef.current || !lastDirection) return;
        void sendArrow(lastDirection);
      }, arrowRepeatDelayRef.current);
    };

    const stopRepeatLoop = () => {
      if (arrowRepeatRef.current) {
        clearInterval(arrowRepeatRef.current);
        arrowRepeatRef.current = null;
      }
    };

    const triggerMode = (
      mode: DpadStage,
      direction: ArrowDirection,
      distance: number,
    ) => {
      const lastMode = dpadLastTriggeredModeRef.current;
      const lastDirectionTriggered = dpadLastTriggeredDirectionRef.current;
      if (mode === "repeat") {
        const nextDelay = getRepeatDelay(distance);
        if (arrowRepeatDelayRef.current !== nextDelay) {
          arrowRepeatDelayRef.current = nextDelay;
          stopRepeatLoop();
          if (lastMode === "repeat" && lastDirectionTriggered === direction) {
            startRepeatLoop();
            return;
          }
        }
      }

      if (lastMode === mode && lastDirectionTriggered === direction) {
        return;
      }

      dpadLastTriggeredModeRef.current = mode;
      dpadLastTriggeredDirectionRef.current = direction;

      if (mode === "once") {
        stopRepeatLoop();
        void sendArrow(direction);
        return;
      }

      if (mode === "repeat") {
        stopRepeatLoop();
        void sendArrow(direction);
        startRepeatLoop();
      }
    };

    const handleMove = (moveEvent: PointerEvent) => {
      const { direction, mode, distance } = resolveDirection(
        moveEvent.clientX,
        moveEvent.clientY,
      );
      lastDirection = direction;
      setDpadDirection(direction);
      if (!direction) {
        setDpadStage("idle");
        dpadLastTriggeredModeRef.current = "idle";
        dpadLastTriggeredDirectionRef.current = null;
        stopRepeatLoop();
        return;
      }
      setDpadStage(mode);
      if (mode === "once" || mode === "repeat") {
        triggerMode(mode, direction, distance);
      }
    };

    const handleEnd = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      stopArrowRepeat();
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
  };

  const title = useMemo(() => shell?.projectName ?? t("shellTitle"), [shell, t]);

  if (!shellId) {
    return <div className="error">{t("shellNotFound")}</div>;
  }

  return (
    <div
      className={
        isWideScreen
          ? "main-content-wrapper shell-page-root"
          : "main-content-mobile shell-page-root"
      }
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained shell-page-container"
            : "main-content-mobile-inner shell-page-container"
        }
      >
        <PageHeader
          title={title}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div
            className={
              isWideScreen
                ? "page-content-inner"
                : "page-content-inner shell-page-content-mobile"
            }
          >
            {shell && (
              <div className="shell-page-meta">
                <div className="shell-page-meta-left">
                  <span className="shell-page-path">{shell.cwd}</span>
                  <div className="shell-page-statuses">
                    <span className={`shell-page-state shell-state-${shell.state}`}>
                      {shell.state === "running"
                        ? t("shellRunning")
                        : t("shellExited")}
                    </span>
                    <span
                      className={`shell-page-state shell-connection-state shell-connection-${connectionState}`}
                    >
                      {t(`shellConnection${connectionState[0]?.toUpperCase()}${connectionState.slice(1)}` as never)}
                    </span>
                  </div>
                </div>
                {shell.state === "running" ? (
                  <button
                    type="button"
                    className="shell-action-button"
                    onClick={handleStop}
                    onMouseDown={preserveTerminalFocus}
                    disabled={isClosing}
                  >
                    {isClosing ? t("shellClosing") : t("shellStop" as never)}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="shell-action-button"
                    onClick={handleRemove}
                    onMouseDown={preserveTerminalFocus}
                    disabled={isClosing}
                  >
                    {isClosing ? t("shellClosing") : t("shellRemove" as never)}
                  </button>
                )}
              </div>
            )}
            <div className="shell-terminal shell-terminal-interactive">
              <div ref={terminalHostRef} className="shell-terminal-xterm" />
            </div>
            {!isWideScreen ? (
              <div className="shell-special-keys">
                <div className="shell-special-keys-row">
                  <div className="shell-special-keys-group">
                    <button
                      type="button"
                      className="shell-special-key"
                      onMouseDown={preserveTerminalFocus}
                      onClick={() => void handleEsc()}
                    >
                      {t("shellModifierEsc" as never)}
                    </button>
                    <button
                      type="button"
                      className="shell-special-key"
                      onMouseDown={preserveTerminalFocus}
                      onClick={() => void handleSpecialInput("\t")}
                    >
                      {t("shellModifierTab" as never)}
                    </button>
                    <button
                      type="button"
                      className={`shell-special-key shell-special-dpad ${dpadStage !== "idle" ? "active" : ""}`}
                      onPointerDown={(event) => startArrowRepeat(event, "up")}
                    >
                      <span
                        className={`shell-dpad-safe-zone ${dpadStage === "once" ? "visible" : ""}`}
                      />
                      <span
                        className={`shell-dpad-repeat-zone ${dpadStage === "repeat" ? "visible" : ""}`}
                      />
                      <span className="shell-dpad-arrow up">↑</span>
                      <span className="shell-dpad-arrow right">→</span>
                      <span className="shell-dpad-arrow down">↓</span>
                      <span className="shell-dpad-arrow left">←</span>
                    </button>
                  </div>
                  <div className="shell-special-keys-group shell-special-keys-group-right">
                    <button
                      type="button"
                      className="shell-special-key icon-only"
                      onMouseDown={preserveTerminalFocus}
                      onClick={() => void handlePaste()}
                    >
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
                        <rect x="9" y="2" width="6" height="4" rx="1" />
                        <path d="M9 4H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="shell-special-keys-row">
                    <button
                      type="button"
                      className={`shell-special-key ${effectiveModifiers.ctrl !== "off" ? "active warning" : ""} ${virtualModifiers.ctrl === "locked" ? "holding" : ""}`}
                      onMouseDown={preserveTerminalFocus}
                      onClick={ctrlHandlers.onClick}
                    >
                      {t("shellModifierCtrl" as never)}
                    </button>
                  <div className="shell-special-keys-group shell-special-keys-group-right">
                    <button
                      type="button"
                      className={`shell-special-key ${effectiveModifiers.alt !== "off" ? "active warning" : ""} ${virtualModifiers.alt === "locked" ? "holding" : ""}`}
                      onMouseDown={preserveTerminalFocus}
                      onClick={altHandlers.onClick}
                    >
                      {t("shellModifierAlt" as never)}
                    </button>
                    <button
                      type="button"
                      className={`shell-special-key ${effectiveModifiers.meta !== "off" ? "active warning" : ""} ${virtualModifiers.meta === "locked" ? "holding" : ""}`}
                      onMouseDown={preserveTerminalFocus}
                      onClick={metaHandlers.onClick}
                    >
                      {t("shellModifierMeta" as never)}
                    </button>
                    <button
                      type="button"
                      className={`shell-special-key ${effectiveModifiers.shift !== "off" ? "active warning" : ""} ${virtualModifiers.shift === "locked" ? "holding" : ""}`}
                      onMouseDown={preserveTerminalFocus}
                      onClick={shiftHandlers.onClick}
                    >
                      {t("shellModifierShift" as never)}
                    </button>
                  </div>
                </div>
                <div className="shell-special-keys-notice">
                  {t("shellModifierHoldNotice" as never)}
                </div>
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
