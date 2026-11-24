import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, Lock, X, Bluetooth, Check, Speaker } from "lucide-react";
import { useT } from "../i18n";
import { setVisibleInterval } from "../hooks/visibleInterval";

interface WifiNetwork {
  ssid: string;
  signal: number;
  secured: boolean;
  connected: boolean;
  known: boolean;
}

interface BluetoothDeviceInfo {
  id: string;
  name: string;
  connected: boolean;
}

interface OutputDevice {
  id: string;
  name: string;
  is_default: boolean;
}

interface Props {
  kind: "wifi" | "bluetooth" | "audio";
  onBack: () => void;
  onOpenWindowsSettings: () => void;
  tip?: (text: string | undefined) => Record<string, unknown>;
  bluetoothAvailable?: boolean | null;
  onPasswordPromptChange?: (active: boolean) => void;
}

const REFRESH_MS = 6000;

function SignalBars({ signal }: { signal: number }) {
  const t = useT();
  const level = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
  return (
    <span className="cv-signal" aria-label={t("connections.signal", { percent: signal })}>
      {[1, 2, 3, 4].map((bar) => (
        <i key={bar} className={bar <= level ? "on" : ""} style={{ height: 3 + bar * 2.5 }} />
      ))}
    </span>
  );
}

interface AudioSession {
  pid: number;
  name: string;
  volume: number;
  is_muted: boolean;
}

const APP_VOLUME_THROTTLE_MS = 50;

function AppVolumes() {
  const t = useT();
  const [sessions, setSessions] = useState<AudioSession[] | null>(null);
  const dragging = useRef(false);
  const lastSentAtRef = useRef<Map<number, number>>(new Map());
  const pendingVolumesRef = useRef<Map<number, number>>(new Map());
  const throttleTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const sendVolumeIpc = useCallback((pid: number, volume: number) => {
    lastSentAtRef.current.set(pid, Date.now());
    pendingVolumesRef.current.delete(pid);
    invoke("set_app_volume", { pid, volume }).catch(() => {});
  }, []);

  const scheduleVolumeIpc = useCallback((pid: number, volume: number) => {
    const now = Date.now();
    const last = lastSentAtRef.current.get(pid) ?? 0;
    const elapsed = now - last;
    if (elapsed >= APP_VOLUME_THROTTLE_MS && !throttleTimersRef.current.has(pid)) {
      sendVolumeIpc(pid, volume);
      return;
    }
    pendingVolumesRef.current.set(pid, volume);
    if (!throttleTimersRef.current.has(pid)) {
      const timer = setTimeout(() => {
        throttleTimersRef.current.delete(pid);
        const pending = pendingVolumesRef.current.get(pid);
        if (pending !== undefined) {
          sendVolumeIpc(pid, pending);
        }
      }, Math.max(0, APP_VOLUME_THROTTLE_MS - elapsed));
      throttleTimersRef.current.set(pid, timer);
    }
  }, [sendVolumeIpc]);

  const flushVolumeIpc = useCallback((pid: number) => {
    const timer = throttleTimersRef.current.get(pid);
    if (timer !== undefined) {
      clearTimeout(timer);
      throttleTimersRef.current.delete(pid);
    }
    const pending = pendingVolumesRef.current.get(pid);
    if (pending !== undefined) {
      sendVolumeIpc(pid, pending);
    }
  }, [sendVolumeIpc]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (dragging.current) return;
      invoke<AudioSession[]>("get_audio_sessions")
        .then((res) => { if (alive) setSessions(res); })
        .catch(() => { if (alive) setSessions((prev) => prev ?? []); });
    };
    load();
    const timer = setVisibleInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
      throttleTimersRef.current.forEach((tId) => clearTimeout(tId));
      throttleTimersRef.current.clear();
      pendingVolumesRef.current.forEach((vol, pid) => {
        invoke("set_app_volume", { pid, volume: vol }).catch(() => {});
      });
      pendingVolumesRef.current.clear();
    };
  }, []);

  const setVolume = (pid: number, volume: number) => {
    setSessions((prev) => prev?.map((s) => (s.pid === pid ? { ...s, volume, is_muted: volume === 0 } : s)) ?? prev);
    scheduleVolumeIpc(pid, volume);
  };

  const releaseCapture = (el: HTMLInputElement, pointerId: number) => {
    try {
      if (el.hasPointerCapture(pointerId)) {
        el.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore if pointer capture is unsupported or already released
    }
  };

  return (
    <>
      <div className="cv-section">{t("connections.audio.apps")}</div>
      {sessions?.length === 0 && <div className="cv-hint">{t("overlay.mixer.empty")}</div>}
      {sessions?.map((s) => (
        <div key={s.pid} className="cv-row cv-app-row">
          <span className="cv-name">{s.name}</span>
          <div className="cc-classic-slider-track">
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={s.is_muted ? 0 : s.volume}
              className="cc-classic-input"
              onChange={(e) => setVolume(s.pid, parseFloat(e.target.value))}
              onPointerDown={(e) => {
                e.stopPropagation();
                dragging.current = true;
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {}
              }}
              onPointerUp={(e) => {
                dragging.current = false;
                releaseCapture(e.currentTarget, e.pointerId);
                flushVolumeIpc(s.pid);
              }}
              onPointerCancel={(e) => {
                dragging.current = false;
                releaseCapture(e.currentTarget, e.pointerId);
                flushVolumeIpc(s.pid);
              }}
              onLostPointerCapture={() => {
                dragging.current = false;
                flushVolumeIpc(s.pid);
              }}
              onClick={(e) => e.stopPropagation()}
            />
            <div className="cc-classic-fill" style={{ width: `${(s.is_muted ? 0 : s.volume) * 100}%` }} />
          </div>
        </div>
      ))}
    </>
  );
}

