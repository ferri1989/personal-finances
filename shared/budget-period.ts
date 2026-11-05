/**
 * Mes de presupuesto de cada movimiento.
 *
 * La nómina principal llega a final de mes y paga el mes siguiente. Por eso, desde el día en que
 * entra (si llega a partir del día PAYROLL_FROM_DAY), ella y todos los ingresos posteriores de ese
 * mes cuentan para el mes siguiente. Los gastos siempre cuentan en su mes natural.
 */
export const PAYROLL_FROM_DAY = 15;
export const DEFAULT_PAYROLL_LINE = 'ingreso-jordi';

export const nextPeriod = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

export type PeriodMovement = { id: string; date: string; amountCents: number; lineId: string | null; excluded: boolean; lineKind: string | null };

/** Devuelve, por mes natural, la fecha en que entró la nómina que abre el mes siguiente. */
export function payrollAnchors(rows: PeriodMovement[], payrollLineId: string) {
  const anchors = new Map<string, string>();
  for (const row of rows) {
    if (row.lineId !== payrollLineId || row.excluded || row.amountCents <= 0) continue;
    if (Number(row.date.slice(8, 10)) < PAYROLL_FROM_DAY) continue;
    const month = row.date.slice(0, 7);
    const current = anchors.get(month);
    if (!current || row.date < current) anchors.set(month, row.date);
  }
  return anchors;
}

/** Un ingreso (asignado a una partida de ingresos, o aún sin asignar) a partir de la nómina pasa al mes siguiente. */
export function budgetPeriodOf(row: PeriodMovement, anchors: Map<string, string>) {
  const month = row.date.slice(0, 7);
  const anchor = anchors.get(month);
  const isIncome = row.amountCents > 0 && !row.excluded && (row.lineKind === 'income' || row.lineId === null);
  return anchor && isIncome && row.date >= anchor ? nextPeriod(month) : month;
}
