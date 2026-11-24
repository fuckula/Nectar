import { Timer } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { Dropdown } from "./Dropdown";
import { useT } from "../i18n";
import { useSyncedSetting } from "./useSyncedSetting";

const DELAYS = ["0", "150", "300", "600", "1000"];

const parseEdgeDelay = (raw: unknown): string => {
  const s = raw === null || raw === undefined ? "" : String(raw);
  return DELAYS.includes(s) ? s : "300";
};

export function EdgeDelay() {
  const t = useT();
  const [value, change] = useSyncedSetting("nectar-edge-delay", parseEdgeDelay, (v) => v);

  return (
    <SettingRow icon={Timer} label={t("overlays.edgeDelay")} desc={t("overlays.edgeDelay.desc")} divider={false}>
      <Dropdown
        value={value}
        onChange={change}
        options={DELAYS.map((ms) => ({ value: ms, label: ms === "0" ? t("overlays.edgeDelay.instant") : `${Number(ms) / 1000} s` }))}
      />
    </SettingRow>
  );
}
