import { useEffect, useMemo, useState } from "react";
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useDroppable, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { AlertTriangle, Pencil, Plus, RefreshCw } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { SideDrawer } from "@/components/ui/SideDrawer";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { CategoryIcon } from "@/lib/categoryIcons";
import { api } from "@/lib/api";
import {
  useCategories,
  useCategoryTree,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  useRecategorize,
  useReorderCategories,
} from "@/hooks/useCategories";
import type { Category } from "@/types";
import { EmojiPicker } from "./categories/EmojiPicker";
import { MoveCategoryDialog } from "./categories/MoveCategoryDialog";

type Treatment = "income" | "expense" | "transfer";

/** The built-in groups come first, in this order; groups the user made follow. */
const BUILT_IN = ["income", "expense", "transfer"];
const TREATMENT_LABEL: Record<string, string> = { income: "Income", expense: "Expense", transfer: "Transfer" };

const isUncategorizedRoot = (c: Category) =>
  c.parent_id === null && /^uncategorized$/i.test(c.name);

type DrawerState =
  | { mode: "new"; group: Category }
  | { mode: "edit"; category: Category }
  | { mode: "new-group" }
  | { mode: "edit-group"; group: Category }
  | null;

/**
 * Settings → Categories. Categories sit in groups: Income,
 * Expense and Transfer, and any the user makes, each counting its categories
 * as income, spending or a transfer. Each shows an emoji. Categories drag to
 * reorder inside a group; dragging one to another group (or Move to group in
 * its drawer) asks where its transactions go first.
 */
export function CategoriesTab() {
  const { roots, children, flat, isLoading } = useCategoryTree();
  const reorder = useReorderCategories();
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [moving, setMoving] = useState<{ category: Category; group: Category } | null>(null);

  const groups = useMemo(() => {
    const builtIn = BUILT_IN.map((n) => roots.find((r) => r.is_group && r.name.toLowerCase() === n)).filter(
      (g): g is Category => !!g,
    );
    const own = roots.filter((r) => r.is_group && !builtIn.includes(r));
    return [...builtIn, ...own];
  }, [roots]);
  const groupIds = new Set(groups.map((g) => g.id));
  // Anything outside a group (legacy or restored data), so the page is never blank.
  const ungrouped = flat.filter(
    (c) => !c.is_group && !isUncategorizedRoot(c) && (c.parent_id === null || !groupIds.has(c.parent_id)),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over) return;
    const cat = flat.find((c) => c.id === Number(active.id));
    if (!cat) return;
    const overId = String(over.id);
    const targetGroupId = overId.startsWith("group:") ? Number(overId.slice(6)) : flat.find((c) => c.id === Number(overId))?.parent_id;
    if (targetGroupId == null) return;
    if (targetGroupId !== cat.parent_id) {
      const group = groups.find((g) => g.id === targetGroupId);
      if (group) setMoving({ category: cat, group });
      return;
    }
    const ids = children(targetGroupId).map((c) => c.id);
    const from = ids.indexOf(cat.id);
    const to = ids.indexOf(Number(overId));
    if (from < 0 || to < 0 || from === to) return;
    reorder.mutate(arrayMove(ids, from, to).map((id, position) => ({ id, position })));
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[...Array(3)].map((_, i) => <div key={i} className="h-64 rounded-2xl bg-muted animate-pulse" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Categories</h2>
          <p className="text-sm text-muted-foreground">
            Categories sit in groups. Drag a category to reorder it, or into another group to move it.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setDrawer({ mode: "new-group" })}>
          <Plus size={13} /> New group
        </Button>
      </div>

      {groups.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {groups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                categories={children(group.id)}
                builtIn={BUILT_IN.includes(group.name.toLowerCase())}
                onAdd={() => setDrawer({ mode: "new", group })}
                onEditGroup={() => setDrawer({ mode: "edit-group", group })}
                onEdit={(category) => setDrawer({ mode: "edit", category })}
              />
            ))}
          </div>
        </DndContext>
      )}

      {ungrouped.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <div>
            <h3 className="font-medium">Other categories</h3>
            <p className="text-xs text-muted-foreground">
              These categories sit outside any group. They usually come from imported or restored data. Open one to
              move it into a group.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
            {ungrouped.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setDrawer({ mode: "edit", category: cat })}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 transition-colors"
              >
                <CategoryIcon name={cat.name} icon={cat.icon} size={14} />
                <span className="truncate">{cat.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {flat.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center">
          <p className="text-sm font-medium">No categories yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Use “Reset Categories to Defaults” below to get the standard set.
          </p>
        </div>
      )}

      <CategoryActions />

      <CategoryDrawer
        drawer={drawer}
        groups={groups}
        onClose={() => setDrawer(null)}
        onMove={(category, group) => { setDrawer(null); setMoving({ category, group }); }}
      />
      <MoveCategoryDialog
        category={moving?.category ?? null}
        group={moving?.group ?? null}
        groupCategories={moving ? children(moving.group.id) : []}
        onClose={() => setMoving(null)}
      />
    </div>
  );
}

