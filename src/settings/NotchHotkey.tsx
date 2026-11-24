import { AlertTriangle, Keyboard } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { useT } from "../i18n";
import { useSyncedSetting } from "./useSyncedSetting";
import { isHotkeyConflicted, useHotkeyStatus } from "./useHotkeyStatus";

const parseHotkey = (raw: unknown): string =>
  raw === null || raw === undefined ? "" : String(raw);

export function NotchHotkey() {
  const t = useT();
  const [value, saveHotkey] = useSyncedSetting("nectar-notch-hotkey", parseHotkey, (v) => v);
  const [hotkeyStatus, refreshHotkeyStatus] = useHotkeyStatus(value);
  const hotkeyConflict = isHotkeyConflicted(
    value,
    hotkeyStatus?.notch_ok,
    hotkeyStatus?.notch_shortcut
  );

  const commit = (next: string) => {
    saveHotkey(next).then(refreshHotkeyStatus);
  };

  return (
    <>
      <SettingRow icon={Keyboard} label={t("notch.hotkey")} desc={t("notch.hotkey.desc")} divider={false}>
        <ShortcutRecorder value={value} onCommit={commit} />
      </SettingRow>
      {hotkeyConflict && (
        <div className="settings-inline-warning" role="alert">
          <AlertTriangle size={13} />
          <span>{t("settings.hotkeyConflict")}</span>
        </div>
      )}
    </>
  );
}
