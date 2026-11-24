import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { AnimatePresence, Reorder } from "framer-motion";
import { Trash2 } from "lucide-react";
import { useT } from "../i18n";
import { useSurfaceMetrics } from "../hooks/useSurfaceMetrics";

export type ShelfItem = {
  id: string;
  kind: "file" | "text";
  path?: string;
  name: string;
  text?: string;
  thumb?: string | null;
  preview?: string | null;
};

const STORAGE_KEY = "nectar-shelf-items";
const MAX_ITEMS = 10;

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function readSaved(): ShelfItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map((i: ShelfItem) => ({ ...i, thumb: null, preview: null })) : [];
  } catch {
    return [];
  }
}

type ShelfCallbacks = {
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
};

export function useShelf(
  windowLabel: string,
  enabled: boolean,
  persist: boolean,
  cb: ShelfCallbacks,
  settingsLoaded = true
) {
  const [items, setItems] = useState<ShelfItem[]>(() => (persist ? readSaved() : []));
  const [dropActive, setDropActive] = useState(false);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const hydratedPersistRef = useRef(persist);
  const prunedOnceRef = useRef(false);
  const thumbRequestedRef = useRef<Set<string>>(new Set());
  const retryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const timers = retryTimersRef.current;
    return () => {
      mountedRef.current = false;
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (persist && !hydratedPersistRef.current) {
      hydratedPersistRef.current = true;
      setItems((prev) => (prev.length > 0 ? prev : readSaved()));
      return;
    }
    hydratedPersistRef.current = persist;
    if (!persist) {
      prunedOnceRef.current = false;
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
      return;
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items.map(({ thumb, preview, ...rest }) => rest))); } catch { /* storage unavailable */ }
  }, [items, persist, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded || !persist || prunedOnceRef.current) return;
    const files = items.filter((i) => i.kind === "file" && i.path).map((i) => i.path as string);
    if (files.length === 0) return;
    prunedOnceRef.current = true;
    invoke<string[]>("shelf_prune", { paths: files }).then((alive) => {
      if (!mountedRef.current) return;
      const keep = new Set(alive);
      setItems((prev) => prev.filter((i) => i.kind !== "file" || keep.has(i.path as string)));
    }).catch(() => { });
  }, [items, persist, settingsLoaded]);

  // Explorer has no cached thumbnail for a fresh file yet (videos especially), so ask again a few times
  const loadThumb = useCallback((id: string, path: string, attempt = 0) => {
    if (!mountedRef.current) return;
    invoke<string | null>("shelf_thumbnail", { path }).then((thumb) => {
      if (!mountedRef.current) return;
      if (thumb) {
        setItems((prev) => prev.map((i) => (i.id === id ? { ...i, thumb } : i)));
        return;
      }
      invoke<string | null>("shelf_text_preview", { path }).then((preview) => {
        if (!mountedRef.current) return;
        if (preview) {
          setItems((prev) => prev.map((i) => (i.id === id ? { ...i, preview } : i)));
        } else if (attempt < 3) {
          const timer = setTimeout(() => {
            retryTimersRef.current.delete(timer);
            loadThumb(id, path, attempt + 1);
          }, 600 * (attempt + 1));
          retryTimersRef.current.add(timer);
        }
      }).catch(() => { });
    }).catch(() => { });
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    const activeIds = new Set(items.map((i) => i.id));
    for (const id of Array.from(thumbRequestedRef.current)) {
      if (!activeIds.has(id)) thumbRequestedRef.current.delete(id);
    }
    items.forEach((i) => {
      if (i.kind === "file" && i.path && !i.thumb && !i.preview && !thumbRequestedRef.current.has(i.id)) {
        thumbRequestedRef.current.add(i.id);
        loadThumb(i.id, i.path);
      }
    });
  }, [items, settingsLoaded, loadThumb]);

  const add = useCallback((paths?: string[], text?: string) => {
    const fresh: ShelfItem[] = [];
    if (paths) {
      for (const path of paths) {
        fresh.push({ id: `f-${Date.now()}-${fresh.length}-${path}`, kind: "file", path, name: baseName(path) });
      }
    } else if (text) {
      fresh.push({ id: `t-${Date.now()}`, kind: "text", name: text.trim().slice(0, 40), text });
    }
    if (fresh.length === 0) return;
    setItems((prev) => {
      const taken = new Set(fresh.filter((i) => i.path).map((i) => i.path));
      const rest = prev.filter((i) => !(i.path && taken.has(i.path)));
      return [...fresh, ...rest].slice(0, MAX_ITEMS);
    });
  }, []);

  useEffect(() => {
    if (!enabled || !windowLabel) return;
    const isNotch = windowLabel === "main" || windowLabel.startsWith("main-");
    if (!isNotch) return;
    invoke("setup_shelf_drop").catch(() => { });

    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const sub = <T,>(ev: string, handler: (payload: T) => void) => {
      listen<T>(ev, (e) => {
        if (!cancelled) handler(e.payload);
      })
        .then((fn) => {
          if (cancelled) fn();
          else cleanups.push(fn);
        })
        .catch(() => {});
    };

    sub<{ label: string }>("shelf-drag-enter", (payload) => {
      if (payload.label === windowLabel) {
        setDropActive(true);
        cbRef.current.onDragEnter();
      }
    });
    sub<{ label: string }>("shelf-drag-leave", (payload) => {
      if (payload.label === windowLabel) {
        setDropActive(false);
        cbRef.current.onDragLeave();
      }
    });
    sub<{ label: string; paths?: string[]; text?: string }>("shelf-drag-drop", (payload) => {
      add(payload.paths, payload.text);
      setDropActive(false);
      if (payload.label === windowLabel) cbRef.current.onDrop();
    });

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [enabled, windowLabel, add]);

  const remove = useCallback((id: string) => {
    thumbRequestedRef.current.delete(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);
  const clear = useCallback(() => {
    thumbRequestedRef.current.clear();
    setItems([]);
  }, []);

  return { items, dropActive, reorder: setItems, remove, clear };
}

type Props = {
  items: ShelfItem[];
  dropActive: boolean;
  onReorder: (items: ShelfItem[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onDragOutStart: () => void;
  onDragOutEnd: () => void;
};

const CARD_SPRING = { type: "spring", stiffness: 520, damping: 34 } as const;

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 5 ? name.slice(dot + 1).toUpperCase() : "";
};

export function NotchShelf({ items, dropActive, onReorder, onRemove, onClear, onDragOutStart, onDragOutEnd }: Props) {
  const t = useT();
  const { scaleSpring, scaleDuration } = useSurfaceMetrics();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ out: boolean } | null>(null);
  const dragIcon = useRef<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string | null>("shelf_drag_icon")
      .then((icon) => {
        if (!cancelled) dragIcon.current = icon;
      })
      .catch(() => { });
    return () => {
      cancelled = true;
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    };
  }, []);

  const beginDrag = async (item: ShelfItem) => {
    const icon = item.thumb ?? dragIcon.current;
    if (!icon) return;
    const path = item.kind === "file" ? item.path : await invoke<string | null>("shelf_text_file", { text: item.text ?? "" });
    if (!path) return;
    onDragOutStart();
    try {
      await startDrag({ item: [path], icon, mode: "copy" });
    } catch { /* drag was cancelled or refused */ }
    setResetKey((k) => k + 1);
    onDragOutEnd();
  };

  const activate = (item: ShelfItem) => {
    if (item.kind === "file" && item.path) {
      invoke("shelf_open", { path: item.path }).catch(() => { });
    } else if (item.text) {
      invoke("copy_text_to_clipboard", { text: item.text }).then(() => {
        setCopiedId(item.id);
        if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = null;
          setCopiedId((cur) => (cur === item.id ? null : cur));
        }, 1200);
      }).catch(() => { });
    }
  };

  const previewText = (item: ShelfItem) => item.preview ?? (item.kind === "text" ? item.text?.slice(0, 160) : null);

  return (
    <div ref={panelRef} className={`shelf-panel${dropActive ? " drop-active" : ""}`} onClick={(e) => e.stopPropagation()}>
      {items.length === 0 ? (
        <div className="shelf-empty">{t("shelf.empty")}</div>
      ) : (
        <>
          <Reorder.Group key={resetKey} as="div" axis="x" values={items} onReorder={onReorder} className={`shelf-row${items.length <= 4 ? " fits" : ""}`}>
            <AnimatePresence initial={false}>
              {items.map((item) => {
                const text = item.thumb ? null : previewText(item);
                const ext = item.kind === "file" ? extOf(item.name) : "";
                return (
                  <Reorder.Item
                    key={item.id}
                    as="div"
                    value={item}
                    className={`shelf-item ${item.kind}`}
                    title={item.kind === "text" ? item.text : item.path}
                    initial={{ opacity: 0, scale: 0.5, y: -10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.5, transition: { duration: scaleDuration(0.12) } }}
                    whileDrag={{ scale: 1.1, zIndex: 5 }}
                    transition={scaleSpring(CARD_SPRING)}
                    onDragStart={() => { dragState.current = { out: false }; }}
                    onDrag={(_, info) => {
                      const state = dragState.current;
                      const rect = panelRef.current?.getBoundingClientRect();
                      if (!state || state.out || !rect) return;
                      const { x, y } = info.point;
                      if (x < rect.left || x > rect.right || y > rect.bottom || y < rect.top - 20) {
                        state.out = true;
                        beginDrag(item);
                      }
                    }}
                    onDragEnd={() => { dragState.current = null; }}
                    onTap={() => { if (item.kind === "text") activate(item); }}
                    onDoubleClick={() => { if (item.kind === "file") activate(item); }}
                  >
                    <div className="shelf-thumb">
                      {item.thumb ? (
                        <img src={item.thumb} alt="" draggable={false} />
                      ) : text ? (
                        <pre className={`shelf-preview${text.length < 24 ? " short" : ""}`}>{text}</pre>
                      ) : (
                        <span className="shelf-glyph">{item.kind === "text" ? "T" : "▤"}</span>
                      )}
                      {ext && !item.thumb && <span className="shelf-ext">{ext}</span>}
                    </div>
                    <span className="shelf-name">{copiedId === item.id ? t("shelf.copied") : item.name}</span>
                    <button
                      className="shelf-remove"
                      title={t("shelf.remove")}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onRemove(item.id); }}
                    >
                      ×
                    </button>
                  </Reorder.Item>
                );
              })}
            </AnimatePresence>
          </Reorder.Group>
          <button className="shelf-clear" onClick={onClear}>
            <Trash2 size={12} strokeWidth={2} />
            {t("shelf.clear")}
          </button>
        </>
      )}
    </div>
  );
}
