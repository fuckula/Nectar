import { useCallback, useEffect, useState } from "react";
import { bridgeListen } from "../utils/tauriBridge";

export type UiDensity = "compact" | "comfortable" | "spacious";
export type PerfProfile = "balanced" | "eco" | "max";
export type MotionPreset = "snappy" | "springy" | "liquid" | "minimal";

export interface SurfaceMetricsSnapshot {
  radiusScale: number;
  motionSpeed: number;
  motionPreset: MotionPreset;
  density: UiDensity;
  perfProfile: PerfProfile;
  metricsIntervalMs: number;
}

export type SpringTransitionType = "spring" | "tween" | "inertia" | "keyframes" | "decay";
export type SpringConfigInput = { type?: SpringTransitionType } & Record<string, unknown>;

export interface SurfaceMetrics extends SurfaceMetricsSnapshot {
  scaledRadius: (base: number, min?: number, max?: number) => number;
  scaleDuration: (sec: number) => number;
  scaleSpring: <T extends SpringConfigInput>(springCfg: T) => T;
}

const VALID_DENSITIES = new Set<UiDensity>(["compact", "comfortable", "spacious"]);
const VALID_PROFILES = new Set<PerfProfile>(["balanced", "eco", "max"]);
const VALID_MOTION_PRESETS = new Set<MotionPreset>(["snappy", "springy", "liquid", "minimal"]);
const VALID_METRICS_INTERVALS = new Set([1000, 1500, 3000, 5000, 10000]);

const METRIC_KEYS = new Set([
  "nectar-radius-scale",
  "nectar-motion-speed",
  "nectar-motion-preset",
  "nectar-ui-density",
  "nectar-perf-profile",
  "nectar-ram-saver",
  "nectar-metrics-interval-ms",
]);

function persistMetricKey(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
    } else if (typeof value === "object") {
      localStorage.setItem(key, JSON.stringify(value));
    } else {
      localStorage.setItem(key, String(value));
    }
  } catch {
    // Ignore storage restrictions
  }
}

function readClampedFloat(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw.trim() === "") return fallback;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  } catch {
    return fallback;
  }
}

export function readSurfaceMetricsSnapshot(): SurfaceMetricsSnapshot {
  const radiusScale = readClampedFloat("nectar-radius-scale", 1, 0.6, 1.35);
  const motionSpeed = readClampedFloat("nectar-motion-speed", 1, 0, 1.5);

  let motionPreset: MotionPreset = "springy";
  let density: UiDensity = "comfortable";
  let perfProfile: PerfProfile = "balanced";
  let metricsIntervalMs = 3000;

  try {
    const rawPreset = localStorage.getItem("nectar-motion-preset") as MotionPreset | null;
    if (rawPreset && VALID_MOTION_PRESETS.has(rawPreset)) {
      motionPreset = rawPreset;
    }

    const rawDensity = localStorage.getItem("nectar-ui-density") as UiDensity | null;
    if (rawDensity && VALID_DENSITIES.has(rawDensity)) {
      density = rawDensity;
    }

    const rawProfile = localStorage.getItem("nectar-perf-profile") as PerfProfile | null;
    if (rawProfile && VALID_PROFILES.has(rawProfile)) {
      perfProfile = rawProfile;
    } else if (localStorage.getItem("nectar-ram-saver") === "true") {
      perfProfile = "eco";
    }

    const rawInterval = parseInt(localStorage.getItem("nectar-metrics-interval-ms") || "", 10);
    if (VALID_METRICS_INTERVALS.has(rawInterval)) {
      metricsIntervalMs = rawInterval;
    }
  } catch {
    // Ignore storage restrictions
  }

  return {
    radiusScale,
    motionSpeed,
    motionPreset,
    density,
    perfProfile,
    metricsIntervalMs,
  };
}

export function computeScaledRadius(
  base: number,
  radiusScale: number,
  min = 12,
  max = 32
): number {
  const scaled = Math.round(base * radiusScale);
  return Math.max(min, Math.min(max, scaled));
}

export function computeScaledDuration(
  sec: number,
  motionSpeed: number,
  motionPreset: MotionPreset = "springy",
): number {
  if (motionSpeed <= 0) return 0.001;
  const presetMult =
    motionPreset === "snappy"
      ? 0.78
      : motionPreset === "liquid"
        ? 1.28
        : motionPreset === "minimal"
          ? 0.65
          : 1;
  return Math.max(0.001, (sec * presetMult) / motionSpeed);
}

