export type IconTintMode = "original" | "dark-glass" | "tinted" | "pastel" | "duotone";
export type IconTintSource = "accent" | "custom" | "wallpaper";
export type IconTileShape = "squircle" | "circle" | "rounded" | "none";

export const ICON_TINT_MODES: readonly IconTintMode[] = [
  "original",
  "dark-glass",
  "tinted",
  "pastel",
  "duotone",
];

export const ICON_TINT_SOURCES: readonly IconTintSource[] = [
  "accent",
  "custom",
  "wallpaper",
];

export const ICON_TILE_SHAPES: readonly IconTileShape[] = [
  "squircle",
  "circle",
  "rounded",
  "none",
];

export const ICON_TINT_KEYS = [
  "nectar-icon-tint-mode",
  "nectar-icon-tint-source",
  "nectar-icon-tint-color",
  "nectar-icon-tint-strength",
  "nectar-icon-tile-shape",
  "nectar-icon-tint-excluded",
] as const;

export const ICON_TINT_DEFAULTS = {
  mode: "original" as IconTintMode,
  source: "accent" as IconTintSource,
  color: "#5282ff",
  strength: "0.75",
  shape: "squircle" as IconTileShape,
  excluded: "[]",
} as const;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_ELEMENT_ID = "nectar-icon-tint-svg";
const FILTER_ELEMENT_ID = "nectar-icon-tint-filter";
const MATRIX_ELEMENT_ID = "nectar-icon-tint-matrix";

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

export function sanitizeIconTintMode(val?: string | null): IconTintMode {
  if (val && (ICON_TINT_MODES as readonly string[]).includes(val)) {
    return val as IconTintMode;
  }
  return ICON_TINT_DEFAULTS.mode;
}

export function sanitizeIconTintSource(val?: string | null): IconTintSource {
  if (val && (ICON_TINT_SOURCES as readonly string[]).includes(val)) {
    return val as IconTintSource;
  }
  return ICON_TINT_DEFAULTS.source;
}

export function sanitizeIconTileShape(val?: string | null): IconTileShape {
  if (val && (ICON_TILE_SHAPES as readonly string[]).includes(val)) {
    return val as IconTileShape;
  }
  return ICON_TINT_DEFAULTS.shape;
}

export function sanitizeIconTintStrength(val?: string | null): number {
  const num = Number.parseFloat(val ?? "");
  if (!Number.isFinite(num)) return 0.75;
  return Math.max(0, Math.min(1, num));
}

export function sanitizeIconHexColor(
  val?: string | null,
  fallback: string = ICON_TINT_DEFAULTS.color,
): string {
  const trimmed = val?.trim();
  if (trimmed && HEX_COLOR_RE.test(trimmed)) return trimmed.toLowerCase();
  return HEX_COLOR_RE.test(fallback) ? fallback.toLowerCase() : ICON_TINT_DEFAULTS.color;
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = sanitizeIconHexColor(hex);
  const r = Number.parseInt(clean.slice(1, 3), 16);
  const g = Number.parseInt(clean.slice(3, 5), 16);
  const b = Number.parseInt(clean.slice(5, 7), 16);
  return [r, g, b];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1.4, value));
}

export function normalizeTintExclusionKey(appId?: string | null): string {
  if (!appId) return "";
  const trimmed = appId.trim().toLowerCase().replace(/^"+|"+$/g, "");
  if (!trimmed) return "";
  const slashIdx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  const base = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
  return (base || trimmed).trim();
}

export function parseExcludedTintApps(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const key = normalizeTintExclusionKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  } catch {
    return [];
  }
}

export function getExcludedTintApps(): Set<string> {
  try {
    return new Set(parseExcludedTintApps(localStorage.getItem("nectar-icon-tint-excluded")));
  } catch {
    return new Set();
  }
}

export function isAppTintExcluded(
  appId?: string | null,
  excludedSet?: ReadonlySet<string>,
): boolean {
  const key = normalizeTintExclusionKey(appId);
  if (!key) return false;
  const set = excludedSet ?? getExcludedTintApps();
  if (set.has(key)) return true;
  if (key.endsWith(".exe")) {
    return set.has(key.slice(0, -4));
  }
  return set.has(`${key}.exe`);
}

