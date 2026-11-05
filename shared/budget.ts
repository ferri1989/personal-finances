export type BudgetKind = 'income' | 'expense' | 'saving' | 'funding';
export const budgetKindLabels: Record<BudgetKind, string> = { income: 'Ingresos', expense: 'Gastos', saving: 'Ahorro y reservas', funding: 'Remanentes' };
export type BudgetLine = { id: string; name: string; kind: BudgetKind; group: string; note: string; position: number; version: number };
export type BudgetCell = { lineId: string; period: string; originalCents: number | null; plannedCents: number | null; actualCents: number; version: number };
export type BudgetMonth = { period: string; incomeCents: number; fundingCents: number; expenseCents: number; savingCents: number; actualIncomeCents: number; actualOutCents: number; unassignedCount: number; unassignedInCents: number; unassignedOutCents: number; sourceOutCents: number | null };
export type BudgetData = { year: number; periods: string[]; lines: BudgetLine[]; cells: BudgetCell[]; months: BudgetMonth[] };
export type BudgetMovement = { id: string; date: string; description: string; accountName: string; amountCents: number; bankCategory: string; lineId: string | null; excluded: boolean; version: number };
export type BudgetHistory = { id: string; lineName: string; period: string | null; beforeCents: number | null; afterCents: number | null; action: string; at: string };