export function computeScaledSpring<T extends SpringConfigInput>(
  springCfg: T,
  motionSpeed: number,
  motionPreset: MotionPreset = "springy",
): T {
  if (motionSpeed <= 0) {
    return {
      ...springCfg,
      type: "tween",
      duration: 0.001,
    } as T;
  }
  if (motionPreset === "minimal") {
    const baseDur = typeof springCfg.duration === "number" ? springCfg.duration : 0.2;
    return {
      ...springCfg,
      type: "tween",
      duration: Math.max(0.02, (baseDur * 0.65) / motionSpeed),
    } as T;
  }
  if (Math.abs(motionSpeed - 1) < 0.01 && motionPreset === "springy") {
    return springCfg;
  }
  const durMult =
    motionPreset === "snappy" ? 0.78 : motionPreset === "liquid" ? 1.28 : 1;
  const stiffMult =
    motionPreset === "snappy" ? 1.35 : motionPreset === "liquid" ? 0.72 : 1;
  const dampMult =
    motionPreset === "snappy" ? 1.08 : motionPreset === "liquid" ? 0.92 : 1.0;

  const next: Record<string, unknown> = { ...springCfg };
  if (typeof next.duration === "number") {
    next.duration = Math.max(0.01, (next.duration * durMult) / motionSpeed);
  }
  if (typeof next.stiffness === "number") {
    next.stiffness = Math.round(next.stiffness * stiffMult * motionSpeed * motionSpeed);
  }
  if (typeof next.damping === "number") {
    next.damping = Math.round(next.damping * dampMult * motionSpeed);
  }
  return next as T;
}

function sameSnapshot(a: SurfaceMetricsSnapshot, b: SurfaceMetricsSnapshot): boolean {
  return (
    a.radiusScale === b.radiusScale &&
    a.motionSpeed === b.motionSpeed &&
    a.motionPreset === b.motionPreset &&
    a.density === b.density &&
    a.perfProfile === b.perfProfile &&
    a.metricsIntervalMs === b.metricsIntervalMs
  );
}

export function useSurfaceMetrics(): SurfaceMetrics {
  const [snap, setSnap] = useState<SurfaceMetricsSnapshot>(() => readSurfaceMetricsSnapshot());

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      const next = readSurfaceMetricsSnapshot();
      setSnap((prev) => (sameSnapshot(prev, next) ? prev : next));
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === null || METRIC_KEYS.has(e.key)) refresh();
    };
    const onLocal = (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (!keys || keys.some((k) => METRIC_KEYS.has(k))) refresh();
    };

    window.addEventListener("nectar-theme-applied", refresh);
    window.addEventListener("storage", onStorage);
    window.addEventListener("nectar-local-setting", onLocal);

    let stopSC: (() => void) | undefined;
    let stopSBC: (() => void) | undefined;
    let stopSEC: (() => void) | undefined;
    let stopReset: (() => void) | undefined;

    bridgeListen<{ key?: string; value?: unknown }>("settings-changed", (p) => {
      if (p?.key && METRIC_KEYS.has(p.key)) {
        persistMetricKey(p.key, p.value);
        refresh();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else stopSC = fn;
    });

    bridgeListen<{ entries?: Record<string, unknown> }>("settings-batch-changed", (p) => {
      const entries = p?.entries;
      if (!entries) return;
      let hit = false;
      for (const [k, v] of Object.entries(entries)) {
        if (METRIC_KEYS.has(k)) {
          persistMetricKey(k, v);
          hit = true;
        }
      }
      if (hit) refresh();
    }).then((fn) => {
      if (cancelled) fn();
      else stopSBC = fn;
    });

    bridgeListen<{ key?: string; value?: unknown }>("settings-external-changed", (p) => {
      if (p?.key && METRIC_KEYS.has(p.key)) {
        persistMetricKey(p.key, p.value);
        refresh();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else stopSEC = fn;
    });

    bridgeListen<unknown>("settings-reset", () => {
      for (const k of METRIC_KEYS) {
        persistMetricKey(k, null);
      }
      refresh();
    }).then((fn) => {
      if (cancelled) fn();
      else stopReset = fn;
    });

    return () => {
      cancelled = true;
      window.removeEventListener("nectar-theme-applied", refresh);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("nectar-local-setting", onLocal);
      stopSC?.();
      stopSBC?.();
      stopSEC?.();
      stopReset?.();
    };
  }, []);

  const scaledRadius = useCallback(
    (base: number, min = 12, max = 32) => computeScaledRadius(base, snap.radiusScale, min, max),
    [snap.radiusScale]
  );

  const scaleDuration = useCallback(
    (sec: number) => computeScaledDuration(sec, snap.motionSpeed, snap.motionPreset),
    [snap.motionSpeed, snap.motionPreset]
  );

  const scaleSpring = useCallback(
    <T extends SpringConfigInput>(springCfg: T) =>
      computeScaledSpring(springCfg, snap.motionSpeed, snap.motionPreset),
    [snap.motionSpeed, snap.motionPreset]
  );

  return {
    ...snap,
    scaledRadius,
    scaleDuration,
    scaleSpring,
  };
}