export function computeUpdatedTintExclusions(appId: string, currentRaw?: string | null): {
  key: string;
  excluded: boolean;
  list: string[];
  serialized: string;
} {
  const key = normalizeTintExclusionKey(appId);
  const list = parseExcludedTintApps(
    currentRaw ?? (() => {
      try {
        return localStorage.getItem("nectar-icon-tint-excluded");
      } catch {
        return "[]";
      }
    })(),
  );
  if (!key) {
    return { key: "", excluded: false, list, serialized: JSON.stringify(list) };
  }
  const idx = list.indexOf(key);
  let excluded: boolean;
  if (idx >= 0) {
    list.splice(idx, 1);
    excluded = false;
  } else {
    list.push(key);
    excluded = true;
  }
  const serialized = JSON.stringify(list);
  return { key, excluded, list, serialized };
}

/**
 * Compute a 4x5 row-major RGBA SVG `<feColorMatrix>` string interpolating
 * linearly between the identity matrix (strength=0) and the mode target matrix
 * (strength=1). Keeps alpha intact (`0 0 0 1 0`).
 */
export function buildIconColorMatrixValues(
  mode: IconTintMode,
  hex: string,
  strength: number,
  isLight: boolean,
): string {
  const s = Math.max(0, Math.min(1, strength));
  if (mode === "original" || s <= 0.001) {
    return "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0";
  }

  const [r255, g255, b255] = hexToRgbTuple(hex);
  const tr = r255 / 255;
  const tg = g255 / 255;
  const tb = b255 / 255;

  // Target matrix rows before blending with Identity.
  // Each RGB output is a linear combination: origMix*origC + slopeC*L + biasC
  let origMix = 0;
  let slopeR = 1;
  let slopeG = 1;
  let slopeB = 1;
  let biasR = 0;
  let biasG = 0;
  let biasB = 0;

  if (mode === "tinted") {
    origMix = 0.08;
    const scale = isLight ? 0.92 : 1.15;
    const lift = isLight ? 0.04 : 0.14;
    slopeR = clamp01(tr * scale + lift);
    slopeG = clamp01(tg * scale + lift);
    slopeB = clamp01(tb * scale + lift);
    biasR = tr * 0.07;
    biasG = tg * 0.07;
    biasB = tb * 0.07;
  } else if (mode === "dark-glass") {
    origMix = 0.32;
    const scale = 0.68;
    const lift = 0.18;
    slopeR = clamp01(tr * scale + lift);
    slopeG = clamp01(tg * scale + lift);
    slopeB = clamp01(tb * scale + lift);
    biasR = tr * 0.04;
    biasG = tg * 0.04;
    biasB = tb * 0.04;
  } else if (mode === "pastel") {
    origMix = 0.22;
    const pr = tr + (1 - tr) * 0.36;
    const pg = tg + (1 - tg) * 0.36;
    const pb = tb + (1 - tb) * 0.36;
    slopeR = clamp01(pr * 0.72 + 0.14);
    slopeG = clamp01(pg * 0.72 + 0.14);
    slopeB = clamp01(pb * 0.72 + 0.14);
    biasR = pr * 0.2;
    biasG = pg * 0.2;
    biasB = pb * 0.2;
  } else if (mode === "duotone") {
    origMix = 0.0;
    const darkR = tr * 0.14;
    const darkG = tg * 0.14;
    const darkB = tb * 0.18;
    const hiR = Math.min(1.15, tr * 1.05 + 0.28);
    const hiG = Math.min(1.15, tg * 1.05 + 0.28);
    const hiB = Math.min(1.15, tb * 1.05 + 0.28);
    slopeR = Math.max(0.15, hiR - darkR);
    slopeG = Math.max(0.15, hiG - darkG);
    slopeB = Math.max(0.15, hiB - darkB);
    biasR = darkR;
    biasG = darkG;
    biasB = darkB;
  }

  // Row 0 (R') = (1-s)*[1,0,0,0,0] + s*[origMix + slopeR*Lr, slopeR*Lg, slopeR*Lb, 0, biasR]
  const m00 = (1 - s) + s * (origMix + slopeR * LUMA_R);
  const m01 = s * (slopeR * LUMA_G);
  const m02 = s * (slopeR * LUMA_B);
  const m04 = s * biasR;

  const m10 = s * (slopeG * LUMA_R);
  const m11 = (1 - s) + s * (origMix + slopeG * LUMA_G);
  const m12 = s * (slopeG * LUMA_B);
  const m14 = s * biasG;

  const m20 = s * (slopeB * LUMA_R);
  const m21 = s * (slopeB * LUMA_G);
  const m22 = (1 - s) + s * (origMix + slopeB * LUMA_B);
  const m24 = s * biasB;

  const f = (n: number) => n.toFixed(4);
  return [
    `${f(m00)} ${f(m01)} ${f(m02)} 0 ${f(m04)}`,
    `${f(m10)} ${f(m11)} ${f(m12)} 0 ${f(m14)}`,
    `${f(m20)} ${f(m21)} ${f(m22)} 0 ${f(m24)}`,
    "0 0 0 1 0",
  ].join("  ");
}

