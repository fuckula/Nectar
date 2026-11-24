import { bridgeInvoke, bridgeListen } from "./utils/tauriBridge";
import {
  createVisibleInterval,
  type VisibleIntervalController,
} from "./hooks/visibleInterval";

interface WallpaperBackdrop {
  image: string;
  imageWidth: number;
  imageHeight: number;
  fit: string;
  monitorWidth: number;
  monitorHeight: number;
  monitorScale: number;
  windowX: number;
  windowY: number;
  windowWidth: number;
  windowHeight: number;
}

// Blur of the 640px copy per glass style; on screen it is about three times larger.
const STYLE_BLUR: Record<string, number> = { frosted: 9, liquid: 3 };
const COVERED_POLL_MS = 2000;

const VARS = [
  "--backdrop-image",
  "--backdrop-size",
  "--backdrop-x",
  "--backdrop-top",
  "--backdrop-bottom",
];

let enabled = false;
let generation = 0;
let loaded = false;
let covered = false;
let watchController: VisibleIntervalController | null = null;
let activeRoot: HTMLElement | null = null;
let gameModeActive = false;
let gameModeListenersInitialized = false;

function readSettingBool(key: string, defaultVal: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultVal;
    return raw !== "false";
  } catch {
    return defaultVal;
  }
}

function readPerfProfile(): "balanced" | "eco" | "max" {
  try {
    const raw = localStorage.getItem("nectar-perf-profile");
    if (raw === "balanced" || raw === "eco" || raw === "max") {
      return raw;
    }
    if (localStorage.getItem("nectar-ram-saver") === "true") {
      return "eco";
    }
  } catch {
    // Ignore storage errors
  }
  return "balanced";
}

function readQuantizedBlur(style: string): number {
  const base = STYLE_BLUR[style] ?? 0;
  if (base <= 0) return 0;
  let mult = 1;
  try {
    const raw = parseFloat(localStorage.getItem("nectar-glass-blur") ?? "1");
    if (Number.isFinite(raw)) {
      mult = Math.max(0, Math.min(2, raw));
    }
  } catch {
    mult = 1;
  }
  if (mult <= 0) return 0;
  const quantized = Math.round((base * mult) / 2) * 2;
  return Math.max(0, Math.min(24, quantized));
}

function isBackdropPollPaused(): boolean {
  const gameModeEnabled = readSettingBool("nectar-game-mode", true);
  const pausePolls = readSettingBool("nectar-game-mode-pause-polls", true);
  return gameModeActive && gameModeEnabled && pausePolls;
}

function parseGameModeState(payload: unknown): boolean | null {
  if (typeof payload === "boolean") return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of [
      "game_mode_active",
      "game_mode",
      "gameModeActive",
      "gameMode",
      "active",
    ]) {
      if (typeof obj[key] === "boolean") {
        return obj[key] as boolean;
      }
    }
  }
  return null;
}

function syncWatchActivity(): void {
  if (!watchController) return;
  const shouldBeActive = !isBackdropPollPaused();
  const wasActive = watchController.isActive();
  watchController.setActive(shouldBeActive);
  if (
    !wasActive &&
    shouldBeActive &&
    loaded &&
    activeRoot &&
    (typeof document === "undefined" || !document.hidden)
  ) {
    void checkCovered(activeRoot);
  }
}

function persistBackdropSettingKey(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
    } else if (typeof value === "object") {
      localStorage.setItem(key, JSON.stringify(value));
    } else {
      localStorage.setItem(key, String(value));
    }
  } catch {
    // Ignore storage errors
  }
}

function ensureGameModeSync(): void {
  if (gameModeListenersInitialized) return;
  gameModeListenersInitialized = true;

  bridgeInvoke<unknown>("get_runtime_state")
    .then((state) => {
      const next = parseGameModeState(state);
      if (next !== null && next !== gameModeActive) {
        gameModeActive = next;
        syncWatchActivity();
      }
    })
    .catch(() => {});

  bridgeListen<unknown>("game-mode-changed", (payload) => {
    const next = parseGameModeState(payload);
    if (next !== null && next !== gameModeActive) {
      gameModeActive = next;
      syncWatchActivity();
    }
  }).catch(() => {});

  bridgeListen<{ key?: string; value?: unknown }>("settings-changed", (payload) => {
    if (
      payload?.key === "nectar-game-mode" ||
      payload?.key === "nectar-game-mode-pause-polls"
    ) {
      persistBackdropSettingKey(payload.key, payload.value);
      syncWatchActivity();
    }
  }).catch(() => {});

  bridgeListen<{ entries?: Record<string, unknown> }>(
    "settings-batch-changed",
    (payload) => {
      const entries = payload?.entries;
      if (!entries) return;
      let hit = false;
      for (const k of ["nectar-game-mode", "nectar-game-mode-pause-polls"]) {
        if (Object.prototype.hasOwnProperty.call(entries, k)) {
          persistBackdropSettingKey(k, entries[k]);
          hit = true;
        }
      }
      if (hit) syncWatchActivity();
    }
  ).catch(() => {});

  bridgeListen<{ key?: string; value?: unknown }>("settings-external-changed", (payload) => {
    if (
      payload?.key === "nectar-game-mode" ||
      payload?.key === "nectar-game-mode-pause-polls"
    ) {
      persistBackdropSettingKey(payload.key, payload.value);
      syncWatchActivity();
    }
  }).catch(() => {});

  bridgeListen<unknown>("settings-reset", () => {
    persistBackdropSettingKey("nectar-game-mode", null);
    persistBackdropSettingKey("nectar-game-mode-pause-polls", null);
    syncWatchActivity();
  }).catch(() => {});

  if (typeof window !== "undefined") {
    window.addEventListener("nectar-local-setting", (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (
        keys?.some(
          (k) => k === "nectar-game-mode" || k === "nectar-game-mode-pause-polls"
        )
      ) {
        syncWatchActivity();
      }
    });
    window.addEventListener("storage", (e: StorageEvent) => {
      if (
        e.key === null ||
        e.key === "nectar-game-mode" ||
        e.key === "nectar-game-mode-pause-polls"
      ) {
        syncWatchActivity();
      }
    });
  }
}

