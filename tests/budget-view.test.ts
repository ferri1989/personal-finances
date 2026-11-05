import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AccountStore} from '../server/database.js';
import {BudgetService} from '../server/budget-service.js';
import {budgetOverview,budgetRowStatus} from '../shared/budget-view.js';

test('las vistas y los gráficos usan el mismo cierre a cero y no suman ingresos al gasto',()=>{
  const store=new AccountStore(':memory:');
  try{
    const data=new BudgetService(store).year(2027);
    const overview=budgetOverview(data,data.periods);
    assert.equal(overview.incomeCents,6943200);
    assert.equal(overview.fundingCents,150000);
    assert.equal(overview.resourcesCents,7093200);
    assert.equal(overview.allocatedCents,7093200);
    assert.equal(overview.unallocatedCents,0);
    assert.equal(overview.groups.reduce((sum,group)=>sum+group.plannedCents,0),overview.allocatedCents);
    assert.equal(overview.remainingOutCents,7093200);
    assert.equal(overview.rows.find(row=>row.id==='remanente-anterior')?.remainingCents,null);
    const january=budgetOverview(data,['2027-01']);
    assert.equal(january.allocatedCents,500400);
    assert.equal(january.incomeCents,578600);
    assert.equal(january.unallocatedCents,228200);
  }finally{store.close();}
});

test('el seguimiento muestra excesos y devoluciones sin perder el signo del restante',()=>{
  const store=new AccountStore(':memory:');
  try{
    const data=new BudgetService(store).year(2027);
    data.cells.find(cell=>cell.lineId==='comida'&&cell.period==='2027-01')!.actualCents=65000;
    data.cells.find(cell=>cell.lineId==='gasolina'&&cell.period==='2027-01')!.actualCents=-1500;
    const overview=budgetOverview(data,['2027-01']);
    const food=overview.rows.find(row=>row.id==='comida')!;
    const fuel=overview.rows.find(row=>row.id==='gasolina')!;
    assert.equal(food.remainingCents,-5000);
    assert.equal(budgetRowStatus(food).tone,'over');
    assert.equal(budgetRowStatus(food).percent,100);
    assert.equal(fuel.remainingCents,21500);
    assert.equal(budgetRowStatus(fuel).label,'Devolución neta');
    assert.equal(overview.actualOutCents,63500);
    assert.equal(overview.remainingOutCents,436900);
  }finally{store.close();}
});