function ensureSvgIconTintFilter(matrixValues: string): void {
  if (typeof document === "undefined") return;
  const host = document.body ?? document.documentElement;
  if (!host) return;

  let svg = document.getElementById(SVG_ELEMENT_ID) as SVGSVGElement | null;
  if (!svg) {
    svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    svg.id = SVG_ELEMENT_ID;
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    // IMPORTANT: Never use display:none here — WebView2/Chromium skips filter evaluation.
    svg.style.position = "fixed";
    svg.style.left = "-9999px";
    svg.style.top = "-9999px";
    svg.style.width = "0";
    svg.style.height = "0";
    svg.style.pointerEvents = "none";
    svg.style.overflow = "hidden";

    const defs = document.createElementNS(SVG_NS, "defs");
    const filter = document.createElementNS(SVG_NS, "filter");
    filter.id = FILTER_ELEMENT_ID;
    filter.setAttribute("color-interpolation-filters", "sRGB");

    const matrix = document.createElementNS(SVG_NS, "feColorMatrix");
    matrix.id = MATRIX_ELEMENT_ID;
    matrix.setAttribute("type", "matrix");
    matrix.setAttribute("values", matrixValues);

    filter.appendChild(matrix);
    defs.appendChild(filter);
    svg.appendChild(defs);
    host.appendChild(svg);
    return;
  }

  // Re-parent into body if it was mounted before body existed.
  if (document.body && svg.parentElement !== document.body) {
    document.body.appendChild(svg);
  }

  const matrix = document.getElementById(MATRIX_ELEMENT_ID);
  if (matrix) {
    matrix.setAttribute("values", matrixValues);
  }
}

export function resolveActiveIconTint(accentHex: string): {
  mode: IconTintMode;
  source: IconTintSource;
  color: string;
  strength: number;
  shape: IconTileShape;
} {
  let modeRaw: string | null = null;
  let sourceRaw: string | null = null;
  let customColorRaw: string | null = null;
  let wallpaperColorRaw: string | null = null;
  let strengthRaw: string | null = null;
  let shapeRaw: string | null = null;

  try {
    modeRaw = localStorage.getItem("nectar-icon-tint-mode");
    sourceRaw = localStorage.getItem("nectar-icon-tint-source");
    customColorRaw = localStorage.getItem("nectar-icon-tint-color");
    wallpaperColorRaw = localStorage.getItem("nectar-wallpaper-accent");
    strengthRaw = localStorage.getItem("nectar-icon-tint-strength");
    shapeRaw = localStorage.getItem("nectar-icon-tile-shape");
  } catch {
    // Ignore storage access restrictions
  }

  const mode = sanitizeIconTintMode(modeRaw);
  const source = sanitizeIconTintSource(sourceRaw);
  const strength = sanitizeIconTintStrength(strengthRaw);
  const shape = sanitizeIconTileShape(shapeRaw);

  let color = sanitizeIconHexColor(accentHex, ICON_TINT_DEFAULTS.color);
  if (source === "custom") {
    color = sanitizeIconHexColor(customColorRaw, color);
  } else if (source === "wallpaper") {
    color = sanitizeIconHexColor(wallpaperColorRaw ?? customColorRaw, color);
  }

  return { mode, source, color, strength, shape };
}

