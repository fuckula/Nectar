import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AppWindow } from "lucide-react";
import type { AppInfo } from "../types/shell";
import { ShellAppIcon } from "../components/ShellAppIcon";

const LATIN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const CYRILLIC_LETTERS = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ".split("");
const JUMP_LETTERS = ["#", ...LATIN_LETTERS, ...CYRILLIC_LETTERS];

function letterBucket(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  if (!first) return "#";
  if (first >= "A" && first <= "Z") return first;
  if (first === "Ё") return "Е";
  if (first >= "А" && first <= "Я") return first;
  return "#";
}

interface AllAppsListProps {
  apps: AppInfo[];
  onLaunch: (app: AppInfo, e?: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent, app: AppInfo) => void;
  jumpOpen: boolean;
  setJumpOpen: (v: boolean) => void;
}

export function AllAppsList({
  apps,
  onLaunch,
  onContextMenu,
  jumpOpen,
  setJumpOpen,
}: AllAppsListProps) {
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollWrapRef = useRef<HTMLDivElement | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const [filterLetter, setFilterLetter] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  const grouped = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    const sorted = [...apps].sort((a, b) => collator.compare(a.name, b.name));
    const map = new Map<string, AppInfo[]>();
    for (const app of sorted) {
      const bucket = letterBucket(app.name);
      const arr = map.get(bucket);
      if (arr) arr.push(app);
      else map.set(bucket, [app]);
    }
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === "#") return -1;
      if (b[0] === "#") return 1;
      return JUMP_LETTERS.indexOf(a[0]) - JUMP_LETTERS.indexOf(b[0]);
    });
  }, [apps]);

  const populatedSet = useMemo(() => new Set(grouped.map(([k]) => k)), [grouped]);

  const jumpTo = (letter: string) => {
    setJumpOpen(false);
    setFilterLetter(letter);
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
    requestAnimationFrame(() => {
      sectionRefs.current[letter]?.scrollIntoView({ behavior: "smooth", block: "start" });
      flashTimerRef.current = window.setTimeout(() => {
        setFilterLetter(null);
        flashTimerRef.current = null;
      }, 900);
    });
  };

  const handleListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = Array.from(
      scrollWrapRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
    );
    const cur = document.activeElement as HTMLButtonElement | null;
    const idx = cur ? buttons.indexOf(cur) : -1;
    if (idx === -1) return;
    e.preventDefault();
    const next =
      e.key === "ArrowDown"
        ? (idx + 1) % buttons.length
        : (idx - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={scrollWrapRef} className="start-all-apps-wrap" onKeyDown={handleListKeyDown}>
      {jumpOpen ? (
        <div className="start-jump-grid-overlay">
          <div className="start-jump-grid">
            {JUMP_LETTERS.map((letter) => {
              const has = populatedSet.has(letter);
              return (
                <button
                  key={letter}
                  type="button"
                  disabled={!has}
                  className={`start-jump-cell${has ? " active" : ""}`}
                  onClick={() => jumpTo(letter)}
                >
                  {letter}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="start-all-apps-scroll">
          {grouped.map(([letter, list]) => (
            <div
              key={letter}
              ref={(el) => {
                sectionRefs.current[letter] = el;
              }}
              className="start-letter-group"
            >
              <button
                type="button"
                className={`start-letter-header${filterLetter === letter ? " flash" : ""}`}
                onClick={() => setJumpOpen(true)}
              >
                {letter}
              </button>
              {list.map((app) => (
                <button
                  key={`${app.path}|${app.name}`}
                  type="button"
                  className="start-app-row"
                  onClick={(e) => onLaunch(app, e)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onContextMenu(e, app);
                  }}
                >
                  <div className="start-app-row-icon">
                    <ShellAppIcon
                      path={app.path}
                      name={app.name}
                      initialIcon={app.icon}
                      fallback={<AppWindow size={18} strokeWidth={1.7} />}
                    />
                  </div>
                  <span className="start-app-row-name">{app.name}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