export function ConnectionsView({
  kind,
  onBack,
  onOpenWindowsSettings,
  tip = () => ({}),
  bluetoothAvailable = null,
  onPasswordPromptChange,
}: Props) {
  const [networks, setNetworks] = useState<WifiNetwork[] | null>(null);
  const [devices, setDevices] = useState<BluetoothDeviceInfo[] | null>(null);
  const [outputs, setOutputs] = useState<OutputDevice[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const onPasswordPromptChangeRef = useRef(onPasswordPromptChange);
  onPasswordPromptChangeRef.current = onPasswordPromptChange;
  const mountedRef = useRef(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (kind !== "wifi") {
      setPasswordFor(null);
      setPassword("");
    }
  }, [kind]);

  useEffect(() => {
    if (passwordFor === null) return;
    onPasswordPromptChangeRef.current?.(true);
    invoke("set_window_keyboard_focus", { enabled: true })
      .catch(() => {})
      .finally(() => {
        passwordInputRef.current?.focus();
      });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPasswordFor(null);
        setPassword("");
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      invoke("set_window_keyboard_focus", { enabled: false }).catch(() => {});
      onPasswordPromptChangeRef.current?.(false);
    };
  }, [passwordFor]);

  const refresh = useCallback(async () => {
    try {
      if (kind === "wifi") {
        const res = await invoke<WifiNetwork[]>("wifi_scan");
        if (mountedRef.current) setNetworks(res);
      } else if (kind === "audio") {
        const res = await invoke<OutputDevice[]>("get_audio_devices");
        if (mountedRef.current) setOutputs(res);
      } else {
        const res = await invoke<BluetoothDeviceInfo[]>("bluetooth_devices");
        if (mountedRef.current) setDevices(res);
      }
      if (mountedRef.current) setError("");
    } catch (e) {
      if (!mountedRef.current) return;
      setError(String(e));
      if (kind === "wifi") setNetworks((prev) => prev ?? []);
      else if (kind === "audio") setOutputs((prev) => prev ?? []);
      else setDevices((prev) => prev ?? []);
    }
  }, [kind]);

  useEffect(() => {
    void refresh();
    const timer = setVisibleInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const t = useT();
  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (e) {
      if (mountedRef.current) setError(String(e));
    } finally {
      if (mountedRef.current) {
        setBusy("");
        if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          if (mountedRef.current) void refresh();
        }, 1200);
      }
    }
  };

  const joinNetwork = (network: WifiNetwork) => {
    if (network.connected) return;
    if (network.secured && !network.known) {
      setPasswordFor(network.ssid);
      setPassword("");
      return;
    }
    void run(network.ssid, () => invoke("wifi_connect", { ssid: network.ssid, password: null }));
  };

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordFor || !password) return;
    const ssid = passwordFor;
    const key = password;
    setPasswordFor(null);
    setPassword("");
    void run(ssid, () => invoke("wifi_connect", { ssid, password: key }));
  };

  const list = kind === "wifi" ? networks : kind === "audio" ? outputs : devices;
  const loading = list === null;
  const empty = list?.length === 0;
  const title = t(kind === "wifi" ? "connections.wifi.title" : kind === "audio" ? "connections.audio.title" : "connections.bluetooth.title");
  const emptyText = t(kind === "wifi" ? "connections.wifi.empty" : kind === "audio" ? "connections.audio.empty" : "connections.bluetooth.empty");

  return (
    <div className="cv-root" onClick={(e) => e.stopPropagation()}>
      <div className="cv-header">
        <button
          className="cv-back"
          onClick={() => {
            setPasswordFor(null);
            setPassword("");
            onBack();
          }}
          aria-label={t("common.back")}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="cv-title">{title}</span>
        <button className="cv-link" onClick={onOpenWindowsSettings}>{t("connections.windowsSettings")}</button>
      </div>

      <div className="cv-list">
        {loading && <div className="cv-hint">{kind === "wifi" ? t("connections.scanning") : t("connections.loading")}</div>}
        {kind === "bluetooth" && !loading && bluetoothAvailable === false && (
          <div className="cv-hint">{t("connections.bluetoothUnavailable")}</div>
        )}
        {!loading && empty && !error && !(kind === "bluetooth" && bluetoothAvailable === false) && (
          <div className="cv-hint">{emptyText}</div>
        )}

        {kind === "audio" && outputs?.map((o) => (
          <div
            key={o.id}
            className={`cv-row${o.is_default ? " connected" : ""}${busy === o.id ? " busy" : ""}`}
            onClick={() => { if (!o.is_default) void run(o.id, () => invoke("set_default_audio_device", { id: o.id })); }}
          >
            <Speaker size={13} className="cv-bt-icon" />
            <span className="cv-name">{o.name}</span>
            {o.is_default ? <Check size={14} /> : <span className="cv-status">{busy === o.id ? t("connections.switching") : ""}</span>}
          </div>
        ))}

        {kind === "audio" && <AppVolumes />}

        {kind === "wifi" && networks?.map((n) => (
          <div key={n.ssid}>
            <div
              className={`cv-row${n.connected ? " connected" : ""}${busy === n.ssid ? " busy" : ""}`}
              onClick={() => joinNetwork(n)}
            >
              <SignalBars signal={n.signal} />
              <span className="cv-name">{n.ssid}</span>
              {n.secured && <Lock size={11} className="cv-lock" />}
              <span className="cv-status">{busy === n.ssid ? t("connections.connecting") : n.connected ? t("connections.connected") : n.known ? t("connections.saved") : ""}</span>
              {n.connected && (
                <button className="cv-action" onClick={(e) => { e.stopPropagation(); void run(n.ssid, () => invoke("wifi_disconnect")); }}>
                  {t("connections.disconnect")}
                </button>
              )}
              {n.known && !n.connected && (
                <button
                  className="cv-icon-btn"
                  {...tip(t("connections.forget"))}
                  onClick={(e) => { e.stopPropagation(); void run(n.ssid, () => invoke("wifi_forget", { ssid: n.ssid })); }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {passwordFor === n.ssid && (
              <form className="cv-password" onSubmit={submitPassword}>
                <input
                  ref={passwordInputRef}
                  type="password"
                  autoFocus
                  value={password}
                  onMouseDown={() => {
                    invoke("set_window_keyboard_focus", { enabled: true })
                      .catch(() => {})
                      .finally(() => passwordInputRef.current?.focus());
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setPasswordFor(null);
                      setPassword("");
                    }
                  }}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("connections.password")}
                  spellCheck={false}
                />
                <button type="submit" disabled={!password}>{t("connections.join")}</button>
              </form>
            )}
          </div>
        ))}

        {kind === "bluetooth" && devices?.map((d) => (
          <div
            key={d.id}
            className={`cv-row${d.connected ? " connected" : ""}`}
            onClick={() => {
              invoke("open_bluetooth_settings").catch(() => {});
            }}
          >
            <Bluetooth size={13} className="cv-bt-icon" />
            <span className="cv-name">{d.name}</span>
            <span className="cv-status">{d.connected ? t("connections.connected") : t("connections.paired")}</span>
            {confirmRemove === d.id ? (
              <button
                className="cv-action danger"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmRemove(null);
                  void run(d.id, () => invoke("bluetooth_unpair", { id: d.id }));
                }}
              >
                {t("connections.removeConfirm")}
              </button>
            ) : (
              <button
                className="cv-icon-btn"
                {...tip(t("connections.removeDevice"))}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmRemove(d.id);
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}

        {kind === "bluetooth" && !loading && (
          <button
            type="button"
            className="cv-settings-btn"
            onClick={() => {
              invoke("open_bluetooth_settings").catch(() => {});
            }}
          >
            {t("connections.openBluetoothSettings")}
          </button>
        )}
      </div>

      {error && <div className="cv-error">{error}</div>}
    </div>
  );
}