function GroupCard({
  group, categories, builtIn, onAdd, onEditGroup, onEdit,
}: {
  group: Category;
  categories: Category[];
  builtIn: boolean;
  onAdd: () => void;
  onEditGroup: () => void;
  onEdit: (c: Category) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${group.id}` });
  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <CategoryIcon name={group.name} icon={group.icon} size={16} />
          <h3 className="font-medium truncate">{group.name}</h3>
          <span className="text-xs text-muted-foreground">({categories.length})</span>
          {!builtIn && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/80 border border-border rounded px-1">
              {TREATMENT_LABEL[group.treatment ?? "expense"]}
            </span>
          )}
        </div>
        <div className="flex items-center">
          {!builtIn && (
            <button onClick={onEditGroup} aria-label={`Edit group ${group.name}`}
              className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <Pencil size={13} />
            </button>
          )}
          <Button variant="ghost" size="sm" onClick={onAdd}>
            <Plus size={13} /> Add
          </Button>
        </div>
      </div>
      <SortableContext items={categories.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        {/* Every category shows: no scroll of its own inside the page's. */}
        <div ref={setNodeRef} className={`space-y-0.5 min-h-[2.5rem] rounded-md ${isOver ? "bg-primary/5" : ""}`}>
          {categories.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No categories yet. Add one, or drag one here.</p>
          ) : (
            categories.map((c) => <CategoryRow key={c.id} category={c} onEdit={() => onEdit(c)} />)
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function CategoryRow({ category, onEdit }: { category: Category; onEdit: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: category.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-1 rounded-md bg-card ${isDragging ? "relative z-10 shadow-lg" : ""}`}
    >
      <button type="button" {...attributes} {...listeners} aria-label={`Drag ${category.name}`}
        className="p-1 cursor-grab touch-none text-muted-foreground hover:text-foreground">
        <GripVertical size={13} />
      </button>
      <button
        onClick={onEdit}
        className="flex flex-1 min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted/60 transition-colors"
      >
        <CategoryIcon name={category.name} icon={category.icon} size={14} />
        <span className="truncate">{category.name}</span>
      </button>
    </div>
  );
}

// ── Drawers: a category, or a group ──────────────────────────────────────────

