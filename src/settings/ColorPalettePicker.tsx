import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, RotateCcw } from "lucide-react";
import { useT } from "../i18n";
import { bridgeInvoke } from "../utils/tauriBridge";

export interface ColorPalettePickerProps {
  value: string;
  onChange: (hex: string) => void;
  fallbackHue?: number;
  ariaLabel?: string;
  swatches?: string[];
  resetHex?: string;
  onReset?: () => void;
}

interface HSV {
  h: number; // 0..360 (360 kept visually at right edge, wrapped modulo 360 in math)
  s: number; // 0..1
  v: number; // 0..1
}

const DEFAULT_HEX = "#0a84ff";
const POPOVER_WIDTH = 252;
const POPOVER_FALLBACK_HEIGHT = 296;
const GAP = 8;
const EDGE = 10;

const DEFAULT_SWATCHES = [
  "#ff5e8a",
  "#ff7a45",
  "#facc15",
  "#34c77b",
  "#2ec4d6",
  "#38bdf8",
  "#0a84ff",
  "#c77dff",
  "#8e8e93",
  "#ffffff",
  "#18181f",
];

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function normalizeHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(cleaned)) {
    return `#${cleaned
      .split("")
      .map((c) => c + c)
      .join("")
      .toLowerCase()}`;
  }
  if (/^[0-9a-f]{6}$/i.test(cleaned)) {
    return `#${cleaned.toLowerCase()}`;
  }
  return null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const safe = normalizeHex(hex) ?? DEFAULT_HEX;
  return {
    r: parseInt(safe.slice(1, 3), 16),
    g: parseInt(safe.slice(3, 5), 16),
    b: parseInt(safe.slice(5, 7), 16),
  };
}

