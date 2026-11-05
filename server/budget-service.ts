import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BudgetCell, BudgetData, BudgetHistory, BudgetKind, BudgetLine, BudgetMonth, BudgetMovement } from '../shared/budget.js';
import { availableBudget, type BudgetCarryover, type BudgetClosePreview } from '../shared/budget.js';
import { localDate } from '../shared/accounts.js';
import { AccountError, AccountStore } from './database.js';
import { budgetSeed, sourceMonthlyOut } from './budget-seed.js';
import { DEFAULT_PAYROLL_LINE, budgetPeriodOf, payrollAnchors, type PeriodMovement } from '../shared/budget-period.js';

const cents = z.number().int().min(0).max(1e12).nullable();
const period = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const budgetCellSchema = z.object({ lineId: z.string().min(1).max(100), period, plannedCents: cents, expectedVersion: z.number().int().positive() }).strict();
export const budgetLineSchema = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['income','expense','saving','funding']), group: z.string().trim().min(1).max(80), note: z.string().trim().max(1500) }).strict();
export const budgetAssignmentSchema = z.object({ items: z.array(z.object({ entryId: z.uuid(), expectedVersion: z.number().int().min(0) }).strict()).min(1).max(500), lineId: z.string().min(1).max(100).nullable(), excluded: z.boolean() }).strict();
export const budgetCloseSchema = z.object({ period }).strict();
export const budgetSettingsSchema = z.object({ payrollLineId: z.string().min(1).max(100) }).strict();
export const budgetCloseCommitSchema = budgetCloseSchema.extend({ fingerprint: z.string().length(64) });

export class BudgetService {
  constructor(private store: AccountStore) { this.seed(); this.migrateApril(); }

  private migrateApril() {
    this.store.transaction(() => {
      if (this.store.db.prepare("SELECT 1 FROM app_metadata WHERE key='abril-opening-balance-v2'").get()) return;
      const cell = this.store.db.prepare("SELECT * FROM budget_cells WHERE line_id='reserva-abril' AND period='2026-12'").get();
      const opening = this.store.db.prepare("SELECT * FROM budget_carryovers WHERE line_id='reserva-abril' AND target_period='2026-12'").get();
      const untouched=cell?.planned_cents===207900&&cell.version===1;
      const previousMigration=cell?.planned_cents===0&&cell.version===2&&opening?.source_period===null&&opening?.amount_cents===207900;
      if ((untouched||previousMigration) && !this.store.db.prepare("SELECT 1 FROM budget_carryovers WHERE line_id='reserva-abril' AND target_period='2026-11'").get() && !this.store.db.prepare("SELECT 1 FROM budget_closings WHERE period IN ('2026-11','2026-12')").get()) {
        if(previousMigration) this.store.db.prepare("DELETE FROM budget_carryovers WHERE line_id='reserva-abril' AND target_period='2026-12'").run();
        this.store.db.prepare('INSERT INTO budget_carryovers VALUES (?,?,NULL,?)').run('reserva-abril','2026-11',207900);
        this.store.db.prepare("UPDATE budget_cells SET planned_cents=COALESCE(planned_cents,0),version=version+1 WHERE line_id='reserva-abril' AND period='2026-11'").run();
        if(untouched) {
        this.store.db.prepare("UPDATE budget_cells SET planned_cents=0,version=version+1 WHERE line_id='reserva-abril' AND period='2026-12'").run();
        }
        this.record('reserva-abril','2026-11','opening_balance',0,207900,{ openingBalanceCents:207900, correction:'Saldo acumulado disponible desde noviembre; no aportación nueva de diciembre' });
      }
      this.store.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run('abril-opening-balance-v2',new Date().toISOString());
    });
  }

  private record(lineId:string|null, p:string, action:string, before:number|null, after:number|null, detail:unknown) {
    this.store.db.prepare('INSERT INTO budget_history VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),lineId,p,before,after,action,JSON.stringify(detail),new Date().toISOString());
  }

