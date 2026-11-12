import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Category } from "@/types";

const QK = "categories";

export function useCategories() {
  return useQuery<Category[]>({
    queryKey: [QK],
    queryFn: () => api.get<Category[]>("/categories"),
  });
}

/** A category's stored icon (its emoji), from the cached category list. */
export function useCategoryIcon(id: number | null | undefined): string | null {
  const { data } = useCategories();
  return id == null ? null : data?.find((c) => c.id === id)?.icon ?? null;
}

export function useCategoryTree() {
  const { data: flat = [], ...rest } = useCategories();
  const roots = flat.filter((c) => c.parent_id === null);
  // The API returns each group's categories in their saved order.
  const children = (parentId: number) => flat.filter((c) => c.parent_id === parentId);
  return { roots, children, flat, ...rest };
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      is_income?: boolean;
      parent_id?: number | null;
      icon?: string;
      color?: string;
      /** A group of the user's own, with how its categories count. */
      is_group?: boolean;
      treatment?: "income" | "expense" | "transfer";
    }) => api.post<Category>("/categories", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [QK] }),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: number;
      name?: string;
      icon?: string;
      color?: string;
    }) => api.patch<Category>(`/categories/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [QK] }),
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/categories/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [QK] }),
  });
}

/** Re-run the categorization pipeline over uncategorized / Other transactions. */
export function useRecategorize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ updated: number }>("/transactions/recategorize", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });
}

/** The order of categories inside one group, after a drag. */
export function useReorderCategories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (order: { id: number; position: number }[]) => api.put("/categories/order", order),
    onSuccess: () => qc.invalidateQueries({ queryKey: [QK] }),
  });
}

/** What moving a category would touch, for its confirm step. */
export function useCategoryImpact(id: number | null) {
  return useQuery<{ transactions: number; rules: number; budgets: string[] }>({
    queryKey: [QK, id, "impact"],
    queryFn: () => api.get(`/categories/${id}/impact`),
    enabled: id != null,
  });
}

/** Move a category to another group: as it is, merged into one there, or to Uncategorized. */
export function useMoveCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: number;
      group_id: number;
      mode: "keep" | "merge" | "uncategorize";
      merge_into_id?: number;
    }) => api.post<{ ok: boolean; category_id: number | null }>(`/categories/${id}/move`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["budget"] });
    },
  });
}
