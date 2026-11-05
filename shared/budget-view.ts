import type { BudgetData, BudgetLine } from './budget.js';

export type BudgetRow = BudgetLine & {
  plannedCents: number;
  goalCents: number;
  carryoverCents: number;
  actualCents: number;
  originalCents: number;
  remainingCents: number | null;
  hasPlan: boolean;
  hasOriginal: boolean;
};

export type BudgetGroup = { name: string; plannedCents: number; actualCents: number; color: string };
const colors = ['#2d6553','#78a68c','#d1ad62','#6c8aaf','#a086b1','#c88770','#86a7a3','#adb985','#b3a595','#749655','#a2b6d2','#b28b99'];

export function budgetOverview(data: BudgetData, periods: string[]) {
  const selected = new Set(periods);
  const rows: BudgetRow[] = data.lines.map(line => {
    const cells = data.cells.filter(cell => cell.lineId === line.id && selected.has(cell.period));
    // A carry between two selected months is the same money, not a second allocation.
    const carryoverCents=(data.carryovers??[]).filter(c=>c.lineId===line.id&&selected.has(c.targetPeriod)&&(line.kind==='funding'||c.sourcePeriod===null||!selected.has(c.sourcePeriod))).reduce((sum,c)=>sum+c.amountCents,0);
    const goalCents=cells.reduce((sum,cell)=>sum+(cell.plannedCents??0),0);
    const plannedCents = goalCents+carryoverCents;
    const actualCents = cells.reduce((sum, cell) => sum + cell.actualCents, 0);
    return { ...line, plannedCents, actualCents, goalCents, carryoverCents, originalCents: cells.reduce((sum, cell) => sum + (cell.originalCents ?? 0), 0),
      remainingCents: line.kind === 'funding' ? null : plannedCents - actualCents,
      hasPlan: cells.some(cell => cell.plannedCents !== null)||carryoverCents!==0, hasOriginal: cells.some(cell => cell.originalCents !== null) };
  });
  const sum = (kind: string, field: 'plannedCents'|'actualCents') => rows.filter(row => row.kind === kind).reduce((total, row) => total + row[field], 0);
  const incomeCents = sum('income','plannedCents');
  const fundingCents = sum('funding','plannedCents')+rows.filter(row=>row.kind==='expense'||row.kind==='saving').reduce((s,row)=>s+row.carryoverCents,0);
  const expenseCents = sum('expense','plannedCents');
  const savingCents = sum('saving','plannedCents');
  const actualOutCents = sum('expense','actualCents') + sum('saving','actualCents');
  const groupsByName = new Map<string, BudgetGroup>();
  for (const row of rows.filter(row => row.kind === 'expense' || row.kind === 'saving')) {
    const group = groupsByName.get(row.group) ?? {name:row.group,plannedCents:0,actualCents:0,color:''};
    group.plannedCents += row.plannedCents;
    group.actualCents += row.actualCents;
    groupsByName.set(row.group,group);
  }
  const groups = [...groupsByName.values()].filter(group => group.plannedCents !== 0 || group.actualCents !== 0).sort((a,b) => b.plannedCents-a.plannedCents || a.name.localeCompare(b.name,'es'));
  groups.forEach((group,index) => {group.color=colors[index % colors.length];});
  const months = data.months.filter(month => selected.has(month.period));
  return {rows,groups,incomeCents,fundingCents,expenseCents,savingCents,actualOutCents,
    resourcesCents:incomeCents+fundingCents,allocatedCents:expenseCents+savingCents,
    unallocatedCents:incomeCents+fundingCents-expenseCents-savingCents,
    remainingOutCents:expenseCents+savingCents-actualOutCents,
    actualIncomeCents:sum('income','actualCents'),
    unassignedCount:months.reduce((sum,month)=>sum+month.unassignedCount,0),
    unassignedOutCents:months.reduce((sum,month)=>sum+month.unassignedOutCents,0)};
}

export function budgetRowStatus(row: BudgetRow) {
  if (row.kind === 'funding') return {label:'Financiación prevista',tone:'neutral',percent:0};
  const percent = row.plannedCents > 0 ? Math.max(0,Math.min(100,row.actualCents/row.plannedCents*100)) : row.actualCents > 0 ? 100 : 0;
  if (row.kind === 'income') return {label:row.actualCents === 0 ? 'Sin ingreso asignado' : row.actualCents >= row.plannedCents ? 'Recibido' : 'Por recibir',tone:row.actualCents>=row.plannedCents&&row.plannedCents>0?'complete':'neutral',percent};
  if (row.actualCents < 0) return {label:'Devolución neta',tone:'complete',percent:0};
  if (row.actualCents > row.plannedCents) return {label:row.plannedCents===0?'Sin presupuesto':'Excedido',tone:'over',percent};
  if (row.actualCents === 0) return {label:row.plannedCents===0?'Sin dotación':'Sin movimiento asignado',tone:'neutral',percent};
  if (row.actualCents === row.plannedCents) return {label:'Completado',tone:'complete',percent};
  return {label:row.kind==='saving'?'En curso':percent>=80?'Cerca del límite':'Dentro del presupuesto',tone:row.kind!=='saving'&&percent>=80?'warning':'good',percent};
}
