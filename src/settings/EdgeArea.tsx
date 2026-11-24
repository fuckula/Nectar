import { MousePointer2 } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { Dropdown } from "./Dropdown";
import { useT } from "../i18n";
import { useSyncedSetting } from "./useSyncedSetting";

const parseEdgeArea = (raw: unknown): string => (raw === "narrow" ? "narrow" : "full");

export function EdgeArea({ settingKey }: { settingKey: "nectar-notch-edge-area" | "nectar-dock-edge-area" }) {
  const t = useT();
  const [value, change] = useSyncedSetting(settingKey, parseEdgeArea, (v) => v);

  return (
    <SettingRow icon={MousePointer2} label={t("edgeArea.label")} desc={t(settingKey === "nectar-notch-edge-area" ? "edgeArea.notch.desc" : "edgeArea.dock.desc")}>
      <Dropdown
        value={value}
        onChange={change}
        options={[
          { value: "full", label: t("edgeArea.full") },
          { value: "narrow", label: t("edgeArea.narrow") },
        ]}
      />
    </SettingRow>
  );
}
