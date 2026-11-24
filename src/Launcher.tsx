import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Search,
  Calculator,
  FolderSearch,
  AppWindow,
  Terminal,
  Globe,
  History,
  Copy,
  Check,
  ArrowLeft,
  Trash2,
  AlertTriangle,
  X,
  ExternalLink,
  Shield,
  FolderOpen,
  Info,
  Pin,
  Play,
  Power,
} from "lucide-react";
import { initTheme } from "./theme";
import { useT } from "./i18n";
import { useSettingsSync } from "./hooks/useSettingsSync";
import type { HistoryEntry, LauncherAction, LauncherItem, LauncherSearchResponse } from "./launcher/types";
import { ResultRow } from "./launcher/ResultRow";
import { applyPreviewThemeParams, bridgeInvoke, bridgeListen, isTauriRuntime } from "./utils/tauriBridge";
import "./surfaces.css";

const MODE_META: Record<string, { labelKey: string; icon: typeof Search }> = {
  all: { labelKey: "launcher.mode.all", icon: Search },
  calc: { labelKey: "launcher.mode.calc", icon: Calculator },
  files: { labelKey: "launcher.mode.files", icon: FolderSearch },
  windows: { labelKey: "launcher.mode.windows", icon: AppWindow },
  shell: { labelKey: "launcher.mode.shell", icon: Terminal },
  web: { labelKey: "launcher.mode.web", icon: Globe },
  history: { labelKey: "launcher.mode.history", icon: History },
};

const QUICK_PREFIXES = [
  { prefix: "= ", key: "launcher.chip.calc" },
  { prefix: "? ", key: "launcher.chip.files" },
  { prefix: "w ", key: "launcher.chip.windows" },
  { prefix: "> ", key: "launcher.chip.shell" },
  { prefix: "g ", key: "launcher.chip.web" },
];

const ACTION_KEYS: Record<string, string> = {
  open: "launcher.action.open",
  run_as_admin: "launcher.action.runAsAdmin",
  open_location: "launcher.action.openLocation",
  properties: "dockmenu.properties",
  copy_path: "launcher.action.copyPath",
  toggle_pin_start: "launcher.action.pinStart",
  toggle_pin_dock: "launcher.action.pinDock",
};

const CANONICAL_BADGES: Record<string, string> = {
  app: "App",
  file: "File",
  folder: "Folder",
  tool: "Tool",
  window: "Window",
  settings: "Settings",
  web: "Web",
  shell: "Shell",
  system: "System",
  calc: "Calc",
  calculator: "Calc",
  running: "Running",
  recent: "Recent",
};

function getMaxLauncherHeight(scale: number): number {
  const availH =
    typeof window !== "undefined" && window.screen?.availHeight
      ? window.screen.availHeight
      : 900;
  return Math.max(92, Math.min(640, Math.floor((availH - 180) / scale)));
}

type ConfirmState = {
  item: LauncherItem;
  action?: LauncherAction;
} | null;

function clampScale(raw: unknown): number {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? "1"));
  return Number.isFinite(n) ? Math.min(1.75, Math.max(0.75, n)) : 1;
}

function clampLauncherWidth(raw: unknown): number {
  const n = parseInt(String(raw ?? "660"), 10);
  return Number.isFinite(n) ? Math.min(820, Math.max(520, n)) : 660;
}

