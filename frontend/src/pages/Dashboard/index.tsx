import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, RotateCcw, SlidersHorizontal, Sparkles, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { useFeatureTip } from "@/components/onboarding/useFeatureTip";
import { cn } from "@/lib/utils";
import {
  useUiPrefsStore, type DashboardLayout, type DashboardWidgetPlacement, type DashboardWidgetSize,
} from "@/store/uiPrefs";
import { AddWidgetDialog } from "./AddWidgetDialog";
import { DashboardGreeting } from "./Greeting";
import { useWidgetRecommendations } from "./useWidgetRecommendations";
import { WidgetErrorBoundary } from "./widgets/common";
import { STAT_SIZES, WIDGETS_BY_ID, sanitizeLayout } from "./widgets/registry";

// 1 column on phones, 2 on tablets, 4 on wide screens.
const SIZE_CLASS: Record<DashboardWidgetSize, string> = {
  sm: "col-span-1",
  md: "col-span-1 md:col-span-2",
  lg: "col-span-1 md:col-span-2 xl:col-span-4",
};
const SIZE_LABEL: Record<DashboardWidgetSize, string> = { sm: "S", md: "M", lg: "L" };
const SIZE_NAME: Record<DashboardWidgetSize, string> = { sm: "Small", md: "Medium", lg: "Large" };

const SUGGESTIONS_TIP = "dashboard-widget-suggestions";

