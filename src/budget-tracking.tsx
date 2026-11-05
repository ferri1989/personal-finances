import { Pencil, Search, X } from 'lucide-react';
import { useState } from 'react';
import { formatEuros } from '../shared/accounts';
import { budgetKindLabels, type BudgetKind } from '../shared/budget';
import { budgetRowStatus, type BudgetRow } from '../shared/budget-view';

export function BudgetTracking({rows,query,onQuery,group,onGroup,status,onStatus,showEmpty,onShowEmpty,onEditPlan,onEditLine,onMovements}: {
  rows:BudgetRow[];query:string;onQuery:(value:string)=>void;group:string;onGroup:(value:string)=>void;
  status:string;onStatus:(value:string)=>void;showEmpty:boolean;onShowEmpty:(value:boolean)=>void;
  onEditPlan:(row:BudgetRow)=>void;onEditLine:(row:BudgetRow)=>void;onMovements:(row:BudgetRow)=>void;
}) {
  const [showResources,setShowResources]=useState(false);
  const groups=[...new Set(rows.map(row=>row.group))].sort((a,b)=>a.localeCompare(b,'es'));
  const visible=rows.filter(row=>{
    if(!showResources&&(row.kind==='income'||row.kind==='funding')&&group==='all'&&query.trim()==='')return false;
    if(!showEmpty&&row.plannedCents===0&&row.actualCents===0)return false;
    if(group!=='all'&&row.group!==group)return false;
    if(!`${row.name} ${row.group}`.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es')))return false;
    if(status==='over'&&(!(row.kind==='expense'||row.kind==='saving')||row.actualCents<=row.plannedCents))return false;
    if(status==='pending'&&(row.remainingCents===null||row.remainingCents<=0))return false;
    if(status==='done'&&(row.kind==='funding'||row.actualCents===0||row.remainingCents!==0))return false;
    return true;
  });
  const filtered=query!==''||group!=='all'||status!=='all';
  return <section className="tracking-panel" aria-label="Seguimiento por partida">
    <div className="tracking-heading"><div><h2>Así va cada partida</h2><p>El presupuesto se mantiene. El real aumenta con tus movimientos y el restante se calcula solo.</p></div><div className="tracking-heading-actions"><span>{visible.length} {visible.length===1?'partida':'partidas'}</span><button className="text-button" aria-expanded={showResources} onClick={()=>setShowResources(value=>!value)}>{showResources?'Ocultar ingresos':'Ver ingresos y remanentes'}</button></div></div>
    <div className="tracking-filters"><div className="tracking-search"><Search size={17}/><input aria-label="Buscar partida" placeholder="Buscar una partida…" value={query} onChange={e=>onQuery(e.target.value)}/></div><select aria-label="Grupo de partidas" value={group} onChange={e=>onGroup(e.target.value)}><option value="all">Todos los grupos</option>{groups.map(value=><option key={value}>{value}</option>)}</select><select aria-label="Estado de partidas" value={status} onChange={e=>onStatus(e.target.value)}><option value="all">Todas las partidas</option><option value="pending">Con importe pendiente</option><option value="over">Presupuesto excedido</option><option value="done">Completadas</option></select>{filtered&&<button className="text-button" onClick={()=>{onQuery('');onGroup('all');onStatus('all');}}><X size={13}/> Quitar filtros</button>}</div>
    <div className="tracking-table-scroll"><table className="tracking-table"><thead><tr><th>Partida</th><th className="align-right">Presupuesto</th><th className="align-right">Real</th><th className="align-right">Queda</th><th>Cómo va</th></tr></thead>{(['income','funding','expense','saving'] as BudgetKind[]).map(kind=>{
      const section=visible.filter(row=>row.kind===kind);if(!section.length)return null;
      const plan=section.reduce((sum,row)=>sum+row.plannedCents,0),actual=section.reduce((sum,row)=>sum+row.actualCents,0);
      return <tbody key={kind} className="tracking-group"><tr className={`tracking-section ${kind}`}><th colSpan={5}>{budgetKindLabels[kind]}<small>{kind==='income'?'Real = recibido · Queda = por recibir':kind==='funding'?'Financiación prevista, incluida en el cierre del plan':kind==='saving'?'Real = aportado · Queda = por aportar':'Real = gastado · Queda = disponible en la partida'}</small></th></tr>{section.map(row=>{
        const state=budgetRowStatus(row);
        const percent=row.plannedCents>0?Math.round(row.actualCents/row.plannedCents*100):0;
        const remaining=row.remainingCents;
        return <tr key={row.id} className={`tracking-row ${state.tone}`}><th><div className="tracking-name"><span>{row.name}<small>{row.group}</small></span><button className="icon-button" aria-label={`Editar partida ${row.name}`} title={row.note||'Editar partida'} onClick={()=>onEditLine(row)}><Pencil size={13}/></button></div></th><td className="align-right"><button className="tracking-money plan-money" aria-label={`Editar presupuesto de ${row.name}`} onClick={()=>onEditPlan(row)}>{row.hasPlan?formatEuros(row.plannedCents):'—'}<Pencil size={11}/></button></td><td className="align-right">{kind==='funding'?<span className="muted-money">—</span>:<button className="tracking-money actual-money" aria-label={`Ver movimientos de ${row.name}`} onClick={()=>onMovements(row)}>{formatEuros(row.actualCents)}</button>}</td><td className="align-right"><strong className={`remaining-money ${remaining!==null&&remaining<0&&kind!=='income'?'over':remaining===0?'complete':''}`}>{remaining===null?'—':formatEuros(remaining)}</strong></td><td className="tracking-progress-cell"><div className="tracking-status"><span>{state.label}</span>{row.plannedCents>0&&kind!=='funding'&&row.actualCents!==0&&<small>{percent}%</small>}</div>{kind!=='funding'&&<div className={`tracking-progress ${state.tone}`} role="progressbar" aria-label={`Progreso de ${row.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.percent)} aria-valuetext={`${state.label}${row.plannedCents>0?` · ${percent}%`:''}`}><span style={{width:`${state.percent}%`}}/></div>}</td></tr>;
      })}<tr className="tracking-subtotal"><th>{filtered?'Subtotal visible':'Total'} {budgetKindLabels[kind].toLocaleLowerCase('es')}</th><td className="align-right">{formatEuros(plan)}</td><td className="align-right">{kind==='funding'?'—':formatEuros(actual)}</td><td className="align-right">{kind==='funding'?'—':formatEuros(plan-actual)}</td><td/></tr></tbody>;
    })}</table>{visible.length===0&&<div className="tracking-no-results"><Search size={25}/><h3>No hay partidas con estos filtros</h3><p>Puedes mostrar las partidas vacías o cambiar los filtros.</p></div>}</div>
    <div className="tracking-footer"><label><input type="checkbox" checked={showEmpty} onChange={e=>onShowEmpty(e.target.checked)}/> Mostrar partidas sin importe</label><span>Pulsa el presupuesto para ajustarlo o el real para ver sus movimientos.</span></div>
  </section>;
}