export default function Launcher() {
  const t = useT();
  const [surfaceOpen, setSurfaceOpen] = useState(() => !isTauriRuntime());
  const [query, setQuery] = useState("");
  const [scale, setScale] = useState<number>(() =>
    clampScale(localStorage.getItem("nectar-scale"))
  );
  const [launcherWidth, setLauncherWidth] = useState<number>(() =>
    clampLauncherWidth(localStorage.getItem("nectar-launcher-width"))
  );
  const [showChips, setShowChips] = useState<boolean>(
    () => localStorage.getItem("nectar-launcher-show-chips") !== "false"
  );
  const [response, setResponse] = useState<LauncherSearchResponse>({
    mode: "all",
    clean_query: "",
    items: [],
    calc_card: null,
    everything_available: false,
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionsItem, setActionsItem] = useState<LauncherItem | null>(null);
  const [actionIndex, setActionIndex] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [calcCopied, setCalcCopied] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchSeqRef = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const skipDebounceQueryRef = useRef<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const revealRafRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 1900);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    applyPreviewThemeParams();
    return initTheme({ backdrop: false });
  }, []);

  useEffect(() => {
    let cancelled = false;
    bridgeInvoke<Record<string, unknown>>("load_settings")
      .then((s) => {
        if (cancelled || !s) return;
        if (s["nectar-scale"] != null) {
          setScale(clampScale(s["nectar-scale"]));
        }
        if (s["nectar-launcher-width"] != null) {
          setLauncherWidth(clampLauncherWidth(s["nectar-launcher-width"]));
        }
        if (s["nectar-launcher-show-chips"] !== undefined && s["nectar-launcher-show-chips"] !== null) {
          setShowChips(String(s["nectar-launcher-show-chips"]) !== "false");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useSettingsSync(
    {
      "nectar-scale": (v) => setScale(clampScale(v)),
      "nectar-launcher-width": (v) => setLauncherWidth(clampLauncherWidth(v)),
      "nectar-launcher-show-chips": (v) => setShowChips(v !== false && v !== "false"),
    },
    undefined,
    {
      onReset: () => {
        setScale(1);
        setLauncherWidth(660);
        setShowChips(true);
      },
    }
  );

  // Measure unzoomed surface dims cleanly and sync Tauri window bounds so no empty hitboxes remain
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const el = surfaceRef.current;
    if (!el) return;
    let raf = 0;
    const syncSize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = Math.max(launcherWidth, Math.ceil(el.offsetWidth) + 16);
        const maxH = getMaxLauncherHeight(scale);
        const h = Math.min(maxH, Math.max(92, Math.ceil(el.offsetHeight) + 16));
        bridgeInvoke("resize_shell_window", { width: w, height: h }).catch(() => {});
      });
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(el);
    syncSize();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [scale, launcherWidth]);

  const runSearch = useCallback((q: string) => {
    const seq = ++searchSeqRef.current;
    bridgeInvoke<LauncherSearchResponse>("search_launcher", { query: q })
      .then((res) => {
        if (seq !== searchSeqRef.current || !res) return;
        setResponse(res);
        setSelectedIndex(0);
        setConfirmState(null);
      })
      .catch((err) => {
        console.error("search_launcher error:", err);
      });
  }, []);

  useEffect(() => {
    if (skipDebounceQueryRef.current === query) {
      skipDebounceQueryRef.current = null;
      return;
    }
    const timer = window.setTimeout(() => runSearch(query), query.trim().length > 0 ? 18 : 0);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  useEffect(() => {
    let cancelled = false;
    let unShown: (() => void) | undefined;
    let unHidden: (() => void) | undefined;

    bridgeInvoke<string | null>("take_pending_launcher_query")
      .then((pending) => {
        if (cancelled || !pending) return;
        skipDebounceQueryRef.current = pending;
        setQuery(pending);
        runSearch(pending);
        requestAnimationFrame(() => {
          if (cancelled) return;
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      })
      .catch(() => {});

    const pShown = bridgeListen<{ query?: string; scale?: number }>("shell-window-shown", (payload) => {
      if (cancelled) return;
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      setSurfaceOpen(false);
      setActionsItem(null);
      setHistoryOpen(false);
      setConfirmState(null);
      setSelectedIndex(0);
      if (typeof payload?.scale === "number") {
        setScale(clampScale(payload.scale));
      }
      if (typeof payload?.query === "string") {
        skipDebounceQueryRef.current =
          payload.query !== queryRef.current ? payload.query : null;
        setQuery(payload.query);
        runSearch(payload.query);
      } else {
        skipDebounceQueryRef.current = null;
        runSearch(queryRef.current);
      }
      revealRafRef.current = requestAnimationFrame(() => {
        revealRafRef.current = null;
        if (cancelled) return;
        setSurfaceOpen(true);
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.select();
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unShown = fn;
    }).catch(() => {});

    const pHidden = bridgeListen("shell-window-hidden", () => {
      if (cancelled) return;
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      setSurfaceOpen(false);
      setActionsItem(null);
      setConfirmState(null);
    }).then((fn) => {
      if (cancelled) fn();
      else unHidden = fn;
    }).catch(() => {});

    Promise.all([pShown, pHidden]).then(() => {
      if (!cancelled) {
        bridgeInvoke("shell_surface_ready").catch(() => {});
      }
    });

    return () => {
      cancelled = true;
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      unShown?.();
      unHidden?.();
    };
  }, [runSearch]);

  const localizeBadge = useCallback(
    (rawBadge: string): string => {
      const trimmed = rawBadge.trim();
      if (!trimmed) return rawBadge;
      if (trimmed === "launcher.badge.running") return "Running";
      if (trimmed.startsWith("launcher.badge.")) {
        return t(trimmed);
      }
      const lower = trimmed.toLowerCase();
      if (CANONICAL_BADGES[lower]) {
        return CANONICAL_BADGES[lower];
      }
      if (lower === "web search") return t("launcher.mode.web");
      if (lower === "history") return t("launcher.badge.history");
      return rawBadge;
    },
    [t]
  );

  const displayedItems: LauncherItem[] = useMemo(() => {
    if (!historyOpen) {
      return response.items.map((item) => {
        const nextBadge = localizeBadge(item.badge);
        return nextBadge === item.badge ? item : { ...item, badge: nextBadge };
      });
    }
    const q = query.trim().toLowerCase();
    return historyEntries
      .filter(
        (h) =>
          !q ||
          h.query.toLowerCase().includes(q) ||
          h.item_title.toLowerCase().includes(q)
      )
      .map((h) => ({
        id: `hist:${h.timestamp_ms}:${h.item_id}`,
        kind: "history",
        title: h.item_title || h.query,
        subtitle: h.query ? `${h.query} — ${h.target}` : h.target,
        badge: t("launcher.badge.history"),
        icon: null,
        target: h.query || h.target,
        args: null,
        hwnd: null,
        score: 5000,
        match_indices: [],
        requires_confirm: false,
        actions: [],
      }));
  }, [historyOpen, historyEntries, response.items, query, t, localizeBadge]);

  const toggleHistory = useCallback(() => {
    setActionsItem(null);
    setConfirmState(null);
    setHistoryOpen((prev) => {
      const next = !prev;
      if (next) {
        setHistoryLoading(true);
        bridgeInvoke<HistoryEntry[]>("get_launcher_history")
          .then((list) => setHistoryEntries(Array.isArray(list) ? list : []))
          .catch(() => setHistoryEntries([]))
          .finally(() => setHistoryLoading(false));
      }
      setSelectedIndex(0);
      return next;
    });
  }, []);

  const hideWindow = useCallback(() => {
    bridgeInvoke("hide_launcher").catch(() => {});
  }, []);

  const markCalcCopied = useCallback(() => {
    setCalcCopied(true);
    showToast(t("launcher.copied"));
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCalcCopied(false);
      copiedTimerRef.current = null;
    }, 1400);
  }, [showToast, t]);

  const copyCalcValue = useCallback(() => {
    if (!response.calc_card) return;
    bridgeInvoke("copy_text_to_clipboard", { text: response.calc_card.raw })
      .then(() => markCalcCopied())
      .catch((err) => showToast(String(err)));
  }, [response.calc_card, markCalcCopied, showToast]);

  const translateActionMessage = useCallback(
    (raw: string) =>
      raw.startsWith("start.action.") || raw.startsWith("launcher.action.") ? t(raw) : raw,
    [t]
  );

  const executeItem = useCallback(
    async (item: LauncherItem, bypassConfirm = false) => {
      if (item.kind === "history") {
        setHistoryOpen(false);
        setQuery(item.target);
        inputRef.current?.focus();
        return;
      }
      if (
        item.requires_confirm &&
        !bypassConfirm &&
        confirmState?.item.id !== item.id
      ) {
        setConfirmState({ item });
        return;
      }
      setConfirmState(null);
      try {
        await bridgeInvoke("execute_launcher_item", {
          item,
          query: queryRef.current,
          confirmed: true,
        });
        if (item.kind === "calc") {
          markCalcCopied();
          return;
        }
        hideWindow();
      } catch (err) {
        const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
        showToast(translateActionMessage(raw));
      }
    },
    [confirmState, hideWindow, markCalcCopied, showToast, translateActionMessage]
  );

  const executeAction = useCallback(
    async (item: LauncherItem, action: LauncherAction, bypassConfirm = false) => {
      const needsConfirm =
        (item.requires_confirm && action.id === "open") || action.destructive;
      if (needsConfirm && !bypassConfirm) {
        setActionsItem(null);
        setConfirmState({ item, action });
        return;
      }
      setConfirmState(null);
      try {
        const msg = await bridgeInvoke<string>("execute_launcher_action", {
          item,
          actionId: action.id,
          query: queryRef.current,
          confirmed: true,
        });
        setActionsItem(null);
        if (
          (action.id === "open" ||
            action.id === "run_as_admin" ||
            action.id === "open_location" ||
            action.id === "properties") &&
          msg !== "start.action.adminUnavailable"
        ) {
          hideWindow();
        } else {
          showToast(msg ? translateActionMessage(msg) : t("launcher.actionDone"));
        }
      } catch (err) {
        const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
        showToast(translateActionMessage(raw));
      }
    },
    [hideWindow, showToast, t, translateActionMessage]
  );

  useEffect(() => {
    if (selectedIndex >= displayedItems.length && displayedItems.length > 0) {
      setSelectedIndex(0);
    } else if (displayedItems.length === 0 && selectedIndex !== 0) {
      setSelectedIndex(0);
    }
  }, [displayedItems.length, selectedIndex]);

  useEffect(() => {
    const selectedEl = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, actionIndex, actionsItem, historyOpen]);

  const handleGlobalKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && e.code === "KeyH") {
        e.preventDefault();
        toggleHistory();
        return;
      }

      if (actionsItem) {
        if (e.key === "Escape" || (e.key === "ArrowLeft" && document.activeElement === inputRef.current)) {
          e.preventDefault();
          setActionsItem(null);
          inputRef.current?.focus();
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActionIndex((prev) => (prev + 1) % Math.max(1, actionsItem.actions.length));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActionIndex((prev) =>
            (prev - 1 + actionsItem.actions.length) % Math.max(1, actionsItem.actions.length)
          );
          return;
        }
        if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
          if (activeTag === "BUTTON" && document.activeElement?.closest(".launcher-actions-list") == null) {
            return;
          }
          e.preventDefault();
          const act = actionsItem.actions[actionIndex];
          if (act) executeAction(actionsItem, act);
          return;
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        if (confirmState) {
          setConfirmState(null);
          inputRef.current?.focus();
        } else if (historyOpen) {
          setHistoryOpen(false);
          inputRef.current?.focus();
        } else if (queryRef.current.length > 0) {
          setQuery("");
          inputRef.current?.focus();
        } else {
          hideWindow();
        }
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (displayedItems.length > 0) {
          setSelectedIndex((prev) => (prev + 1) % displayedItems.length);
          setConfirmState(null);
        }
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (displayedItems.length > 0) {
          setSelectedIndex((prev) => (prev - 1 + displayedItems.length) % displayedItems.length);
          setConfirmState(null);
        }
        return;
      }

      const active = displayedItems[selectedIndex];
      const onInput = document.activeElement === inputRef.current;

      if (active && e.ctrlKey && e.shiftKey && e.key === "Enter") {
        const adminAct = active.actions.find((a) => a.id === "run_as_admin");
        if (adminAct) {
          e.preventDefault();
          executeAction(active, adminAct);
        }
        return;
      }

      if (active && e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyO") {
        const locAct = active.actions.find((a) => a.id === "open_location");
        if (locAct) {
          e.preventDefault();
          executeAction(active, locAct);
        }
        return;
      }

      if (
        active &&
        ((e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyP") ||
          (e.altKey && !e.ctrlKey && e.key === "Enter"))
      ) {
        const propsAct = active.actions.find((a) => a.id === "properties");
        if (propsAct) {
          e.preventDefault();
          executeAction(active, propsAct);
          return;
        }
      }

      if (active && e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC") {
        const hasDocSel = (window.getSelection()?.toString().length ?? 0) > 0;
        const inp = inputRef.current;
        const hasInputSel =
          onInput && inp != null && (inp.selectionEnd ?? 0) > (inp.selectionStart ?? 0);
        if (!hasDocSel && !hasInputSel) {
          const copyAct = active.actions.find((a) => a.id === "copy_path");
          if (copyAct) {
            e.preventDefault();
            executeAction(active, copyAct);
            return;
          }
        }
      }

      if (
        active &&
        active.actions.length > 0 &&
        ((e.ctrlKey && !e.altKey && e.code === "KeyK") ||
          (onInput &&
            e.key === "ArrowRight" &&
            inputRef.current &&
            inputRef.current.selectionStart === queryRef.current.length))
      ) {
        e.preventDefault();
        setActionsItem(active);
        setActionIndex(0);
        return;
      }

      if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
        if (activeTag === "BUTTON" && !document.activeElement?.classList.contains("launcher-row")) {
          return;
        }
        e.preventDefault();
        if (active) {
          executeItem(active);
        } else if (response.calc_card) {
          copyCalcValue();
        }
      }
    },
    [
      actionIndex,
      actionsItem,
      confirmState,
      copyCalcValue,
      displayedItems,
      executeAction,
      executeItem,
      hideWindow,
      historyOpen,
      response.calc_card,
      selectedIndex,
      toggleHistory,
    ]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, [handleGlobalKey]);

  const activeModeKey = historyOpen ? "history" : response.mode;
  const modeMeta = MODE_META[activeModeKey] ?? MODE_META.all;
  const ModeIcon = modeMeta.icon;
  const activeOptionId =
    !actionsItem && displayedItems[selectedIndex]
      ? `launcher-opt-${selectedIndex}`
      : undefined;

  const actionLabel = (act: LauncherAction) => {
    if (act.label.startsWith("launcher.action.")) {
      return t(act.label);
    }
    if (act.id === "open") {
      if (
        actionsItem?.requires_confirm ||
        act.label === "Run command" ||
        act.label === "Execute command"
      ) {
        return t("launcher.action.runCommand");
      }
      return t("launcher.action.open");
    }
    if (act.id === "copy_path") {
      if (actionsItem?.kind === "calc" || act.label.toLowerCase() === "copy result") {
        return t("launcher.action.copyResult");
      }
      return t("launcher.action.copyPath");
    }
    if (act.id === "toggle_pin_start") {
      if (act.label.toLowerCase().includes("unpin") && !act.label.includes("/")) {
        return t("launcher.action.unpinStart");
      }
      return t("launcher.action.pinStart");
    }
    if (act.id === "toggle_pin_dock") {
      if (act.label.toLowerCase().includes("unpin") && !act.label.includes("/")) {
        return t("launcher.action.unpinDock");
      }
      return t("launcher.action.pinDock");
    }
    return ACTION_KEYS[act.id] ? t(ACTION_KEYS[act.id]) : act.label;
  };

  const renderActionIcon = (actionId: string, destructive: boolean) => {
    if (destructive) return <Power size={14} strokeWidth={1.9} />;
    switch (actionId) {
      case "run_as_admin":
        return <Shield size={14} strokeWidth={1.8} />;
      case "open_location":
        return <FolderOpen size={14} strokeWidth={1.8} />;
      case "properties":
        return <Info size={14} strokeWidth={1.8} />;
      case "copy_path":
        return <Copy size={14} strokeWidth={1.8} />;
      case "toggle_pin_start":
      case "toggle_pin_dock":
        return <Pin size={14} strokeWidth={1.8} />;
      case "open":
        return actionsItem?.requires_confirm ? (
          <Play size={14} strokeWidth={1.8} />
        ) : (
          <ExternalLink size={14} strokeWidth={1.8} />
        );
      default:
        return <ExternalLink size={14} strokeWidth={1.8} />;
    }
  };

  const maxSurfaceHeight = Math.max(76, getMaxLauncherHeight(scale) - 16);

  return (
    <div
      className="launcher-viewport"
      style={
        {
          zoom: scale,
          width: `${100 / scale}vw`,
          minHeight: `${100 / scale}vh`,
        } as CSSProperties
      }
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          hideWindow();
        }
      }}
    >
      <div
        ref={surfaceRef}
        className={`nectar-shell-surface launcher-surface shell-anim-surface shell-anim-launcher ${surfaceOpen ? "is-open" : "is-hidden"}`}
        style={{ maxHeight: `${maxSurfaceHeight}px`, width: `min(${launcherWidth}px, 100%)` }}
      >
        <div className="launcher-header">
          <div className="launcher-input-icon">
            <ModeIcon size={18} strokeWidth={2} />
          </div>
          <input
            ref={inputRef}
            className="launcher-input"
            type="text"
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={!actionsItem && displayedItems.length > 0}
            aria-controls="launcher-results-list"
            aria-activedescendant={activeOptionId}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActionsItem(null);
            }}
            placeholder={t("launcher.placeholder")}
            aria-label={t("launcher.placeholder")}
          />
          {query && (
            <button
              type="button"
              className="launcher-icon-pill"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label={t("launcher.clear")}
              title={t("launcher.clear")}
            >
              <X size={13} strokeWidth={2} />
            </button>
          )}
          <span className="launcher-mode-pill">
            {t(modeMeta.labelKey)}
            {activeModeKey === "files" && (
              <span
                className={`everything-dot${response.everything_available ? " active" : ""}`}
                title={
                  response.everything_available
                    ? t("launcher.everythingActive")
                    : t("launcher.everythingFallback")
                }
              />
            )}
          </span>
          <button
            type="button"
            className={`launcher-icon-pill${historyOpen ? " active" : ""}`}
            onClick={toggleHistory}
            aria-label={t("launcher.history")}
            aria-pressed={historyOpen}
            title={`${t("launcher.history")} (Ctrl+H)`}
          >
            <History size={14} strokeWidth={1.8} />
          </button>
        </div>

        {showChips && !query && !historyOpen && !actionsItem && (
          <div className="launcher-prefix-strip">
            {QUICK_PREFIXES.map((chip) => (
              <button
                key={chip.prefix}
                type="button"
                className="launcher-prefix-chip"
                onClick={() => {
                  setQuery(chip.prefix);
                  inputRef.current?.focus();
                }}
              >
                <kbd>{chip.prefix.trim()}</kbd>
                <span>{t(chip.key)}</span>
              </button>
            ))}
          </div>
        )}

        {response.calc_card && !historyOpen && !actionsItem && (
          <button
            type="button"
            className="launcher-calc-hero"
            onClick={copyCalcValue}
          >
            <div className="launcher-calc-left">
              <span className="launcher-calc-expr">{response.calc_card.expression}</span>
              <span className="launcher-calc-value">= {response.calc_card.formatted}</span>
            </div>
            <div className="launcher-calc-right">
              <span className="launcher-calc-note">{response.calc_card.note}</span>
              <span className={`launcher-copy-pill${calcCopied ? " copied" : ""}`}>
                {calcCopied ? <Check size={13} /> : <Copy size={13} />}
                <span>{calcCopied ? t("launcher.copied") : t("launcher.copy")}</span>
              </span>
            </div>
          </button>
        )}

        {confirmState && (
          <div className="launcher-confirm-banner" role="alert">
            <AlertTriangle size={15} />
            <span>
              {t("launcher.confirmPrompt", { title: confirmState.item.title })}
            </span>
            <div className="launcher-confirm-actions">
              <button
                type="button"
                className="launcher-confirm-btn danger"
                onClick={() => {
                  if (confirmState.action) {
                    executeAction(confirmState.item, confirmState.action, true);
                  } else {
                    executeItem(confirmState.item, true);
                  }
                }}
              >
                {t("launcher.confirmBtn")}
              </button>
              <button
                type="button"
                className="launcher-confirm-btn"
                onClick={() => {
                  setConfirmState(null);
                  inputRef.current?.focus();
                }}
              >
                {t("launcher.cancelBtn")}
              </button>
            </div>
          </div>
        )}

        <div
          id="launcher-results-list"
          ref={listRef}
          className="launcher-body"
          role={!actionsItem && displayedItems.length > 0 ? "listbox" : undefined}
        >
          {actionsItem ? (
            <div className="launcher-actions-drawer">
              <div className="launcher-actions-head">
                <button
                  type="button"
                  className="launcher-back-btn"
                  onClick={() => {
                    setActionsItem(null);
                    inputRef.current?.focus();
                  }}
                >
                  <ArrowLeft size={14} />
                  <span>{t("launcher.back")}</span>
                </button>
                <span className="launcher-actions-target">{actionsItem.title}</span>
              </div>
              <div className="launcher-actions-list" role="menu">
                {actionsItem.actions.map((act, idx) => (
                  <button
                    key={act.id}
                    type="button"
                    role="menuitem"
                    data-selected={idx === actionIndex ? "true" : undefined}
                    className={`launcher-action-row${idx === actionIndex ? " selected" : ""}${
                      act.destructive ? " destructive" : ""
                    }`}
                    onMouseMove={() => setActionIndex(idx)}
                    onClick={() => executeAction(actionsItem, act)}
                  >
                    <span className="launcher-action-row-left">
                      {renderActionIcon(act.id, act.destructive)}
                      <span>{actionLabel(act)}</span>
                    </span>
                    {act.shortcut && <kbd>{act.shortcut}</kbd>}
                  </button>
                ))}
              </div>
            </div>
          ) : historyOpen && historyLoading ? (
            <div className="launcher-empty">
              <span>{t("launcher.loadingHistory")}</span>
            </div>
          ) : displayedItems.length > 0 ? (
            <>
              {historyOpen && (
                <div className="launcher-section-header">
                  <span>{t("launcher.recentSearches")}</span>
                  <button
                    type="button"
                    className="launcher-clear-hist-btn"
                    onClick={() => {
                      bridgeInvoke("clear_launcher_history")
                        .then(() => setHistoryEntries([]))
                        .catch(() => {});
                    }}
                  >
                    <Trash2 size={12} />
                    <span>{t("launcher.clearHistory")}</span>
                  </button>
                </div>
              )}
              {displayedItems.map((item, idx) => (
                <ResultRow
                  key={item.id}
                  id={`launcher-opt-${idx}`}
                  item={item}
                  selected={idx === selectedIndex}
                  confirmPending={confirmState?.item.id === item.id}
                  onSelect={() => {
                    if (selectedIndex !== idx) {
                      setSelectedIndex(idx);
                      setConfirmState(null);
                    }
                  }}
                  onExecute={(e) => {
                    if (e?.ctrlKey && e?.shiftKey) {
                      const adminAct = item.actions.find((a) => a.id === "run_as_admin");
                      if (adminAct) {
                        executeAction(item, adminAct);
                        return;
                      }
                    }
                    executeItem(item);
                  }}
                  onOpenActions={() => {
                    setActionsItem(item);
                    setActionIndex(0);
                    inputRef.current?.focus();
                  }}
                />
              ))}
            </>
          ) : (
            <div className="launcher-empty">
              <span>{historyOpen ? t("launcher.historyEmpty") : t("launcher.noResults")}</span>
            </div>
          )}
        </div>

        <div className="launcher-footer">
          <div className="launcher-hints">
            <span><kbd>↑↓</kbd> {t("launcher.hint.navigate")}</span>
            <span><kbd>↵</kbd> {t("launcher.hint.open")}</span>
            <span><kbd>Ctrl+K</kbd> {t("launcher.hint.actions")}</span>
            <span><kbd>Ctrl+H</kbd> {t("launcher.hint.history")}</span>
            <span><kbd>Esc</kbd> {t("launcher.hint.close")}</span>
          </div>
          {toast && <span className="launcher-toast">{toast}</span>}
        </div>
      </div>
    </div>
  );
}