export function DashboardPage() {
  const stored = useUiPrefsStore((s) => s.dashboardLayout);
  const setStored = useUiPrefsStore((s) => s.setDashboardLayout);
  const layout = useMemo(() => sanitizeLayout(stored), [stored]);

  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  // Arriving from the setup wizard's "Build my dashboard": open in edit mode
  // with a short explanation of what can be changed. The marker is dropped
  // from the URL so a reload is an ordinary visit.
  const [searchParams, setSearchParams] = useSearchParams();
  const [introducing, setIntroducing] = useState(false);
  useEffect(() => {
    if (searchParams.get("customize") !== "1") return;
    setEditing(true);
    setIntroducing(true);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Widgets whose feature is off stay in the saved layout (they come back if
  // the feature does) but are neither rendered nor draggable.
  const visible = layout.widgets.filter((p) => !!WIDGETS_BY_ID[p.id]);
  const placed = useMemo(() => new Set(layout.widgets.map((p) => p.id)), [layout]);

  const tip = useFeatureTip(SUGGESTIONS_TIP);
  const recommendations = useWidgetRecommendations(tip.shouldShow || adding || introducing, placed);

  function save(widgets: DashboardWidgetPlacement[]) {
    const next: DashboardLayout = { version: 1, widgets };
    setStored(next);
  }

  function addWidget(id: string) {
    if (placed.has(id)) return;
    save([...layout.widgets, { id, size: WIDGETS_BY_ID[id].defaultSize }]);
  }

  function removeWidget(id: string) {
    save(layout.widgets.filter((p) => p.id !== id));
  }

  function resizeWidget(id: string, size: DashboardWidgetSize) {
    save(layout.widgets.map((p) => (p.id === id ? { ...p, size } : p)));
  }

  function resetLayout() {
    if (window.confirm("Reset the dashboard to the default widgets and order?")) setStored(null);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    // Move within the full saved list, so hidden widgets keep their places.
    const ids = layout.widgets.map((p) => p.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    save(arrayMove(layout.widgets, from, to));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <DashboardGreeting />
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={resetLayout}>
                <RotateCcw size={14} /> Reset
              </Button>
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                <Plus size={14} /> Add widget
              </Button>
              <Button size="sm" onClick={() => setEditing(false)}>Done</Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <SlidersHorizontal size={14} /> Customize
            </Button>
          )}
        </div>
      </div>

      {tip.shouldShow && !introducing && recommendations.length > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
          <Sparkles size={16} className="text-primary shrink-0" />
          <p className="flex-1 min-w-0">
            <span className="font-medium">
              {recommendations.length} widget{recommendations.length === 1 ? "" : "s"} suggested for your accounts
            </span>
            <span className="text-muted-foreground">
              {": "}{recommendations.slice(0, 3).map((r) => WIDGETS_BY_ID[r.id].title).join(", ")}
              {recommendations.length > 3 ? ` and ${recommendations.length - 3} more` : ""}. You can also rearrange and resize everything.
            </span>
          </p>
          <Button size="sm" variant="outline" onClick={() => { setAdding(true); setEditing(true); }}>
            Review
          </Button>
          <button
            type="button"
            onClick={tip.dismiss}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="Dismiss suggestions"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {introducing && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
          <div className="flex items-start gap-3">
            <SlidersHorizontal size={18} className="mt-0.5 shrink-0 text-primary" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold">This is your dashboard. Make it yours.</p>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">Add</span> a widget for anything
                  you want to see every day.
                  {recommendations.length > 0 &&
                    ` Paiso suggests ${recommendations.length} for your accounts.`}
                </li>
                <li>
                  <span className="font-medium text-foreground">Drag</span> a widget by its handle
                  to move it.
                </li>
                <li>
                  <span className="font-medium text-foreground">Resize</span> or{" "}
                  <span className="font-medium text-foreground">remove</span> a widget from its
                  corner controls.
                </li>
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setAdding(true)}>
                  <Plus size={14} /> Add widgets
                </Button>
                <Button
                  size="sm" variant="outline"
                  onClick={() => { setIntroducing(false); setEditing(false); }}
                >
                  Done for now
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Changes save as you go. Open this again anytime with Customize.
              </p>
            </div>
          </div>
        </div>
      )}

      {editing && !introducing && (
        <p className="text-xs text-muted-foreground -mt-3">
          Drag <GripVertical size={12} className="inline -mt-0.5" /> to reorder (or focus it and use the arrow keys),
          pick a size, or remove a widget. Changes save as you go.
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visible.map((p) => p.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {visible.map((p) => (
              <SortableWidget
                key={p.id}
                placement={p}
                editing={editing}
                onRemove={() => removeWidget(p.id)}
                onResize={(size) => resizeWidget(p.id, size)}
              />
            ))}
            {editing && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="col-span-1 min-h-24 rounded-xl border-2 border-dashed border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 flex items-center justify-center gap-2 transition-colors"
              >
                <Plus size={16} /> Add widget
              </button>
            )}
          </div>
        </SortableContext>
      </DndContext>

      {visible.length === 0 && !editing && (
        <div className="rounded-xl border-2 border-dashed border-border p-8 text-center space-y-3">
          <p className="text-sm text-muted-foreground">Your dashboard is empty.</p>
          <Button size="sm" onClick={() => { setAdding(true); setEditing(true); }}>
            <Plus size={14} /> Add widgets
          </Button>
        </div>
      )}

      <AddWidgetDialog
        open={adding}
        onClose={() => setAdding(false)}
        placed={placed}
        recommendations={recommendations}
        onAdd={(id) => {
          addWidget(id);
          if (tip.shouldShow) tip.dismiss();
        }}
      />
    </div>
  );
}

function SortableWidget({
  placement,
  editing,
  onRemove,
  onResize,
}: {
  placement: DashboardWidgetPlacement;
  editing: boolean;
  onRemove: () => void;
  onResize: (size: DashboardWidgetSize) => void;
}) {
  const def = WIDGETS_BY_ID[placement.id];
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: placement.id, disabled: !editing });

  const Component = def.Component;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        SIZE_CLASS[placement.size],
        "relative min-w-0",
        // A one-number tile keeps its own height. Stretched to a chart or a
        // table beside it, it was a tall card that was mostly empty.
        def.sizes === STAT_SIZES && "self-start",
        editing && "flex flex-col rounded-xl outline-dashed outline-2 outline-offset-2 outline-primary/30",
        isDragging && "z-20 opacity-70",
      )}
    >
      {/* The edit controls sit in their own strip above the widget, so they
          never cover its title or numbers. */}
      {editing && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="touch-none cursor-grab active:cursor-grabbing rounded-md border border-border bg-card/95 p-1.5 text-muted-foreground shadow-sm hover:text-foreground"
            aria-label={`Move ${def.title}`}
          >
            <GripVertical size={14} />
          </button>
          <div className="flex items-center gap-1 rounded-md border border-border bg-card/95 p-0.5 shadow-sm">
            {def.sizes.length > 1 &&
              def.sizes.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => onResize(size)}
                  aria-pressed={placement.size === size}
                  aria-label={`${SIZE_NAME[size]} size`}
                  title={SIZE_NAME[size]}
                  className={cn(
                    "h-6 w-6 rounded text-[11px] font-semibold transition-colors",
                    placement.size === size ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {SIZE_LABEL[size]}
                </button>
              ))}
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${def.title}`}
              title="Remove"
              className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
      {/* Widget content is inert while editing so a drag never clicks a link. */}
      <div className={cn(editing ? "min-h-0 flex-1 pointer-events-none select-none" : "h-full")} aria-hidden={editing || undefined}>
        <WidgetErrorBoundary title={def.title}>
          <Component />
        </WidgetErrorBoundary>
      </div>

    </div>
  );
}
