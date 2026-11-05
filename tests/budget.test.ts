import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountStore} from '../server/database.js';
import {BudgetService} from '../server/budget-service.js';
import {buildApp} from '../server/app.js';
import {sourceMonthlyOut} from '../server/budget-seed.js';

function addMovement(store:AccountStore,accountId:string,date:string,amount:number){const id=randomUUID();store.db.prepare('INSERT INTO entries VALUES (?,?,?,?,?)').run(id,accountId,'movement',date,amount);return id;}
const createAccount=(store:AccountStore)=>store.create({name:'Prueba',bank:'ING',type:'current',owner:'',lastFour:'',openingDate:'2026-10-31',openingBalanceCents:500000});

test('las 14 mensualidades cuadran exactamente con las capturas y las aclaraciones',()=>{
  const store=new AccountStore(':memory:');try{const budget=new BudgetService(store);const data26=budget.year(2026);const data27=budget.year(2027);
    assert.equal(data26.periods.length+data27.periods.length,14);
    for(const data of [data26,data27])for(const p of data.periods){const ids=new Set(data.lines.filter(l=>l.kind==='expense'||l.kind==='saving').map(l=>l.id));assert.equal(data.cells.filter(c=>c.period===p&&ids.has(c.lineId)).reduce((s,c)=>s+(c.originalCents??0),0),sourceMonthlyOut[p]*100,p);}
    assert.equal(data27.months.every(m=>m.incomeCents===578600),true);
    assert.equal(data27.months[0].fundingCents,150000);
    assert.equal(data27.months.reduce((sum,m)=>sum+m.incomeCents+m.fundingCents-m.expenseCents-m.savingCents,0),0,'2027 queda a cero con el remanente anterior');
    assert.equal(data27.months.reduce((s,m)=>s+m.actualIncomeCents,0),0,'el remanente no crea ingresos reales');
    assert.equal(data26.cells.find(c=>c.lineId==='reparaciones-coche'&&c.period==='2026-12')?.plannedCents,36600);
    const april=data26.cells.find(c=>c.lineId==='reserva-abril'&&c.period==='2026-12')!;
    assert.equal(april.plannedCents,0);
    assert.equal(april.carryoverCents,0);
    assert.equal(data26.cells.find(c=>c.lineId==='reserva-abril'&&c.period==='2026-11')?.carryoverCents,207900);
    assert.equal(april.originalCents,207900);
    assert.equal(data27.cells.find(c=>c.lineId==='pensiones'&&c.period==='2027-12')?.plannedCents,150000);
  }finally{store.close();}
});