  private nextPeriod(p:string) {
    const [year,month]=p.split('-').map(Number);
    if (p === '2099-12') throw new AccountError(400,'No hay un periodo siguiente disponible.');
    return month===12?`${year+1}-01`:`${year}-${String(month+1).padStart(2,'0')}`;
  }

  closePreview(p:string):BudgetClosePreview {
    const source=this.year(Number(p.slice(0,4)));
    if(!source.periods.includes(p)) throw new AccountError(404,'No hay presupuesto para ese mes.');
    const next=this.nextPeriod(p);
    const target=next.slice(0,4)===p.slice(0,4)?source:this.year(Number(next.slice(0,4)));
    const rows=source.lines.filter(line=>line.kind==='expense'||line.kind==='saving').map(line=>{
      const cell=source.cells.find(c=>c.lineId===line.id&&c.period===p);
      const nextCell=target.cells.find(c=>c.lineId===line.id&&c.period===next);
      const goalCents=cell?.plannedCents??0, carryoverCents=cell?.carryoverCents??0, actualCents=cell?.actualCents??0;
      const remainingCents=goalCents+carryoverCents-actualCents;
      const nextGoalCents=nextCell?.plannedCents??0;
      const nextOpening=target.carryovers?.find(c=>c.lineId===line.id&&c.targetPeriod===next&&c.sourcePeriod===null)?.amountCents??0;
      return {lineId:line.id,name:line.name,goalCents,carryoverCents,actualCents,remainingCents,nextGoalCents,nextOpeningCents:nextOpening,nextAvailableCents:nextGoalCents+remainingCents+nextOpening};
    });
    const unassignedCount=source.months.find(m=>m.period===p)?.unassignedCount??0;
    const closed=Boolean(source.closings?.some(c=>c.period===p));
    const oldFunding=target.cells.find(c=>c.lineId==='remanente-anterior'&&c.period===next);
    const fundingAdjustmentCents=p==='2026-12'&&oldFunding?.plannedCents===150000&&oldFunding.version===1?-150000:0;
    const fingerprint=createHash('sha256').update(JSON.stringify({p,next,rows,unassignedCount,closed,
      cells:source.cells.filter(c=>c.period===p), target:target.cells.filter(c=>c.period===next), lines:source.lines,
    })).digest('hex');
    return {period:p,nextPeriod:next,rows,unassignedCount,closed,fingerprint,fundingAdjustmentCents};
  }

  closeMonth(p:string,fingerprint:string) {
    return this.store.transaction(()=>{
      this.store.assertBudgetOpen(p);
      const preview=this.closePreview(p);
      if(preview.fingerprint!==fingerprint) throw new AccountError(409,'El presupuesto ha cambiado. Vuelve a revisar el cierre.');
      if(p>=localDate().slice(0,7)) throw new AccountError(400,'El mes debe haber terminado antes de cerrarlo.');
      if(preview.unassignedCount) throw new AccountError(409,'Asigna o excluye todos los movimientos del mes antes de cerrar.');
      if(this.store.db.prepare('SELECT 1 FROM budget_periods p WHERE p.period<? AND NOT EXISTS (SELECT 1 FROM budget_closings c WHERE c.period=p.period) LIMIT 1').get(p)) {
        throw new AccountError(409,'Cierra primero los meses anteriores para incorporar sus arrastres.');
      }
      this.store.assertBudgetOpen(preview.nextPeriod);
      this.store.db.prepare('INSERT OR IGNORE INTO budget_periods VALUES (?,NULL)').run(preview.nextPeriod);
      this.store.db.prepare('INSERT OR IGNORE INTO budget_cells (line_id,period,original_cents,planned_cents) SELECT id,?,NULL,NULL FROM budget_lines').run(preview.nextPeriod);
      for(const row of preview.rows) {
        if(Math.abs(row.nextAvailableCents)>1e12) throw new AccountError(400,'El arrastre supera el importe máximo permitido.');
        const existing=this.store.db.prepare('SELECT * FROM budget_carryovers WHERE line_id=? AND target_period=?').get(row.lineId,preview.nextPeriod);
        if(existing) {
          if(existing.source_period===null && row.remainingCents===0) continue;
          throw new AccountError(409,`${row.name} ya tiene un saldo inicial o arrastre en el mes siguiente. Revisa su saldo inicial antes de cerrar para no duplicarlo.`);
        }
        this.store.db.prepare('INSERT INTO budget_carryovers VALUES (?,?,?,?)').run(row.lineId,preview.nextPeriod,p,row.remainingCents);
      }
      if(preview.fundingAdjustmentCents) this.store.db.prepare('INSERT INTO budget_carryovers VALUES (?,?,?,?)').run('remanente-anterior',preview.nextPeriod,p,preview.fundingAdjustmentCents);
      this.store.db.prepare('INSERT INTO budget_closings VALUES (?,?,?)').run(p,preview.nextPeriod,new Date().toISOString());
      this.record(null,p,'month_closed',null,null,preview);
      return {closed:true};
    });
  }