function rgbToHsv(r: number, g: number, b: number): HSV {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d > 0) {
    if (max === rn) {
      h = ((gn - bn) / d) % 6;
    } else if (max === gn) {
      h = (bn - rn) / d + 2;
    } else {
      h = (rn - gn) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

function hexToHsv(hex: string): HSV {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsv(r, g, b);
}

function hsvToHex(h: number, s: number, v: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);

  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hue < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hue < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hue < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hue < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hue < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  const toHex = (n: number) =>
    Math.round(clamp(n + m, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

function getActiveZoom(el: HTMLElement | null): number {
  const container = el?.closest(".settings-container") as HTMLElement | null;
  const raw = container?.style.zoom || (container ? getComputedStyle(container).zoom : "");
  const parsed = parseFloat(raw || "1");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function ColorPalettePicker({
  value,
  onChange,
  fallbackHue,
  ariaLabel,
  swatches = DEFAULT_SWATCHES,
  resetHex,
  onReset,
}: ColorPalettePickerProps) {
  const t = useT();
  const safeHex = normalizeHex(value) ?? DEFAULT_HEX;
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<HSV>(() => {
    const parsed = hexToHsv(safeHex);
    if ((parsed.s === 0 || parsed.v === 0) && fallbackHue !== undefined && Number.isFinite(fallbackHue)) {
      return { h: fallbackHue, s: parsed.s, v: parsed.v };
    }
    return parsed;
  });
  const [hexDraft, setHexDraft] = useState(() => safeHex.toUpperCase());
  const [copied, setCopied] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const inputFocusedRef = useRef(false);
  const copyTimerRef = useRef<number | null>(null);
  const recentCommittedRef = useRef<Map<string, number>>(new Map());
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;

  const rememberCommitted = useCallback((hex: string) => {
    const now = Date.now();
    recentCommittedRef.current.set(hex, now);
    for (const [k, expires] of recentCommittedRef.current.entries()) {
      if (expires + 800 < now) {
        recentCommittedRef.current.delete(k);
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (draggingRef.current) return;
    const normalized = normalizeHex(value);
    if (!normalized) return;
    if (!inputFocusedRef.current) {
      setHexDraft(normalized.toUpperCase());
    }
    const committedAt = recentCommittedRef.current.get(normalized);
    if (committedAt !== undefined && Date.now() - committedAt < 800) {
      return;
    }
    setHsv((prev) => {
      // Preserve Hue when dragging into white/black/grey (s === 0 or v === 0)
      if (hsvToHex(prev.h, prev.s, prev.v) === normalized) {
        return prev;
      }
      const next = hexToHsv(normalized);
      if (next.s === 0 || next.v === 0) {
        const preservedHue =
          fallbackHue !== undefined && Number.isFinite(fallbackHue) ? fallbackHue : prev.h;
        return { h: preservedHue, s: next.s, v: next.v };
      }
      return next;
    });
  }, [value, fallbackHue]);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = getActiveZoom(triggerRef.current);
    const vw = window.innerWidth / zoom;
    const vh = window.innerHeight / zoom;
    const popW = popoverRef.current?.offsetWidth || POPOVER_WIDTH;
    const popH = popoverRef.current?.offsetHeight || POPOVER_FALLBACK_HEIGHT;

    const trigRight = rect.right / zoom;
    const trigTop = rect.top / zoom;
    const trigBottom = rect.bottom / zoom;

    const spaceBelow = vh - trigBottom - GAP - EDGE;
    const spaceAbove = trigTop - GAP - EDGE;
    const openUp = spaceBelow < popH && spaceAbove > spaceBelow;

    let top = openUp ? trigTop - GAP - popH : trigBottom + GAP;
    top = clamp(top, EDGE, Math.max(EDGE, vh - EDGE - popH));

    let left = trigRight - popW;
    left = clamp(left, EDGE, Math.max(EDGE, vw - EDGE - popW));

    setPopoverStyle({
      zoom,
      top,
      left,
      maxHeight: Math.max(160, vh - EDGE * 2),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) {
      place();
    } else {
      setPopoverStyle(null);
    }
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    const handleScroll = (e: Event) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      place();
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, place]);

  const commitHsv = useCallback(
    (next: HSV) => {
      hsvRef.current = next;
      setHsv(next);
      const nextHex = hsvToHex(next.h, next.s, next.v);
      setHexDraft(nextHex.toUpperCase());
      if (nextHex !== safeHex) {
        rememberCommitted(nextHex);
        onChange(nextHex);
      }
    },
    [onChange, rememberCommitted, safeHex]
  );

  const updateSvFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = svRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const s = clamp((clientX - rect.left) / rect.width, 0, 1);
      const v = clamp(1 - (clientY - rect.top) / rect.height, 0, 1);
      commitHsv({ h: hsvRef.current.h, s, v });
    },
    [commitHsv]
  );

  const updateHueFromPointer = useCallback(
    (clientX: number) => {
      const el = hueRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const h = clamp((clientX - rect.left) / rect.width, 0, 1) * 360;
      commitHsv({ h, s: hsvRef.current.s, v: hsvRef.current.v });
    },
    [commitHsv]
  );

  const onSvPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateSvFromPointer(e.clientX, e.clientY);
  };

  const onSvPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    updateSvFromPointer(e.clientX, e.clientY);
  };

  const onHuePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateHueFromPointer(e.clientX);
  };

  const onHuePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    updateHueFromPointer(e.clientX);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleSwatchClick = (swatch: string) => {
    const normalized = normalizeHex(swatch);
    if (!normalized) return;
    const nextHsv = hexToHsv(normalized);
    setHsv((prev) =>
      nextHsv.s === 0 || nextHsv.v === 0 ? { h: prev.h, s: nextHsv.s, v: nextHsv.v } : nextHsv
    );
    setHexDraft(normalized.toUpperCase());
    rememberCommitted(normalized);
    onChange(normalized);
  };

  const handleHexInputChange = (raw: string) => {
    const cleaned = raw.slice(0, 7);
    setHexDraft(cleaned);
    const parsed = normalizeHex(cleaned);
    if (parsed) {
      const nextHsv = hexToHsv(parsed);
      setHsv((prev) =>
        nextHsv.s === 0 || nextHsv.v === 0 ? { h: prev.h, s: nextHsv.s, v: nextHsv.v } : nextHsv
      );
      rememberCommitted(parsed);
      onChange(parsed);
    }
  };

  const handleCopyHex = () => {
    const upper = safeHex.toUpperCase();
    bridgeInvoke("copy_text_to_clipboard", { text: upper }).catch(() => {
      navigator.clipboard?.writeText(upper).catch(() => {});
    });
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 1500);
  };

  const normalizedReset = normalizeHex(resetHex);
  const isAtReset = normalizedReset !== null && normalizedReset === safeHex;
  const pureHueCss = `hsl(${Math.round(((hsv.h % 360) + 360) % 360)}, 100%, 50%)`;

  return (
    <div className="color-picker-control">
      <button
        ref={triggerRef}
        type="button"
        className={`color-picker-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-label={ariaLabel ?? t("appearance.palette.title")}
        aria-expanded={open}
      >
        <span className="color-picker-swatch" style={{ background: safeHex }} />
        <span className="color-picker-hex">{safeHex.toUpperCase()}</span>
      </button>

      {onReset && (
        <button
          type="button"
          className="color-picker-reset"
          onClick={onReset}
          disabled={isAtReset}
          title={t("appearance.selectionReset")}
          aria-label={t("appearance.selectionReset")}
        >
          <RotateCcw size={12} strokeWidth={2} />
        </button>
      )}

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="color-picker-popover"
            role="dialog"
            aria-label={ariaLabel ?? t("appearance.palette.title")}
            style={popoverStyle ?? { visibility: "hidden", zoom: getActiveZoom(triggerRef.current) }}
          >
            <div className="color-picker-popover-header">
              <span>{ariaLabel ?? t("appearance.palette.title")}</span>
              <span className="color-picker-popover-badge">{safeHex.toUpperCase()}</span>
            </div>

            <div
              ref={svRef}
              className="color-picker-sv"
              style={{
                backgroundColor: pureHueCss,
                backgroundImage:
                  "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
              }}
              onPointerDown={onSvPointerDown}
              onPointerMove={onSvPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              role="slider"
              tabIndex={0}
              aria-label={ariaLabel ?? t("appearance.palette.title")}
              aria-valuetext={safeHex.toUpperCase()}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 0.08 : 0.02;
                if (e.key === "ArrowRight") {
                  e.preventDefault();
                  commitHsv({ ...hsvRef.current, s: clamp(hsvRef.current.s + step, 0, 1) });
                } else if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  commitHsv({ ...hsvRef.current, s: clamp(hsvRef.current.s - step, 0, 1) });
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  commitHsv({ ...hsvRef.current, v: clamp(hsvRef.current.v + step, 0, 1) });
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  commitHsv({ ...hsvRef.current, v: clamp(hsvRef.current.v - step, 0, 1) });
                }
              }}
            >
              <span
                className="color-picker-sv-reticle"
                style={{
                  left: `${hsv.s * 100}%`,
                  top: `${(1 - hsv.v) * 100}%`,
                  background: safeHex,
                }}
              />
            </div>

            <div
              ref={hueRef}
              className="color-picker-hue"
              onPointerDown={onHuePointerDown}
              onPointerMove={onHuePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              role="slider"
              tabIndex={0}
              aria-label={t("appearance.palette.hue")}
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={Math.round(hsv.h)}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 15 : 3;
                if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                  e.preventDefault();
                  commitHsv({ ...hsvRef.current, h: clamp(hsvRef.current.h + step, 0, 360) });
                } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                  e.preventDefault();
                  commitHsv({ ...hsvRef.current, h: clamp(hsvRef.current.h - step, 0, 360) });
                }
              }}
            >
              <span
                className="color-picker-hue-thumb"
                style={{
                  left: `${(clamp(hsv.h, 0, 360) / 360) * 100}%`,
                  background: pureHueCss,
                }}
              />
            </div>

            <div className="color-picker-hex-row">
              <span className="color-picker-hex-preview" style={{ background: safeHex }} />
              <input
                type="text"
                className="color-picker-hex-input"
                value={hexDraft}
                maxLength={7}
                spellCheck={false}
                autoComplete="off"
                aria-label={t("appearance.palette.hex")}
                onFocus={() => {
                  inputFocusedRef.current = true;
                }}
                onChange={(e) => handleHexInputChange(e.target.value)}
                onBlur={() => {
                  inputFocusedRef.current = false;
                  setHexDraft(safeHex.toUpperCase());
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
              />
              <button
                type="button"
                className="color-picker-copy-btn"
                onClick={handleCopyHex}
                title={safeHex.toUpperCase()}
                aria-label={t("appearance.palette.copyHex")}
              >
                {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
              </button>
            </div>

            {swatches.length > 0 && (
              <div className="color-picker-swatches" role="group" aria-label={t("appearance.palette.presets")}>
                {swatches.map((swatch) => {
                  const norm = normalizeHex(swatch) ?? swatch.toLowerCase();
                  const active = norm === safeHex;
                  return (
                    <button
                      key={norm}
                      type="button"
                      className={`color-picker-swatch-btn${active ? " active" : ""}`}
                      style={{ background: norm }}
                      onClick={() => handleSwatchClick(norm)}
                      title={norm.toUpperCase()}
                      aria-label={norm.toUpperCase()}
                      aria-pressed={active}
                    />
                  );
                })}
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