test('editar el plan conserva el original y persiste al reabrir sin volver a sembrar',()=>{
  const directory=mkdtempSync(join(tmpdir(),'budget-test-'));let store=new AccountStore(join(directory,'data.sqlite'));
  try{let budget=new BudgetService(store);const cell=budget.year(2027).cells.find(c=>c.lineId==='comida'&&c.period==='2027-01')!;
    budget.updateCell({lineId:cell.lineId,period:cell.period,plannedCents:65000,expectedVersion:cell.version});
    assert.throws(()=>budget.updateCell({lineId:cell.lineId,period:cell.period,plannedCents:0,expectedVersion:cell.version}),{statusCode:409});
    store.close();store=new AccountStore(join(directory,'data.sqlite'));budget=new BudgetService(store);
    const saved=budget.year(2027).cells.find(c=>c.lineId===cell.lineId&&c.period===cell.period)!;
    assert.equal(saved.plannedCents,65000);assert.equal(saved.originalCents,60000);assert.equal(saved.version,2);
    assert.equal(budget.history(2027).filter(item=>item.action==='seeded').length,1);
    assert.equal(budget.history(2027)[0].beforeCents,60000);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('el real respeta el mes, compensa devoluciones y excluye traspasos y aperturas',()=>{
  const store=new AccountStore(':memory:');try{const budget=new BudgetService(store);const a=createAccount(store);
    const salary=addMovement(store,a.id,'2026-11-01',100000),purchase=addMovement(store,a.id,'2026-11-02',-10000),refund=addMovement(store,a.id,'2026-11-03',2000),transfer=addMovement(store,a.id,'2026-11-04',-20000),dec=addMovement(store,a.id,'2026-12-01',-5000);
    budget.assign({items:[{entryId:salary,expectedVersion:0}],lineId:'ingreso-jordi',excluded:false});
    budget.assign({items:[{entryId:purchase,expectedVersion:0},{entryId:refund,expectedVersion:0}],lineId:'comida',excluded:false});
    budget.assign({items:[{entryId:transfer,expectedVersion:0}],lineId:null,excluded:true});
    let result=budget.year(2026);
    assert.equal(result.months[0].actualIncomeCents,100000);assert.equal(result.months[0].actualOutCents,8000);assert.equal(result.months[0].unassignedCount,0);
    assert.equal(result.months[1].actualOutCents,0);assert.equal(result.months[1].unassignedCount,1);
    budget.assign({items:[{entryId:dec,expectedVersion:0}],lineId:'comida',excluded:false});
    result=budget.year(2026);assert.equal(result.months[1].actualOutCents,5000);
    assert.throws(()=>budget.assign({items:[{entryId:salary,expectedVersion:1}],lineId:'remanente-anterior',excluded:false}),{statusCode:400});
    assert.throws(()=>budget.updateLine('comida',{name:'Comida',kind:'income',group:'Prueba',note:''},1),{statusCode:409});
  }finally{store.close();}
});

test('la asignación masiva es atómica ante versiones desactualizadas',()=>{
  const store=new AccountStore(':memory:');try{const budget=new BudgetService(store);const a=createAccount(store);const first=addMovement(store,a.id,'2026-11-01',-1000),second=addMovement(store,a.id,'2026-11-02',-2000);
    budget.assign({items:[{entryId:second,expectedVersion:0}],lineId:'comida',excluded:false});
    assert.throws(()=>budget.assign({items:[{entryId:first,expectedVersion:0},{entryId:second,expectedVersion:0}],lineId:'gasolina',excluded:false}),{statusCode:409});
    assert.equal(store.db.prepare('SELECT 1 FROM budget_allocations WHERE entry_id=?').get(first),undefined);
    assert.equal(store.db.prepare('SELECT line_id FROM budget_allocations WHERE entry_id=?').get(second)?.line_id,'comida');
  }finally{store.close();}
});

test('los meses con movimientos sin presupuesto no desaparecen',()=>{
  const store=new AccountStore(':memory:');try{const budget=new BudgetService(store);const a=createAccount(store);addMovement(store,a.id,'2026-10-31',-1000);
    const result=budget.year(2026);assert.equal(result.periods[0],'2026-10');assert.equal(result.months[0].unassignedCount,1);assert.equal(result.months[0].sourceOutCents,null);
  }finally{store.close();}
});

test('API guarda cambios en varias mensualidades sin alterar originales y valida importes',async()=>{
  const store=new AccountStore(':memory:');const app=await buildApp(store);const headers={host:'127.0.0.1:4310'};
  try{const first=(await app.inject({method:'GET',url:'/api/budget/2027',headers})).json();
    const cells=first.cells.filter((c:{lineId:string;period:string})=>c.lineId==='comida'&&['2027-01','2027-02'].includes(c.period));
    const result=await app.inject({method:'PUT',url:'/api/budget/cells/bulk',headers,payload:cells.map((c:{lineId:string;period:string;version:number})=>({lineId:c.lineId,period:c.period,plannedCents:70000,expectedVersion:c.version}))});assert.equal(result.statusCode,200);
    const saved=(await app.inject({method:'GET',url:'/api/budget/2027',headers})).json();for(const period of ['2027-01','2027-02']){const c=saved.cells.find((c:{lineId:string;period:string})=>c.lineId==='comida'&&c.period===period);assert.equal(c.plannedCents,70000);assert.equal(c.originalCents,60000);}
    assert.equal((await app.inject({method:'PUT',url:'/api/budget/cells',headers,payload:{lineId:'comida',period:'2027-01',plannedCents:-1,expectedVersion:2}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/api/budget/lines',headers,payload:{name:'Nueva previsión',kind:'expense',group:'Prueba',note:''}})).statusCode,201);
  }finally{await app.close();}
});

test('la nómina de final de mes y los ingresos posteriores cuentan para el mes siguiente',()=>{
  const store=new AccountStore(':memory:');try{const budget=new BudgetService(store);const a=createAccount(store);
    const early=addMovement(store,a.id,'2026-11-10',30000),payroll=addMovement(store,a.id,'2026-11-27',436900),after=addMovement(store,a.id,'2026-11-28',46400),spend=addMovement(store,a.id,'2026-11-29',-5000),pending=addMovement(store,a.id,'2026-11-30',1000),decPayroll=addMovement(store,a.id,'2026-12-28',460000);
    budget.assign({items:[{entryId:early,expectedVersion:0},{entryId:after,expectedVersion:0}],lineId:'devolucion-madre',excluded:false});
    budget.assign({items:[{entryId:spend,expectedVersion:0}],lineId:'comida',excluded:false});
    // Antes de identificar la nómina, todo cuenta en su mes natural.
    let nov=budget.year(2026).months.find(m=>m.period==='2026-11')!;
    assert.equal(nov.actualIncomeCents,76400);assert.equal(nov.unassignedCount,2);
    budget.assign({items:[{entryId:payroll,expectedVersion:0},{entryId:decPayroll,expectedVersion:0}],lineId:'ingreso-jordi',excluded:false});
    const y26=budget.year(2026);nov=y26.months.find(m=>m.period==='2026-11')!;const dec=y26.months.find(m=>m.period==='2026-12')!;
    assert.equal(nov.actualIncomeCents,30000,'solo el ingreso anterior a la nómina queda en noviembre');
    assert.equal(nov.actualOutCents,5000,'los gastos siguen en su mes');
    assert.equal(dec.actualIncomeCents,436900+46400,'nómina e ingresos posteriores pasan a diciembre');
    assert.equal(nov.unassignedCount,0);assert.equal(dec.unassignedCount,1,'un ingreso sin asignar posterior a la nómina también pasa');
    const jan=budget.year(2027).months.find(m=>m.period==='2027-01')!;
    assert.equal(jan.actualIncomeCents,460000,'la nómina de diciembre abre enero del año siguiente');
    assert.ok(!budget.year(2026).cells.some(c=>c.lineId==='ingreso-jordi'&&c.period==='2026-12'&&c.actualCents===436900+460000));
    void pending;
  }finally{store.close();}
});

test('la nómina que entra antes del día 15 no mueve ingresos',()=>{
  const store=new AccountStore(':memory:');try{const budget=new BudgetService(store);const a=createAccount(store);
    const payroll=addMovement(store,a.id,'2026-11-02',436900);
    budget.assign({items:[{entryId:payroll,expectedVersion:0}],lineId:'ingreso-jordi',excluded:false});
    assert.equal(budget.year(2026).months.find(m=>m.period==='2026-11')!.actualIncomeCents,436900);
    assert.throws(()=>budget.updateSettings({payrollLineId:'comida'}),{statusCode:400});
    budget.updateSettings({payrollLineId:'ingreso-mj'});assert.equal(budget.year(2026).payrollLineId,'ingreso-mj');
  }finally{store.close();}
});