// Only the notch and dock draw a backdrop; other windows skip loading the wallpaper.
export function enableBackdrop() {
  enabled = true;
  ensureGameModeSync();
}

export function usesBackdrop(style: string | null) {
  return !!style && Object.prototype.hasOwnProperty.call(STYLE_BLUR, style);
}

// Where Windows draws the wallpaper on the monitor, in logical pixels.
function wallpaperRect(d: WallpaperBackdrop) {
  const mw = d.monitorWidth;
  const mh = d.monitorHeight;
  let w = mw;
  let h = mh;
  if (d.fit === "center") {
    w = d.imageWidth / d.monitorScale;
    h = d.imageHeight / d.monitorScale;
  } else if (d.fit !== "stretch") {
    // fill (and tile/span, approximated) covers the screen; fit letterboxes
    const ratio =
      d.fit === "fit"
        ? Math.min(mw / d.imageWidth, mh / d.imageHeight)
        : Math.max(mw / d.imageWidth, mh / d.imageHeight);
    w = d.imageWidth * ratio;
    h = d.imageHeight * ratio;
  }
  return { x: (mw - w) / 2, y: (mh - h) / 2, w, h };
}

function showBackdrop(root: HTMLElement) {
  root.classList.toggle("has-backdrop", loaded && !covered);
}

// Asks whether an app window is behind the notch or dock, whichever this window draws.
async function checkCovered(root: HTMLElement) {
  if ((typeof document !== "undefined" && document.hidden) || isBackdropPollPaused()) {
    return;
  }
  const r = document
    .querySelector<HTMLElement>(
      ".nectar, .dock, .launcher-surface, .start-surface, .traybar-surface"
    )
    ?.getBoundingClientRect();
  if (!r || r.width < 1 || r.height < 1) return;
  const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  const next = await bridgeInvoke<boolean>("is_backdrop_covered", { rect }).catch(
    () => covered
  );
  if (!loaded || next === covered) return;
  covered = next;
  showBackdrop(root);
}

function clearBackdrop(root: HTMLElement) {
  loaded = false;
  activeRoot = null;
  watchController?.stop();
  watchController = null;
  root.classList.remove("has-backdrop");
  for (const name of VARS) root.style.removeProperty(name);
}

export async function applyBackdrop(root: HTMLElement, style: string) {
  const current = ++generation;
  if (
    !enabled ||
    !usesBackdrop(style) ||
    localStorage.getItem("nectar-glass-wallpaper") !== "true" ||
    readPerfProfile() === "eco"
  ) {
    clearBackdrop(root);
    return;
  }

  const blur = readQuantizedBlur(style);
  if (blur <= 0) {
    clearBackdrop(root);
    return;
  }

  ensureGameModeSync();

  const d = await bridgeInvoke<WallpaperBackdrop | null>(
    "get_wallpaper_backdrop",
    { blur }
  ).catch(() => null);
  if (current !== generation) return;
  if (!d) {
    clearBackdrop(root);
    return;
  }

  const r = wallpaperRect(d);
  // The notch is zoomed and the dock scaled by the UI scale, so lengths are given before scaling.
  const scale = parseFloat(localStorage.getItem("nectar-scale") || "1") || 1;
  const px = (v: number) => `${(v / scale).toFixed(2)}px`;
  // Both are centred horizontally in their window, so the image is lined up from the centre.
  const dx = r.x + r.w / 2 - (d.windowX + d.windowWidth / 2);

  root.style.setProperty("--backdrop-image", `url("${d.image}")`);
  root.style.setProperty("--backdrop-size", `${px(r.w)} ${px(r.h)}`);
  root.style.setProperty("--backdrop-x", `calc(50% + ${px(dx)})`);
  // The notch hangs from the top of its window; the dock sits on the bottom of its window.
  root.style.setProperty("--backdrop-top", px(r.y - d.windowY));
  root.style.setProperty(
    "--backdrop-bottom",
    `calc(100% + ${px(r.y + r.h - d.windowY - d.windowHeight)})`
  );
  activeRoot = root;
  loaded = true;
  showBackdrop(root);
  watchController ??= createVisibleInterval(
    () => {
      void checkCovered(root);
    },
    COVERED_POLL_MS,
    { active: !isBackdropPollPaused() }
  );
  syncWatchActivity();
  void checkCovered(root);
}
