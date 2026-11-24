import type { ReactNode } from "react";
import {
  AppWindow,
  Calculator,
  FileText,
  Folder,
  Globe,
  History,
  Settings,
  Terminal,
  Wrench,
  ChevronRight,
  Power,
} from "lucide-react";
import type { LauncherItem } from "./types";
import { ShellAppIcon } from "../components/ShellAppIcon";
import { useT } from "../i18n";

const BADGE_KEYS: Record<string, string> = {
  App: "launcher.badge.app",
  File: "launcher.badge.file",
  Folder: "launcher.badge.folder",
  Tool: "launcher.badge.tool",
  Window: "launcher.badge.window",
  Settings: "launcher.badge.settings",
  Web: "launcher.badge.web",
  Shell: "launcher.badge.shell",
  System: "launcher.badge.system",
  Calc: "launcher.badge.calc",
  Running: "launcher.badge.running",
  Recent: "launcher.badge.recent",
};

function renderHighlighted(text: string, indices: number[]): ReactNode {
  if (!indices || indices.length === 0) return text;
  const set = new Set(indices);
  const chars = Array.from(text);
  const out: ReactNode[] = [];
  let buf = "";
  let inMark = false;

  chars.forEach((ch, idx) => {
    const marked = set.has(idx);
    if (marked !== inMark && buf) {
      out.push(
        inMark ? (
          <mark key={`m-${idx}`} className="launcher-match">
            {buf}
          </mark>
        ) : (
          <span key={`t-${idx}`}>{buf}</span>
        )
      );
      buf = "";
    }
    inMark = marked;
    buf += ch;
  });

  if (buf) {
    out.push(
      inMark ? (
        <mark key="m-end" className="launcher-match">
          {buf}
        </mark>
      ) : (
        <span key="t-end">{buf}</span>
      )
    );
  }
  return out;
}

function FallbackIcon({ kind }: { kind: string }) {
  switch (kind) {
    case "calc":
      return <Calculator size={18} strokeWidth={1.8} />;
    case "folder":
      return <Folder size={18} strokeWidth={1.8} />;
    case "file":
      return <FileText size={18} strokeWidth={1.8} />;
    case "window":
      return <AppWindow size={18} strokeWidth={1.8} />;
    case "shell":
      return <Terminal size={18} strokeWidth={1.8} />;
    case "web":
      return <Globe size={18} strokeWidth={1.8} />;
    case "settings":
      return <Settings size={18} strokeWidth={1.8} />;
    case "system":
      return <Power size={18} strokeWidth={1.8} />;
    case "history":
      return <History size={18} strokeWidth={1.8} />;
    default:
      return <Wrench size={18} strokeWidth={1.8} />;
  }
}

interface ResultRowProps {
  id: string;
  item: LauncherItem;
  selected: boolean;
  confirmPending: boolean;
  onSelect: () => void;
  onExecute: (e?: React.MouseEvent) => void;
  onOpenActions: () => void;
}

export function ResultRow({
  id,
  item,
  selected,
  confirmPending,
  onSelect,
  onExecute,
  onOpenActions,
}: ResultRowProps) {
  const t = useT();
  const skipIconLookup = !["app", "file", "folder", "tool", "window"].includes(item.kind);
  const badgeText = BADGE_KEYS[item.badge] ? t(BADGE_KEYS[item.badge]) : item.badge;
  const isRunning = item.badge === "Running" || item.kind === "window";

  return (
    <div
      id={id}
      className={`launcher-row${selected ? " selected" : ""}${confirmPending ? " confirming" : ""}`}
      role="option"
      aria-selected={selected}
      data-selected={selected ? "true" : undefined}
      onMouseMove={onSelect}
      onClick={(e) => onExecute(e)}
      onContextMenu={(e) => {
        if (item.actions.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        onSelect();
        onOpenActions();
      }}
    >
      <div className={`launcher-row-icon kind-${item.kind}`}>
        <ShellAppIcon
          path={item.target}
          name={item.title}
          initialIcon={item.icon}
          hwnd={item.hwnd ?? null}
          skipLookup={skipIconLookup}
          fallback={<FallbackIcon kind={item.kind} />}
        />
        {isRunning && <span className="launcher-running-dot" />}
      </div>

      <div className="launcher-row-body">
        <div className="launcher-row-title-line">
          <span className="launcher-row-title">
            {renderHighlighted(item.title, item.match_indices)}
          </span>
        </div>
        <span className="launcher-row-subtitle">{item.subtitle}</span>
      </div>

      <div className="launcher-row-meta">
        <span className={`launcher-badge badge-${item.kind}${isRunning ? " badge-running" : ""}`}>
          {badgeText}
        </span>
        {item.actions.length > 0 && (
          <button
            type="button"
            className="launcher-actions-btn"
            aria-label={t("launcher.hint.actions")}
            title={`${t("launcher.hint.actions")} (Ctrl+K)`}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenActions();
            }}
          >
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}
