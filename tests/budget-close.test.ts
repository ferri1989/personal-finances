import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../server/database.js';
import { BudgetService } from '../server/budget-service.js';
import { budgetOverview } from '../shared/budget-view.js';
import { availableBudget } from '../shared/budget.js';
import { ImportService } from '../server/import-service.js';
import { buildApp } from '../server/app.js';

function setup(path=':memory:') {
  const store=new AccountStore(path),budget=new BudgetService(store);
  for(const p of ['2025-11','2025-12','2026-01']) {
    store.db.prepare('INSERT INTO budget_periods VALUES (?,NULL)').run(p);
    store.db.prepare('INSERT INTO budget_cells (line_id,period,original_cents,planned_cents) SELECT id,?,NULL,NULL FROM budget_lines').run(p);
  }
  const set=(id:string,p:string,value:number)=>{
    const cell=budget.year(Number(p.slice(0,4))).cells.find(c=>c.lineId===id&&c.period===p)!;
    budget.updateCell({lineId:id,period:p,plannedCents:value,expectedVersion:cell.version});
  };
  set('comida','2025-11',10000);set('comida','2025-12',20000);
  set('gasolina','2025-11',1000);set('gasolina','2025-12',1000);
  set('reserva-abril','2025-11',10000);
  const april=budget.year(2025).cells.find(c=>c.lineId==='reserva-abril'&&c.period==='2025-11')!;
  budget.updateOpening(april.lineId,april.period,200000,april.version);
  const account=store.create({name:'Prueba',bank:'ING',type:'current',owner:'',lastFour:'',openingDate:'2025-11-01',openingBalanceCents:500000});
  const movement=(date:string,amount:number,lineId:string|null)=>{
    const id=randomUUID();store.db.prepare('INSERT INTO entries VALUES (?,?,?,?,?)').run(id,account.id,'movement',date,amount);
    if(lineId)budget.assign({items:[{entryId:id,expectedVersion:0}],lineId,excluded:false});return id;
  };
  return {store,budget,set,movement,account};
}

test('cierre arrastra sobrantes y déficits, cruza el año y no duplica el saldo en los totales',()=>{
  const {store,budget,movement}=setup();
  try {
    movement('2025-11-05',-2100,'reserva-abril');
    movement('2025-11-06',-2500,'gasolina');
    movement('2025-11-07',-4000,'comida');
    const preview=budget.closePreview('2025-11');
    assert.equal(preview.rows.find(r=>r.lineId==='reserva-abril')?.remainingCents,207900);
    assert.equal(preview.rows.find(r=>r.lineId==='gasolina')?.nextAvailableCents,-500);
    budget.closeMonth('2025-11',preview.fingerprint);
    assert.throws(()=>budget.closeMonth('2025-11',preview.fingerprint),{statusCode:409});
    const december=budget.year(2025).cells.find(c=>c.lineId==='comida'&&c.period==='2025-12')!;
    assert.equal(december.plannedCents,20000);assert.equal(december.carryoverCents,6000);assert.equal(availableBudget(december),26000);
    const annual=budgetOverview(budget.year(2025),['2025-11','2025-12']);
    assert.equal(annual.rows.find(r=>r.id==='reserva-abril')?.remainingCents,207900);
    assert.equal(annual.rows.find(r=>r.id==='comida')?.plannedCents,30000);
    assert.equal(annual.rows.find(r=>r.id==='comida')?.remainingCents,26000);
    assert.equal(annual.actualIncomeCents,0);
    const next=budget.closePreview('2025-12');budget.closeMonth('2025-12',next.fingerprint);
    assert.equal(budget.year(2026).cells.find(c=>c.lineId==='reserva-abril'&&c.period==='2026-01')?.carryoverCents,207900);
    assert.throws(()=>budget.reopenMonth('2025-11'),{statusCode:409});
    budget.reopenMonth('2025-12');budget.reopenMonth('2025-11');
    assert.equal(budget.year(2025).cells.find(c=>c.lineId==='comida'&&c.period==='2025-12')?.carryoverCents,0);
    const again=budget.closePreview('2025-11');budget.closeMonth('2025-11',again.fingerprint);
    assert.equal(budget.year(2025).cells.find(c=>c.lineId==='comida'&&c.period==='2025-12')?.carryoverCents,6000);
    assert.equal(store.get(store.list()[0].id).balanceCents,491400);
  } finally {store.close();}
});

test('bloquea pendientes, cambios tras la vista previa y modificaciones del mes cerrado',()=>{
  const {store,budget,set,movement}=setup();
  try {
    const pending=movement('2025-11-05',-100,null);
    assert.throws(()=>budget.closeMonth('2025-11',budget.closePreview('2025-11').fingerprint),{statusCode:409});
    budget.assign({items:[{entryId:pending,expectedVersion:0}],lineId:null,excluded:true});
    const preview=budget.closePreview('2025-11');set('comida','2025-12',30000);
    assert.throws(()=>budget.closeMonth('2025-11',preview.fingerprint),{statusCode:409});
    assert.throws(()=>budget.closeMonth('2025-12',budget.closePreview('2025-12').fingerprint),{statusCode:409});
    budget.closeMonth('2025-11',budget.closePreview('2025-11').fingerprint);
    assert.throws(()=>set('comida','2025-11',500),{statusCode:409});
    assert.throws(()=>budget.assign({items:[{entryId:pending,expectedVersion:1}],lineId:'comida',excluded:false}),{statusCode:409});
    assert.equal(store.db.prepare('SELECT excluded FROM budget_allocations WHERE entry_id=?').get(pending)?.excluded,1);
    const incoming=budget.year(2025).cells.find(c=>c.lineId==='comida'&&c.period==='2025-12')!;
    assert.throws(()=>budget.updateOpening(incoming.lineId,incoming.period,100,incoming.version),{statusCode:409});
  } finally {store.close();}
});

