export type BudgetKind = 'income' | 'expense' | 'saving' | 'funding';
export const budgetKindLabels: Record<BudgetKind, string> = { income: 'Ingresos', expense: 'Gastos', saving: 'Ahorro y reservas', funding: 'Remanentes' };
export type BudgetLine = { id: string; name: string; kind: BudgetKind; group: string; note: string; position: number; version: number };
export type BudgetCell = { lineId: string; period: string; originalCents: number | null; plannedCents: number | null; actualCents: number; version: number; carryoverCents?: number };
export const availableBudget = (cell: BudgetCell) => (cell.plannedCents ?? 0) + (cell.carryoverCents ?? 0);
export type BudgetCarryover = { lineId: string; sourcePeriod: string | null; targetPeriod: string; amountCents: number };
export type BudgetClosing = { period: string; nextPeriod: string; closedAt: string };
export type BudgetClosePreview = {
  period: string; nextPeriod: string; fingerprint: string; closed: boolean; unassignedCount: number; fundingAdjustmentCents: number;
  rows: { lineId: string; name: string; goalCents: number; carryoverCents: number; actualCents: number; remainingCents: number; nextGoalCents: number; nextOpeningCents: number; nextAvailableCents: number }[];
};
export type BudgetMonth = { period: string; incomeCents: number; fundingCents: number; expenseCents: number; savingCents: number; actualIncomeCents: number; actualOutCents: number; unassignedCount: number; unassignedInCents: number; unassignedOutCents: number; sourceOutCents: number | null };
export type BudgetData = { year: number; periods: string[]; lines: BudgetLine[]; cells: BudgetCell[]; months: BudgetMonth[]; carryovers?: BudgetCarryover[]; closings?: BudgetClosing[]; payrollLineId?: string };
export type BudgetMovement = { id: string; date: string; description: string; accountName: string; amountCents: number; bankCategory: string; lineId: string | null; excluded: boolean; version: number; budgetPeriod: string };
export type BudgetHistory = { id: string; lineName: string; period: string | null; beforeCents: number | null; afterCents: number | null; action: string; at: string };
