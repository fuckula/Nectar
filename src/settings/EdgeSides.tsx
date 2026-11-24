import { ArrowLeftRight } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { Dropdown } from "./Dropdown";
import { useT } from "../i18n";
import { useSyncedSetting } from "./useSyncedSetting";

type Side = "left" | "right";

const parseLeft = (raw: unknown): Side => (raw === "right" ? "right" : "left");
const parseRight = (raw: unknown): Side => (raw === "left" ? "left" : "right");
const identity = (v: Side) => v;

export function EdgeSides() {
  const t = useT();
  const [volume, setVolume] = useSyncedSetting<Side>("nectar-volume-side", parseLeft, identity);
  const [brightness, setBrightness] = useSyncedSetting<Side>("nectar-brightness-side", parseRight, identity);
  const opposite = (side: Side): Side => (side === "left" ? "right" : "left");
  const options = [
    { value: "left", label: t("overlays.side.left") },
    { value: "right", label: t("overlays.side.right") },
  ];

  const changeVolume = (value: string) => {
    const next = value as Side;
    setVolume(next);
    if (brightness === next) {
      setBrightness(opposite(next));
    }
  };

  const changeBrightness = (value: string) => {
    const next = value as Side;
    setBrightness(next);
    if (volume === next) {
      setVolume(opposite(next));
    }
  };

  return (
    <>
      <SettingRow icon={ArrowLeftRight} label={t("overlays.volumeSide")} desc={t("overlays.side.desc")}>
        <Dropdown value={volume} onChange={changeVolume} options={options} />
      </SettingRow>
      <SettingRow icon={ArrowLeftRight} label={t("overlays.brightnessSide")} desc={t("overlays.side.desc")}>
        <Dropdown value={brightness} onChange={changeBrightness} options={options} />
      </SettingRow>
    </>
  );
}