test('Abril se conserva como saldo inicial al reabrir la base y los cierres persisten',()=>{
  const directory=mkdtempSync(join(tmpdir(),'finance-close-'));const path=join(directory,'test.sqlite');
  let {store,budget}=setup(path);
  try {
    budget.closeMonth('2025-11',budget.closePreview('2025-11').fingerprint);
    store.close();store=new AccountStore(path);budget=new BudgetService(store);
    assert.equal(budget.year(2025).closings?.length,1);
    assert.equal(budget.year(2025).cells.find(c=>c.lineId==='reserva-abril'&&c.period==='2025-12')?.carryoverCents,210000);
    const april=budget.year(2026).cells.find(c=>c.lineId==='reserva-abril'&&c.period==='2026-12')!;
    assert.equal(april.originalCents,207900);assert.equal(april.plannedCents,0);assert.equal(april.carryoverCents,0);
    assert.equal(budget.year(2026).cells.find(c=>c.lineId==='reserva-abril'&&c.period==='2026-11')?.carryoverCents,207900);
    assert.equal(budget.history(2025).filter(h=>h.action==='month_closed').length,1);
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('la importación en un mes cerrado se revierte sin guardar cuentas, archivos ni movimientos',()=>{
  const {store,budget}=setup();
  try {
    budget.closeMonth('2025-11',budget.closePreview('2025-11').fingerprint);
    const imports=new ImportService(store);
    const doc=imports.preview(Buffer.from('Movimientos de la Cuenta;;Número de cuenta:;1465 0120 0000 00001234\n;;Titular:;Prueba\nF. VALOR;CATEGORÍA;SUBCATEGORÍA;DESCRIPCIÓN;COMENTARIO;IMPORTE (€);SALDO (€)\n01/11/2025;Compras;;Compra;;-5,00;95,00'),'ing.csv');
    const plan=imports.prepare({token:doc.token,mapping:doc.mapping,accountId:null,newAccount:{name:'Nueva',bank:'ING',type:'current',owner:'',lastFour:'1234'},startDate:'2025-11-01'});
    assert.throws(()=>imports.commit(plan.id,true),{statusCode:409});
    assert.equal(store.list().length,1);assert.equal(imports.batches().length,0);
  } finally {store.close();}
});

test('API cierra, impide duplicados, reabre y valida peticiones',async()=>{
  const {store}=setup();const app=await buildApp(store);const headers={host:'127.0.0.1:4310'};
  try {
    const preview=await app.inject({method:'POST',url:'/api/budget/close/preview',headers,payload:{period:'2025-11'}});
    assert.equal(preview.statusCode,200);
    const request={method:'POST' as const,url:'/api/budget/close',headers,payload:{period:'2025-11',fingerprint:preview.json().fingerprint}};
    assert.equal((await app.inject(request)).statusCode,200);
    assert.equal((await app.inject(request)).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:'/api/budget/reopen',headers,payload:{period:'2025-11'}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/api/budget/close/preview',headers,payload:{period:'2025-13'}})).statusCode,400);
  } finally {await app.close();}
});

test('el cambio 2026–2027 sustituye el remanente previsto y restaura su previsión al deshacer',context=>{
  context.mock.timers.enable({apis:['Date'],now:new Date('2028-01-02T12:00:00Z')});
  const store=new AccountStore(':memory:'),budget=new BudgetService(store);
  try {
    budget.closeMonth('2026-11',budget.closePreview('2026-11').fingerprint);
    assert.equal(budget.year(2026).cells.find(c=>c.lineId==='reserva-abril'&&c.period==='2026-12')?.carryoverCents,207900);
    const december=budget.closePreview('2026-12');
    assert.equal(december.fundingAdjustmentCents,-150000);
    budget.closeMonth('2026-12',december.fingerprint);
    const january=budget.year(2027).months.find(m=>m.period==='2027-01')!;
    assert.equal(january.fundingCents,december.rows.reduce((n,r)=>n+r.remainingCents,0));
    budget.reopenMonth('2026-12');
    assert.equal(budget.year(2027).months[0].fundingCents,150000);
    assert.equal(budget.year(2026).cells.find(c=>c.lineId==='reserva-abril'&&c.period==='2026-12')?.carryoverCents,207900);
  } finally {store.close();}
});

test('un mes aún en curso no se puede cerrar',context=>{
  context.mock.timers.enable({apis:['Date'],now:new Date('2026-11-05T12:00:00Z')});
  const store=new AccountStore(':memory:'),budget=new BudgetService(store);
  try {assert.throws(()=>budget.closeMonth('2026-11',budget.closePreview('2026-11').fingerprint),{statusCode:400});}
  finally {store.close();}
});