export function applyIconTintTokens(
  root: HTMLElement,
  accentHex: string,
  isLight: boolean,
): void {
  const { mode, source, color, strength, shape } = resolveActiveIconTint(accentHex);
  const [r, g, b] = hexToRgbTuple(color);
  const matrixValues = buildIconColorMatrixValues(mode, color, strength, isLight);
  ensureSvgIconTintFilter(matrixValues);

  const isActive = mode !== "original" && strength > 0.01;
  root.dataset.iconTint = isActive ? mode : "original";
  root.dataset.iconTintSource = source;
  root.dataset.iconTileShape = shape;

  root.style.setProperty(
    "--nectar-icon-tint-filter",
    isActive ? `url(#${FILTER_ELEMENT_ID})` : "none",
  );
  root.style.setProperty("--nectar-icon-tint-color", color);
  root.style.setProperty("--nectar-icon-tint-rgb", `${r}, ${g}, ${b}`);
  root.style.setProperty("--nectar-icon-tint-strength", strength.toFixed(2));

  const tileRadius =
    shape === "circle"
      ? "50%"
      : shape === "rounded"
        ? "20%"
        : shape === "none"
          ? "0px"
          : "27%";
  root.style.setProperty("--nectar-icon-tile-radius", tileRadius);

  if (!isActive || shape === "none") {
    root.style.setProperty("--nectar-icon-tile-bg", "transparent");
    root.style.setProperty("--nectar-icon-tile-border", "transparent");
    root.style.setProperty("--nectar-icon-tile-shadow", "none");
    return;
  }

  if (mode === "dark-glass") {
    root.style.setProperty(
      "--nectar-icon-tile-bg",
      isLight ? "rgba(28, 28, 38, 0.86)" : "rgba(16, 16, 24, 0.82)",
    );
    root.style.setProperty(
      "--nectar-icon-tile-border",
      `rgba(${r}, ${g}, ${b}, ${(0.28 * strength + 0.1).toFixed(3)})`,
    );
    root.style.setProperty(
      "--nectar-icon-tile-shadow",
      `inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 4px 12px rgba(0, 0, 0, 0.32)`,
    );
  } else if (mode === "pastel") {
    const pr = Math.round(r + (255 - r) * 0.45);
    const pg = Math.round(g + (255 - g) * 0.45);
    const pb = Math.round(b + (255 - b) * 0.45);
    root.style.setProperty(
      "--nectar-icon-tile-bg",
      `rgba(${pr}, ${pg}, ${pb}, ${(isLight ? 0.34 : 0.22).toFixed(3)})`,
    );
    root.style.setProperty(
      "--nectar-icon-tile-border",
      `rgba(${pr}, ${pg}, ${pb}, 0.36)`,
    );
    root.style.setProperty(
      "--nectar-icon-tile-shadow",
      "inset 0 1px 0 rgba(255, 255, 255, 0.22)",
    );
  } else if (mode === "duotone") {
    const dr = Math.round(r * 0.22);
    const dg = Math.round(g * 0.22);
    const db = Math.round(b * 0.26);
    root.style.setProperty("--nectar-icon-tile-bg", `rgba(${dr}, ${dg}, ${db}, 0.82)`);
    root.style.setProperty("--nectar-icon-tile-border", `rgba(${r}, ${g}, ${b}, 0.52)`);
    root.style.setProperty(
      "--nectar-icon-tile-shadow",
      `0 2px 10px rgba(${r}, ${g}, ${b}, 0.24)`,
    );
  } else {
    // "tinted"
    root.style.setProperty(
      "--nectar-icon-tile-bg",
      `rgba(${r}, ${g}, ${b}, ${(isLight ? 0.18 : 0.22).toFixed(3)})`,
    );
    root.style.setProperty(
      "--nectar-icon-tile-border",
      `rgba(${r}, ${g}, ${b}, ${(isLight ? 0.34 : 0.4).toFixed(3)})`,
    );
    root.style.setProperty(
      "--nectar-icon-tile-shadow",
      `inset 0 1px 0 rgba(255, 255, 255, ${isLight ? 0.35 : 0.14})`,
    );
  }
}