function CategoryDrawer({
  drawer, groups, onClose, onMove,
}: {
  drawer: DrawerState;
  groups: Category[];
  onClose: () => void;
  onMove: (category: Category, group: Category) => void;
}) {
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const remove = useDeleteCategory();

  const isGroup = drawer?.mode === "new-group" || drawer?.mode === "edit-group";
  const existing = drawer?.mode === "edit" ? drawer.category : drawer?.mode === "edit-group" ? drawer.group : null;
  const isNew = drawer?.mode === "new" || drawer?.mode === "new-group";

  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [treatment, setTreatment] = useState<Treatment>("expense");
  const [moveTo, setMoveTo] = useState<number | "">("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const { data: all = [] } = useCategories();
  // A group with categories in it cannot be deleted; say so up front.
  const childCount = isGroup && existing ? all.filter((c) => c.parent_id === existing.id).length : 0;
  // What Paiso would pick from the name, for the emoji preview.
  const [suggested, setSuggested] = useState("");
  useEffect(() => {
    if (!isNew || emoji || !name.trim()) { setSuggested(""); return; }
    const t = setTimeout(() => {
      api.get<{ emoji: string }>(`/categories/emoji?name=${encodeURIComponent(name.trim())}&is_group=${isGroup}`)
        .then((r) => setSuggested(r.emoji))
        .catch(() => setSuggested(""));
    }, 250);
    return () => clearTimeout(t);
  }, [name, emoji, isNew, isGroup]);

  // Re-seed local form when the target changes.
  useEffect(() => {
    setName(existing?.name ?? "");
    setEmoji(existing?.icon && !/^[a-z0-9-]+$/.test(existing.icon) ? existing.icon : "");
    setTreatment("expense");
    setMoveTo("");
    setConfirmDelete(false);
    setError("");
  }, [existing?.id, drawer?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const title =
    drawer?.mode === "new" ? `Add a category to ${drawer.group.name}`
    : drawer?.mode === "new-group" ? "New group"
    : drawer?.mode === "edit-group" ? "Edit group"
    : "Edit category";

  async function handleSave() {
    if (!drawer) return;
    if (!name.trim()) {
      setError(isGroup ? "Enter a name for the group." : "Enter a name for the category.");
      return;
    }
    setError("");
    try {
      // An empty emoji is filled in from the name by the server.
      const icon = emoji || undefined;
      if (drawer.mode === "new") {
        await create.mutateAsync({ name: name.trim(), parent_id: drawer.group.id, icon });
      } else if (drawer.mode === "new-group") {
        await create.mutateAsync({ name: name.trim(), is_group: true, treatment, icon });
      } else if (existing) {
        await update.mutateAsync({ id: existing.id, name: name.trim(), ...(icon ? { icon } : {}) });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDelete() {
    if (!existing) return;
    setError("");
    try {
      await remove.mutateAsync(existing.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const otherGroups = existing && !isGroup ? groups.filter((g) => g.id !== existing.parent_id) : [];
  const label = "text-xs font-medium text-muted-foreground uppercase tracking-wide";

  return (
    <SideDrawer open={drawer !== null} onClose={onClose} title={title}>
      <div className="flex flex-col gap-5 px-5 py-5">
        <div className="space-y-1.5">
          <label className={label}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isGroup ? "e.g. Health" : "e.g. Coffee Shops"}
            autoFocus
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
          />
        </div>

        {drawer?.mode === "new-group" && (
          <div className="space-y-1.5">
            <label className={label}>Counts as</label>
            <SegmentedToggle
              fill
              value={treatment}
              onChange={setTreatment}
              options={[
                { value: "income", label: "Income" },
                { value: "expense", label: "Expense" },
                { value: "transfer", label: "Transfer" },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {treatment === "income" && "Money coming in. Its categories count as income."}
              {treatment === "expense" && "Money going out. Its categories count as spending and can be budgeted."}
              {treatment === "transfer" && "Money moving between your own accounts. Left out of income and spending."}
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <label className={label}>Emoji</label>
          <div><EmojiPicker value={emoji} onChange={setEmoji} clearable={isNew} suggested={suggested} /></div>
          {isNew && !emoji && <p className="text-xs text-muted-foreground">Leave it empty and Paiso picks one from the name.</p>}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button onClick={handleSave} disabled={create.isPending || update.isPending}
          loading={create.isPending || update.isPending} className="w-full">
          {isNew ? (isGroup ? "Create group" : "Add category") : "Save changes"}
        </Button>

        {existing && !isGroup && otherGroups.length > 0 && (
          <>
            <hr className="border-border" />
            <div className="space-y-1.5">
              <label className={label}>Move to group</label>
              <div className="flex gap-2">
                <select
                  value={moveTo}
                  onChange={(e) => setMoveTo(e.target.value ? Number(e.target.value) : "")}
                  aria-label="Move to group"
                  className="flex-1 rounded-md border border-border bg-background px-2 py-2 text-sm"
                >
                  <option value="">Choose a group</option>
                  {otherGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <Button variant="outline" disabled={moveTo === ""}
                  onClick={() => { const g = groups.find((x) => x.id === moveTo); if (g) onMove(existing, g); }}>
                  Move
                </Button>
              </div>
            </div>
          </>
        )}

        {existing && (
          <>
            <hr className="border-border" />
            {confirmDelete ? (
              <div className="space-y-2">
                <p className="text-xs text-destructive text-center">
                  {isGroup
                    ? `Delete the group "${existing.name}"?`
                    : `Delete "${existing.name}"? Transactions in it become uncategorized.`}
                </p>
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" className="flex-1" onClick={handleDelete} loading={remove.isPending}>
                    <AlertTriangle size={13} />
                    Confirm delete
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : childCount > 0 ? (
              <p className="text-xs text-muted-foreground text-center">
                To delete this group, move or delete its {childCount} categor{childCount === 1 ? "y" : "ies"} first.
              </p>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center justify-center gap-2 w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:border-destructive hover:text-destructive hover:bg-destructive/5 transition-colors"
              >
                <AlertTriangle size={14} />
                {isGroup ? "Delete group" : "Delete category"}
              </button>
            )}
          </>
        )}
      </div>
    </SideDrawer>
  );
}

// ── Maintenance actions (re-categorize + reset) ───────────────────────────────

function CategoryActions() {
  const recategorize = useRecategorize();
  const [recatMsg, setRecatMsg] = useState("");

  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState("");

  async function handleRecategorize() {
    setRecatMsg("");
    try {
      const res = await recategorize.mutateAsync();
      setRecatMsg(`Re-categorized ${res.updated} transaction${res.updated === 1 ? "" : "s"}.`);
    } catch (e) {
      setRecatMsg((e as Error).message);
    }
  }

  async function handleReset() {
    if (!confirm("This will reset your categories to the defaults. Categories with no transactions will be removed and new defaults added. Continue?")) return;
    setResetting(true);
    setResetMsg("");
    try {
      await api.post("/categories/reset-to-defaults", {});
      setResetMsg("Categories reset successfully. Reload to see the changes.");
    } catch (e) {
      setResetMsg((e as Error).message);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h3 className="font-medium">Auto-categorize</h3>
        <p className="text-sm text-muted-foreground">
          Re-run categorization over transactions that are uncategorized or in a generic Other bucket.
          Paiso leaves the transactions you already categorized as they are.
        </p>
        {recatMsg && <p className="text-sm text-muted-foreground">{recatMsg}</p>}
        <Button variant="outline" size="sm" onClick={handleRecategorize} loading={recategorize.isPending}>
          <RefreshCw size={14} />
          Re-categorize transactions
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h3 className="font-medium">Reset</h3>
        <p className="text-sm text-muted-foreground">
          Reset your transaction categories to the current defaults. Categories linked to existing
          transactions are preserved.
        </p>
        {resetMsg && <p className="text-sm text-muted-foreground">{resetMsg}</p>}
        <Button variant="outline" size="sm" onClick={handleReset} loading={resetting}>
          Reset categories to defaults
        </Button>
      </div>
    </div>
  );
}
