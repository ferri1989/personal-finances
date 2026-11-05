import { budgetKindLabels, type BudgetKind, type BudgetLine } from '../shared/budget';

export function AssignmentOptions({lines}:{lines:BudgetLine[]}){return <><option value="__pending">Sin asignar</option><option value="__excluded">Traspaso interno / Excluir</option>{(['income','expense','saving'] as BudgetKind[]).map(kind=><optgroup label={budgetKindLabels[kind]} key={kind}>{lines.filter(line=>line.kind===kind).map(line=><option value={line.id} key={line.id}>{line.name}</option>)}</optgroup>)}</>;}