  reopenMonth(p:string) {
    return this.store.transaction(()=>{
      const closed=this.store.db.prepare('SELECT * FROM budget_closings WHERE period=?').get(p);
      if(!closed) throw new AccountError(409,'Este mes ya está abierto.');
      this.store.assertBudgetOpen(String(closed.next_period));
      this.store.db.prepare('DELETE FROM budget_carryovers WHERE source_period=?').run(p);
      this.store.db.prepare('DELETE FROM budget_closings WHERE period=?').run(p);
      this.record(null,p,'month_reopened',null,null,{});
      return {closed:false};
    });
  }

  updateOpening(lineId:string,p:string,amountCents:number,expectedVersion:number) {
    return this.store.transaction(()=>{
      this.store.assertBudgetOpen(p);
      const line=this.lines().find(l=>l.id===lineId);
      if(!line||!['expense','saving'].includes(line.kind)) throw new AccountError(400,'Solo los gastos y el ahorro admiten saldo inicial.');
      const cell=this.store.db.prepare('SELECT * FROM budget_cells WHERE line_id=? AND period=?').get(lineId,p);
      if(!cell||cell.version!==expectedVersion) throw new AccountError(409,'El presupuesto ha cambiado. Actualiza antes de guardar.');
      const previous=this.store.db.prepare('SELECT * FROM budget_carryovers WHERE line_id=? AND target_period=?').get(lineId,p);
      if(previous?.source_period!=null) throw new AccountError(409,'Este saldo procede de un cierre. Deshaz el cierre de origen para corregirlo.');
      if(this.store.db.prepare('SELECT 1 FROM budget_cells WHERE line_id=? AND period<? AND (COALESCE(planned_cents,0)<>0 OR EXISTS (SELECT 1 FROM budget_carryovers r WHERE r.line_id=? AND r.target_period<? AND r.amount_cents<>0)) LIMIT 1').get(lineId,p,lineId,p)) {
        throw new AccountError(409,'Esta partida tiene saldo o previsiones anteriores. Usa el cierre del mes anterior para arrastrarlas.');
      }
      if(amountCents===0) this.store.db.prepare('DELETE FROM budget_carryovers WHERE line_id=? AND target_period=?').run(lineId,p);
      else this.store.db.prepare('INSERT INTO budget_carryovers VALUES (?,?,NULL,?) ON CONFLICT(line_id,target_period) DO UPDATE SET amount_cents=excluded.amount_cents').run(lineId,p,amountCents);
      this.store.db.prepare('UPDATE budget_cells SET version=version+1 WHERE line_id=? AND period=?').run(lineId,p);
      this.record(lineId,p,'opening_balance',Number(previous?.amount_cents??0),amountCents,{});
      return {saved:true};
    });
  }

