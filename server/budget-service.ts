import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BudgetCell, BudgetData, BudgetHistory, BudgetKind, BudgetLine, BudgetMonth, BudgetMovement } from '../shared/budget.js';
import { AccountError, AccountStore } from './database.js';
import { budgetSeed, sourceMonthlyOut } from './budget-seed.js';

const cents = z.number().int().min(0).max(1e12).nullable();
const period = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const budgetCellSchema = z.object({ lineId: z.string().min(1).max(100), period, plannedCents: cents, expectedVersion: z.number().int().positive() }).strict();
export const budgetLineSchema = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['income','expense','saving','funding']), group: z.string().trim().min(1).max(80), note: z.string().trim().max(1500) }).strict();
export const budgetAssignmentSchema = z.object({ items: z.array(z.object({ entryId: z.uuid(), expectedVersion: z.number().int().min(0) }).strict()).min(1).max(500), lineId: z.string().min(1).max(100).nullable(), excluded: z.boolean() }).strict();

export class BudgetService {
  constructor(private store: AccountStore) { this.seed(); }

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

  year(year: number): BudgetData {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year+1}-01-01`;
    // Months with actual movements stay visible even when no source budget was provided.
    const movementPeriods=this.store.db.prepare("SELECT DISTINCT substr(date,1,7) AS period FROM entries WHERE kind='movement' AND date>=? AND date<?").all(yearStart,yearEnd);
    this.store.transaction(()=>{for(const row of movementPeriods){
      const p=String(row.period);
      this.store.db.prepare('INSERT OR IGNORE INTO budget_periods VALUES (?,NULL)').run(p);
      this.store.db.prepare('INSERT OR IGNORE INTO budget_cells (line_id,period,original_cents,planned_cents) SELECT id,?,NULL,NULL FROM budget_lines').run(p);
    }});
    const periodRows = this.store.db.prepare('SELECT * FROM budget_periods WHERE period LIKE ? ORDER BY period').all(`${year}-%`);
    const periods = periodRows.map(row => String(row.period));
    const lines = this.lines();
    const lineById = new Map(lines.map(line => [line.id,line]));
    const actual = new Map<string, number>();
    const assigned = this.store.db.prepare(`SELECT b.line_id,substr(e.date,1,7) AS period,SUM(e.amount_cents) AS amount FROM budget_allocations b
      JOIN entries e ON e.id=b.entry_id WHERE b.excluded=0 AND b.line_id IS NOT NULL AND e.date>=? AND e.date<? GROUP BY b.line_id,substr(e.date,1,7)`).all(yearStart,yearEnd);
    for (const row of assigned) {
      const line = lineById.get(String(row.line_id));
      if (line) actual.set(`${line.id}:${row.period}`,Number(row.amount) * (line.kind === 'income' ? 1 : -1));
    }
    const cells: BudgetCell[] = this.store.db.prepare('SELECT * FROM budget_cells WHERE period LIKE ?').all(`${year}-%`).map(row => ({
      lineId:String(row.line_id),period:String(row.period),originalCents:row.original_cents === null ? null : Number(row.original_cents),plannedCents:row.planned_cents === null ? null : Number(row.planned_cents),
      actualCents:actual.get(`${row.line_id}:${row.period}`) ?? 0,version:Number(row.version),
    }));
    const unassigned = this.store.db.prepare(`SELECT substr(e.date,1,7) AS period,COUNT(*) AS n,
      SUM(CASE WHEN e.amount_cents>0 THEN e.amount_cents ELSE 0 END) AS incoming,
      SUM(CASE WHEN e.amount_cents<0 THEN -e.amount_cents ELSE 0 END) AS outgoing
      FROM entries e LEFT JOIN budget_allocations b ON b.entry_id=e.id WHERE e.kind='movement' AND e.date>=? AND e.date<?
      AND (b.entry_id IS NULL OR (b.line_id IS NULL AND b.excluded=0)) GROUP BY substr(e.date,1,7)`).all(yearStart,yearEnd);
    const months: BudgetMonth[] = periodRows.map(source => {
      const p = String(source.period);
      const month: BudgetMonth = {period:p,incomeCents:0,fundingCents:0,expenseCents:0,savingCents:0,actualIncomeCents:0,actualOutCents:0,unassignedCount:0,unassignedInCents:0,unassignedOutCents:0,sourceOutCents:source.source_out_cents === null ? null : Number(source.source_out_cents)};
      for (const cell of cells.filter(cell => cell.period === p)) {
        const kind = lineById.get(cell.lineId)!.kind;
        const amount = cell.plannedCents ?? 0;
        if (kind === 'income') { month.incomeCents += amount; month.actualIncomeCents += cell.actualCents; }
        if (kind === 'funding') month.fundingCents += amount;
        if (kind === 'expense') {month.expenseCents += amount;month.actualOutCents += cell.actualCents;}
        if (kind === 'saving') {month.savingCents += amount;month.actualOutCents += cell.actualCents;}
      }
      const pending = unassigned.find(row => row.period === p);
      if (pending) {month.unassignedCount=Number(pending.n);month.unassignedInCents=Number(pending.incoming);month.unassignedOutCents=Number(pending.outgoing);}
      return month;
    });
    return {year,periods,lines,cells,months};
  }

  updateCell(input: z.infer<typeof budgetCellSchema>) {
    return this.store.transaction(() => {
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
      if(line.kind!==input.kind && this.store.db.prepare('SELECT 1 FROM budget_allocations WHERE line_id=? LIMIT 1').get(id))throw new AccountError(409,'Esta partida ya tiene movimientos. Conserva su tipo para no alterar el histórico.');
      this.store.db.prepare('UPDATE budget_lines SET name=?,kind=?,group_name=?,note=?,version=version+1 WHERE id=?').run(input.name,input.kind,input.group,input.note,id);
      this.store.db.prepare('INSERT INTO budget_history VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),id,null,null,null,'line_changed',JSON.stringify({before:line,after:input}),new Date().toISOString());
      return this.lines().find(line=>line.id===id)!;
    });
  }

  movements(year:number):BudgetMovement[] {
    return this.store.db.prepare(`SELECT e.id,e.date,e.amount_cents,m.description,m.bank_category,a.name,b.line_id,b.excluded,b.version
      FROM entries e JOIN imported_movements m ON m.entry_id=e.id JOIN accounts a ON a.id=e.account_id
      LEFT JOIN budget_allocations b ON b.entry_id=e.id WHERE e.date>=? AND e.date<? ORDER BY e.date DESC,m.source_row ASC`).all(`${year}-01-01`,`${year+1}-01-01`).map(row=>({
        id:String(row.id),date:String(row.date),amountCents:Number(row.amount_cents),description:String(row.description),bankCategory:String(row.bank_category),accountName:String(row.name),
        lineId:row.line_id===null?null:String(row.line_id),excluded:Boolean(row.excluded),version:row.version===null?0:Number(row.version),
      }));
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
        this.store.db.prepare('INSERT INTO budget_history VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),input.lineId,date.slice(0,7),null,null,'movement_assigned',JSON.stringify({entryId:item.entryId,before:before??null,after:{lineId:input.lineId,excluded:input.excluded}}),now);
      }
      return {updated:input.items.length};
    });
  }

  history(year:number):BudgetHistory[] {
    return this.store.db.prepare(`SELECT h.*,l.name FROM budget_history h LEFT JOIN budget_lines l ON l.id=h.line_id WHERE h.period LIKE ? OR h.period IS NULL ORDER BY h.created_at DESC,h.rowid DESC LIMIT 100`).all(`${year}-%`).map(row=>({id:String(row.id),lineName:String(row.name??'Presupuesto inicial'),period:row.period===null?null:String(row.period),beforeCents:row.before_cents===null?null:Number(row.before_cents),afterCents:row.after_cents===null?null:Number(row.after_cents),action:String(row.action),at:String(row.created_at)}));
  }
}
