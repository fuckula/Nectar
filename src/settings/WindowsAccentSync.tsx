import { useEffect, useRef, useState } from "react";
import { SwatchBook } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { useT } from "../i18n";
import { bridgeInvoke } from "../utils/tauriBridge";
import { useSyncedSetting } from "./useSyncedSetting";

const KEY = "nectar-sync-windows-accent";
const parseSync = (raw: unknown): boolean => raw === true || raw === "true";

export function WindowsAccentSync({ color }: { color: string }) {
  const t = useT();
  const [on, saveOn] = useSyncedSetting(KEY, parseSync, String);
  const [error, setError] = useState("");
  const prevColorRef = useRef(color);
  const onRef = useRef(on);
  onRef.current = on;
  const pendingHexRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        const pendingHex = pendingHexRef.current;
        pendingHexRef.current = null;
        if (pendingHex && onRef.current) {
          bridgeInvoke("sync_windows_accent", { hex: pendingHex }).catch(() => {});
        }
      }
    };
  }, []);

  useEffect(() => {
    if (prevColorRef.current === color) return;
    prevColorRef.current = color;
    if (!on) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    pendingHexRef.current = color;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      pendingHexRef.current = null;
      if (onRef.current) {
        bridgeInvoke("sync_windows_accent", { hex: color }).catch(() => {});
      }
    }, 400);
  }, [color, on]);

  const toggle = () => {
    const next = !on;
    setError("");
    saveOn(next);
    (next
      ? bridgeInvoke("sync_windows_accent", { hex: color })
      : bridgeInvoke("restore_windows_accent")
    ).catch((e) => {
      setError(String(e));
      saveOn(!next);
    });
  };

  return (
    <SettingRow icon={SwatchBook} label={t("appearance.syncWindowsAccent")} desc={error || t("appearance.syncWindowsAccent.desc")}>
      <label className="toggle-switch">
        <input type="checkbox" checked={on} onChange={toggle} />
        <span className="slider"></span>
      </label>
    </SettingRow>
  );
}