  private seed() {
    this.store.transaction(() => {
      if (this.store.db.prepare("SELECT 1 FROM app_metadata WHERE key = 'budget-seed-2026-2027'").get()) return;
      const periods = Object.keys(sourceMonthlyOut);
      for (const p of periods) this.store.db.prepare('INSERT OR IGNORE INTO budget_periods VALUES (?, ?)').run(p, sourceMonthlyOut[p] * 100);
      budgetSeed.forEach((line, i) => {
        this.store.db.prepare('INSERT OR IGNORE INTO budget_lines (id,name,kind,group_name,note,position) VALUES (?,?,?,?,?,?)').run(line.id,line.name,line.kind,line.group,line.note ?? '',i);
        for (const p of periods) {
          const amount = p.startsWith('2026') ? line.y26?.[Number(p.slice(5)) - 11] : line.y27?.[Number(p.slice(5)) - 1];
          const value = amount == null ? null : Math.round(amount * 100);
          this.store.db.prepare('INSERT OR IGNORE INTO budget_cells (line_id,period,original_cents,planned_cents) VALUES (?,?,?,?)').run(line.id,p,value,value);
        }
      });
      for (const p of periods) {
        const sum = Number(this.store.db.prepare("SELECT COALESCE(SUM(c.original_cents),0) AS n FROM budget_cells c JOIN budget_lines l ON l.id=c.line_id WHERE c.period=? AND l.kind IN ('expense','saving')").get(p)?.n);
        if (sum !== sourceMonthlyOut[p] * 100) throw new Error(`El presupuesto transcrito no cuadra en ${p}.`);
      }
      this.store.db.prepare('INSERT INTO budget_history VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),null,null,null,null,'seeded',JSON.stringify({ source:'Capturas noviembre/diciembre 2026 y anual 2027, con aclaraciones del usuario', months:14 }),new Date().toISOString());
      this.store.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run('budget-seed-2026-2027',new Date().toISOString());
    });
  }

  lines(): BudgetLine[] {
    return this.store.db.prepare('SELECT * FROM budget_lines ORDER BY position,id').all().map(row => ({ id:String(row.id),name:String(row.name),kind:row.kind as BudgetKind,group:String(row.group_name),note:String(row.note),position:Number(row.position),version:Number(row.version) }));
  }

  payrollLineId(): string {
    const row=this.store.db.prepare("SELECT value FROM app_metadata WHERE key='budget-payroll-line'").get();
    const id=row?String(row.value):DEFAULT_PAYROLL_LINE;
    return this.lines().some(line=>line.id===id&&line.kind==='income')?id:DEFAULT_PAYROLL_LINE;
  }

  updateSettings(input: z.infer<typeof budgetSettingsSchema>) {
    const line=this.lines().find(line=>line.id===input.payrollLineId);
    if(!line||line.kind!=='income')throw new AccountError(400,'La nómina debe ser una partida de ingresos.');
    this.store.db.prepare("INSERT INTO app_metadata VALUES ('budget-payroll-line',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(input.payrollLineId);
    return {payrollLineId:input.payrollLineId};
  }

  /** Movimientos entre dos fechas con su mes de presupuesto (la nómina de final de mes abre el siguiente). */
  private periodRows(from: string, to: string) {
    const rows=this.store.db.prepare(`SELECT e.id,e.date,e.amount_cents,b.line_id,COALESCE(b.excluded,0) AS excluded,l.kind AS line_kind
      FROM entries e LEFT JOIN budget_allocations b ON b.entry_id=e.id LEFT JOIN budget_lines l ON l.id=b.line_id
      WHERE e.kind='movement' AND e.date>=? AND e.date<?`).all(from,to).map(row=>({id:String(row.id),date:String(row.date),amountCents:Number(row.amount_cents),lineId:row.line_id===null?null:String(row.line_id),excluded:Boolean(row.excluded),lineKind:row.line_kind===null?null:String(row.line_kind)}) as PeriodMovement);
    const anchors=payrollAnchors(rows,this.payrollLineId());
    return rows.map(row=>({...row,period:budgetPeriodOf(row,anchors)}));
  }

  year(year: number): BudgetData {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year+1}-01-01`;
    // Months with actual movements stay visible even when no source budget was provided.
    const moved=this.periodRows(`${year-1}-12-01`,yearEnd).filter(row=>row.period.startsWith(`${year}-`));
    const movementPeriods=[...new Set(moved.map(row=>row.period))];
    this.store.transaction(()=>{for(const p of movementPeriods){
      this.store.db.prepare('INSERT OR IGNORE INTO budget_periods VALUES (?,NULL)').run(p);
      this.store.db.prepare('INSERT OR IGNORE INTO budget_cells (line_id,period,original_cents,planned_cents) SELECT id,?,NULL,NULL FROM budget_lines').run(p);
    }});
    const periodRows = this.store.db.prepare('SELECT * FROM budget_periods WHERE period LIKE ? ORDER BY period').all(`${year}-%`);
    const periods = periodRows.map(row => String(row.period));
    const lines = this.lines();
    const lineById = new Map(lines.map(line => [line.id,line]));
    const actual = new Map<string, number>();
    for (const row of moved) {
      if (row.excluded || !row.lineId) continue;
      const line = lineById.get(row.lineId);
      if (!line) continue;
      const key=`${line.id}:${row.period}`;
      actual.set(key,(actual.get(key)??0)+row.amountCents * (line.kind === 'income' ? 1 : -1));
    }
    const carryovers:BudgetCarryover[]=this.store.db.prepare('SELECT * FROM budget_carryovers WHERE target_period LIKE ? ORDER BY target_period,line_id').all(`${year}-%`).map(row=>({lineId:String(row.line_id),sourcePeriod:row.source_period===null?null:String(row.source_period),targetPeriod:String(row.target_period),amountCents:Number(row.amount_cents)}));
    const carryByCell=new Map(carryovers.map(c=>[`${c.lineId}:${c.targetPeriod}`,c.amountCents]));
    const cells: BudgetCell[] = this.store.db.prepare('SELECT * FROM budget_cells WHERE period LIKE ? ORDER BY period,line_id').all(`${year}-%`).map(row => ({
      lineId:String(row.line_id),period:String(row.period),originalCents:row.original_cents === null ? null : Number(row.original_cents),plannedCents:row.planned_cents === null ? null : Number(row.planned_cents),
      actualCents:actual.get(`${row.line_id}:${row.period}`) ?? 0,version:Number(row.version),
      carryoverCents:carryByCell.get(`${row.line_id}:${row.period}`)??0,
    }));
    const unassigned=new Map<string,{n:number;incoming:number;outgoing:number}>();
    for(const row of moved){
      if(row.lineId||row.excluded)continue;
      const item=unassigned.get(row.period)??{n:0,incoming:0,outgoing:0};
      item.n++;if(row.amountCents>0)item.incoming+=row.amountCents;else item.outgoing-=row.amountCents;
      unassigned.set(row.period,item);
    }
    const months: BudgetMonth[] = periodRows.map(source => {
      const p = String(source.period);
      const month: BudgetMonth = {period:p,incomeCents:0,fundingCents:0,expenseCents:0,savingCents:0,actualIncomeCents:0,actualOutCents:0,unassignedCount:0,unassignedInCents:0,unassignedOutCents:0,sourceOutCents:source.source_out_cents === null ? null : Number(source.source_out_cents)};
      for (const cell of cells.filter(cell => cell.period === p)) {
        const kind = lineById.get(cell.lineId)!.kind;
        const amount = availableBudget(cell);
        if (kind === 'income') { month.incomeCents += amount; month.actualIncomeCents += cell.actualCents; }
        if (kind === 'funding') month.fundingCents += amount;
        if (kind === 'expense') {month.expenseCents += amount;month.actualOutCents += cell.actualCents;}
        if (kind === 'saving') {month.savingCents += amount;month.actualOutCents += cell.actualCents;}
        if(kind==='expense'||kind==='saving') month.fundingCents+=cell.carryoverCents??0;
      }
      const pending = unassigned.get(p);
      if (pending) {month.unassignedCount=pending.n;month.unassignedInCents=pending.incoming;month.unassignedOutCents=pending.outgoing;}
      return month;
    });
    const closings=this.store.db.prepare('SELECT * FROM budget_closings WHERE period LIKE ? ORDER BY period').all(`${year}-%`).map(row=>({period:String(row.period),nextPeriod:String(row.next_period),closedAt:String(row.closed_at)}));
    return {year,periods,lines,cells,months,carryovers,closings,payrollLineId:this.payrollLineId()};
  }

  updateCell(input: z.infer<typeof budgetCellSchema>) {
    return this.store.transaction(() => {
      this.store.assertBudgetOpen(input.period);
      const cell = this.store.db.prepare('SELECT * FROM budget_cells WHERE line_id=? AND period=?').get(input.lineId,input.period);
      if (!cell) throw new AccountError(404,'No se encuentra esa partida en este periodo.');
      if (Number(cell.version)!==input.expectedVersion) throw new AccountError(409,'El presupuesto ha cambiado en otra pestaña. Actualiza antes de guardar.');
      this.store.db.prepare('UPDATE budget_cells SET planned_cents=?,version=version+1 WHERE line_id=? AND period=?').run(input.plannedCents,input.lineId,input.period);
      this.store.db.prepare('INSERT INTO budget_history VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),input.lineId,input.period,cell.planned_cents as number|null,input.plannedCents,'amount_changed','{}',new Date().toISOString());
      return { ...input,version:input.expectedVersion+1 };
    });
  }

  createLine(input: z.infer<typeof budgetLineSchema>) {
    return this.store.transaction(() => {
      const id=randomUUID();
      const position=Number(this.store.db.prepare('SELECT COALESCE(MAX(position),0)+1 AS n FROM budget_lines').get()?.n);
      this.store.db.prepare('INSERT INTO budget_lines (id,name,kind,group_name,note,position) VALUES (?,?,?,?,?,?)').run(id,input.name,input.kind,input.group,input.note,position);
      for(const row of this.store.db.prepare('SELECT period FROM budget_periods').all()) this.store.db.prepare('INSERT INTO budget_cells (line_id,period,original_cents,planned_cents) VALUES (?,?,NULL,NULL)').run(id,String(row.period));
      this.store.db.prepare('INSERT INTO budget_history VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),id,null,null,null,'line_created',JSON.stringify(input),new Date().toISOString());
      return this.lines().find(line=>line.id===id)!;
    });
  }

  updateLine(id:string,input:z.infer<typeof budgetLineSchema>,expectedVersion:number) {
    return this.store.transaction(()=>{
      const line=this.lines().find(line=>line.id===id);
      if(!line)throw new AccountError(404,'Partida no encontrada.');
      if(line.version!==expectedVersion)throw new AccountError(409,'La partida ha cambiado. Actualiza antes de editar.');
      if(line.kind!==input.kind && this.store.db.prepare('SELECT 1 FROM budget_closings LIMIT 1').get()) throw new AccountError(409,'Deshaz los cierres antes de cambiar el tipo de una partida.');
      if(line.kind!==input.kind && this.store.db.prepare('SELECT 1 FROM budget_allocations WHERE line_id=? LIMIT 1').get(id))throw new AccountError(409,'Esta partida ya tiene movimientos. Conserva su tipo para no alterar el histórico.');
      this.store.db.prepare('UPDATE budget_lines SET name=?,kind=?,group_name=?,note=?,version=version+1 WHERE id=?').run(input.name,input.kind,input.group,input.note,id);
      this.store.db.prepare('INSERT INTO budget_history VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),id,null,null,null,'line_changed',JSON.stringify({before:line,after:input}),new Date().toISOString());
      return this.lines().find(line=>line.id===id)!;
    });
  }

  movements(year:number):BudgetMovement[] {
    const periods=new Map(this.periodRows(`${year-1}-12-01`,`${year+1}-01-01`).map(row=>[row.id,row.period]));
    return this.store.db.prepare(`SELECT e.id,e.date,e.amount_cents,m.description,m.bank_category,a.name,b.line_id,b.excluded,b.version
      FROM entries e JOIN imported_movements m ON m.entry_id=e.id JOIN accounts a ON a.id=e.account_id
      LEFT JOIN budget_allocations b ON b.entry_id=e.id WHERE e.date>=? AND e.date<? ORDER BY e.date DESC,m.source_row ASC`).all(`${year-1}-12-01`,`${year+1}-01-01`).map(row=>({
        id:String(row.id),date:String(row.date),amountCents:Number(row.amount_cents),description:String(row.description),bankCategory:String(row.bank_category),accountName:String(row.name),
        lineId:row.line_id===null?null:String(row.line_id),excluded:Boolean(row.excluded),version:row.version===null?0:Number(row.version),
        budgetPeriod:periods.get(String(row.id))??String(row.date).slice(0,7),
      })).filter(row=>row.budgetPeriod.startsWith(`${year}-`));
  }

  assign(input:z.infer<typeof budgetAssignmentSchema>) {
    if(input.excluded && input.lineId)throw new AccountError(400,'Un traspaso excluido no puede tener partida.');
    if(new Set(input.items.map(item=>item.entryId)).size!==input.items.length)throw new AccountError(400,'Hay movimientos repetidos en la selección.');
    return this.store.transaction(()=>{
      if(input.lineId){const line=this.lines().find(line=>line.id===input.lineId);if(!line)throw new AccountError(404,'Partida no encontrada.');if(line.kind==='funding')throw new AccountError(400,'Los remanentes financian el presupuesto; no son una categoría para movimientos.');}
      for(const item of input.items){
        if(!this.store.db.prepare("SELECT 1 FROM entries WHERE id=? AND kind='movement'").get(item.entryId))throw new AccountError(404,'Movimiento no encontrado.');
        const before=this.store.db.prepare('SELECT * FROM budget_allocations WHERE entry_id=?').get(item.entryId);
        if(Number(before?.version??0)!==item.expectedVersion)throw new AccountError(409,'Algún movimiento ha cambiado. Actualiza la lista antes de asignar.');
        const now=new Date().toISOString();
        this.store.db.prepare(`INSERT INTO budget_allocations VALUES (?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET line_id=excluded.line_id,excluded=excluded.excluded,version=budget_allocations.version+1,updated_at=excluded.updated_at`).run(item.entryId,input.lineId,input.excluded?1:0,1,now);
        const date=String(this.store.db.prepare('SELECT date FROM entries WHERE id=?').get(item.entryId)!.date);
        const month=date.slice(0,7);
        const budgetPeriod=this.periodRows(`${month}-01`,`${month}-32`).find(row=>row.id===item.entryId)?.period??month;
        this.store.assertBudgetOpen(budgetPeriod);
        this.store.db.prepare('INSERT INTO budget_history VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),input.lineId,budgetPeriod,null,null,'movement_assigned',JSON.stringify({entryId:item.entryId,before:before??null,after:{lineId:input.lineId,excluded:input.excluded}}),now);
      }
      return {updated:input.items.length};
    });
  }

  history(year:number):BudgetHistory[] {
    return this.store.db.prepare(`SELECT h.*,l.name FROM budget_history h LEFT JOIN budget_lines l ON l.id=h.line_id WHERE h.period LIKE ? OR h.period IS NULL ORDER BY h.created_at DESC,h.rowid DESC LIMIT 100`).all(`${year}-%`).map(row=>({id:String(row.id),lineName:String(row.name??'Presupuesto inicial'),period:row.period===null?null:String(row.period),beforeCents:row.before_cents===null?null:Number(row.before_cents),afterCents:row.after_cents===null?null:Number(row.after_cents),action:String(row.action),at:String(row.created_at)}));
  }
}
