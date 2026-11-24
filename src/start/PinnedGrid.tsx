import type { CSSProperties, KeyboardEvent } from "react";
import { useRef } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AppWindow } from "lucide-react";
import type { StartPinItem } from "./types";
import { ShellAppIcon } from "../components/ShellAppIcon";
import { isAppTintExcluded } from "../utils/iconTint";
import { useT } from "../i18n";

interface PinnedGridProps {
  pins: StartPinItem[];
  columns: number;
  loading?: boolean;
  onReorder: (next: StartPinItem[]) => void;
  onLaunch: (item: StartPinItem, e?: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent, item: StartPinItem) => void;
  onOpenAllApps?: () => void;
}

function SortableTile({
  item,
  index,
  columns,
  total,
  focusTile,
  onLaunch,
  onContextMenu,
}: {
  item: StartPinItem;
  index: number;
  columns: number;
  total: number;
  focusTile: (idx: number) => void;
  onLaunch: (item: StartPinItem, e?: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent, item: StartPinItem) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.path,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.65 : 1,
    zIndex: isDragging ? 5 : undefined,
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % total;
    else if (e.key === "ArrowLeft") next = (index - 1 + total) % total;
    else if (e.key === "ArrowDown" && index + columns < total) next = index + columns;
    else if (e.key === "ArrowUp" && index - columns >= 0) next = index - columns;
    if (next >= 0) {
      e.preventDefault();
      focusTile(next);
    }
  };

  return (
    <button
      ref={setNodeRef}
      type="button"
      data-pin-index={index}
      style={style}
      className="start-pin-tile"
      title={item.name}
      onClick={(e) => {
        if (!isDragging) onLaunch(item, e);
      }}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, item);
      }}
      {...attributes}
      {...listeners}
    >
      <div
        className="start-pin-icon nectar-tint-tile"
        data-tint-excluded={isAppTintExcluded(item.path || item.name) ? "true" : undefined}
      >
        <ShellAppIcon
          path={item.path}
          name={item.name}
          initialIcon={item.icon}
          fallback={<AppWindow size={22} strokeWidth={1.7} />}
        />
      </div>
      <span className="start-pin-label">{item.name}</span>
    </button>
  );
}

export function PinnedGrid({
  pins,
  columns,
  loading,
  onReorder,
  onLaunch,
  onContextMenu,
  onOpenAllApps,
}: PinnedGridProps) {
  const t = useT();
  const gridRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = pins.findIndex((p) => p.path === active.id);
    const newIdx = pins.findIndex((p) => p.path === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    onReorder(arrayMove(pins, oldIdx, newIdx));
  };

  const focusTile = (idx: number) => {
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-pin-index="${idx}"]`)?.focus();
  };

  if (pins.length === 0) {
    return (
      <div className="start-pins-empty">
        <span>{loading ? t("start.loading") : t("start.noPins")}</span>
        {!loading && onOpenAllApps && (
          <button type="button" className="start-pill-btn" onClick={onOpenAllApps}>
            {t("start.allApps")}
          </button>
        )}
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={pins.map((p) => p.path)} strategy={rectSortingStrategy}>
        <div
          ref={gridRef}
          className="start-pinned-grid"
          style={{ "--start-cols": columns } as CSSProperties}
        >
          {pins.map((item, idx) => (
            <SortableTile
              key={item.path}
              item={item}
              index={idx}
              columns={columns}
              total={pins.length}
              focusTile={focusTile}
              onLaunch={onLaunch}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
