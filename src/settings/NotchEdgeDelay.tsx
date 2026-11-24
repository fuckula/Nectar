import { Timer } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { Dropdown } from "./Dropdown";
import { useT } from "../i18n";
import { useSyncedSetting } from "./useSyncedSetting";

const DELAYS = ["0", "200", "400", "700", "1000", "2000"];

const parseNotchEdgeDelay = (raw: unknown): string => {
  const s = raw === null || raw === undefined ? "" : String(raw);
  return DELAYS.includes(s) ? s : "200";
};

export function NotchEdgeDelay() {
  const t = useT();
  const [value, change] = useSyncedSetting("nectar-notch-edge-delay", parseNotchEdgeDelay, (v) => v);

  return (
    <SettingRow icon={Timer} label={t("notch.edgeDelay")} desc={t("notch.edgeDelay.desc")}>
      <Dropdown
        value={value}
        onChange={change}
        options={DELAYS.map((ms) => ({ value: ms, label: ms === "0" ? t("overlays.edgeDelay.instant") : `${Number(ms) / 1000} s` }))}
      />
    </SettingRow>
  );
}
