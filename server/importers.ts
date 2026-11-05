import XLSX from 'xlsx';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { validDate } from '../shared/accounts.js';
import type { ColumnMapping, ImportDocumentInfo, ParsedMovement } from '../shared/imports.js';
import { AccountError } from './database.js';

const normal = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const text = (value: unknown) => String(value ?? '').trim();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export type ImportDocument = { info: ImportDocumentInfo; rows: unknown[][]; sourceRows: number[]; firstDataRow: number; original: Buffer; digest: string; identity: string; date1904: boolean; };

export function readDocument(buffer: Buffer, filename: string, headerRow?: number): ImportDocument {
  if (!/\.(xls|xlsx|csv)$/i.test(filename)) throw new AccountError(400, 'Selecciona un archivo XLS, XLSX o CSV.');
  if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) throw new AccountError(400, 'El archivo debe ocupar entre 1 byte y 5 MB.');
  let workbook: XLSX.WorkBook;
  try {
    const binary = buffer.subarray(0, 4).toString('hex');
    const options = { raw: true, cellDates: false, cellFormula: false, cellHTML: false, sheetRows: 10105 };
    if (binary === 'd0cf11e0' || binary.startsWith('504b')) workbook = XLSX.read(buffer, { ...options, type: 'buffer' });
    else {
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { decoded = new TextDecoder('windows-1252').decode(buffer); }
      workbook = XLSX.read(decoded.trim(), { ...options, type: 'string' });
    }
  }
  catch { throw new AccountError(400, 'No se puede leer el archivo. Comprueba que es un extracto sin contraseña.'); }
  if (workbook.SheetNames.length !== 1) throw new AccountError(400, 'El extracto debe tener una sola hoja. Exporta la hoja de movimientos en un archivo separado.');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
  if (range.e.r > 10100 || range.e.c > 99) throw new AccountError(400, 'El extracto supera el límite de 10.000 movimientos o 100 columnas. Divide la exportación.');
  const all = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true, blankrows: true });
  const ingIndex = all.findIndex(row => row.some(v => normal(v) === 'f. valor') && row.some(v => normal(v) === 'descripcion') && row.some(v => normal(v) === 'saldo (€)'));
  const isIng = ingIndex >= 0 && all.slice(0, ingIndex).some(row => row.some(v => normal(v).includes('movimientos de la cuenta')));
  const guessedIndex = all.findIndex(row => row.some(v => /^(fecha|f\. valor|f\. operativa|fecha valor|fecha operacion|fecha de operacion|date)$/.test(normal(v))) && row.some(v => /importe|amount|concepto|descripcion/.test(normal(v))));
  const index = headerRow !== undefined ? headerRow - 1 : isIng ? ingIndex : guessedIndex >= 0 ? guessedIndex : all.findIndex(row => row.some(v => text(v)));
  if (index < 0 || index > 99 || !all[index]) throw new AccountError(400, 'No se encuentra la fila de cabecera. Indica su número (entre 1 y 100).');
  const headers = all[index].map((v, i) => text(v) || `Columna ${i + 1}`);
  while (headers.length && !all[index][headers.length - 1]) headers.pop();
  const find = (patterns: RegExp[]) => headers.findIndex(h => patterns.some(p => p.test(normal(h))));
  const mapping: ColumnMapping = {
    date: find([/^f\. operativa$/, /^fecha operacion$/, /^fecha de operacion$/, /^fecha$/, /^date$/]),
    valueDate: find([/^f\. valor$/, /^fecha valor$/, /^fecha de valor$/]),
    description: find([/^descripcion$/, /^concepto$/, /^description$/, /^detalle$/]),
    amount: find([/^importe(?: \(€\))?$/, /^amount$/, /^importe eur$/]),
    balance: find([/^saldo(?: \(€\))?$/, /^balance$/, /^saldo contable$/]),
    category: find([/^categoria$/]), subcategory: find([/^subcategoria$/]), comment: find([/^comentario$/, /^observaciones$/]),
  };
  if (mapping.date < 0) { mapping.date = mapping.valueDate; mapping.valueDate = -1; }
  const metadata = all.slice(0, index);
  const accountRow = metadata.find(row => row.some(v => normal(v).includes('numero de cuenta') || normal(v) === 'cuenta:'));
  const ownerRow = metadata.find(row => row.some(v => normal(v).includes('titular:')));
  const afterLabel = (row: unknown[] | undefined, needle: string) => {
    if (!row) return '';
    const at = row.findIndex(v => normal(v).includes(needle));
    return text(row.slice(at + 1).find(v => text(v)));
  };
  const accountLabel = accountRow?.some(v => normal(v).includes('numero de cuenta')) ? 'numero de cuenta' : 'cuenta:';
  const number = afterLabel(accountRow, accountLabel).replace(/\s+/g, '');
  const canonicalNumber = /^ES\d{22}$/.test(number) ? number.slice(4) : number;
  const detectedBank: ImportDocumentInfo['detectedBank'] = isIng ? 'ING' : canonicalNumber.startsWith('0073') && headers.some(h => normal(h) === 'fecha operacion') ? 'Openbank' : canonicalNumber.startsWith('0081') && headers.some(h => normal(h) === 'f. operativa') ? 'Sabadell' : /myinvestor/i.test(filename) && headers.some(h => normal(h) === 'divisa') ? 'MyInvestor' : null;
  const indexedRows = all.slice(index + 1).map((row, i) => ({ row, number: index + i + 2 })).filter(item => item.row.some(v => text(v)));
  const rows = indexedRows.map(item => item.row);
  if (rows.length > 10000) throw new AccountError(400, 'El extracto supera los 10.000 movimientos. Divide la exportación.');
  const currencyCol = headers.findIndex(h => /^(divisa|moneda|currency)$/.test(normal(h)));
  const metadataCurrency = metadata.find(row => row.some(v => normal(v) === 'divisa:'));
  if ((currencyCol >= 0 && rows.some(row => !/^(EUR|€)$/i.test(text(row[currencyCol])))) || (metadataCurrency && !/^EUR$/i.test(afterLabel(metadataCurrency, 'divisa:')))) throw new AccountError(400, 'Este piloto solo importa movimientos en euros.');
  if (!rows.length) throw new AccountError(400, 'El extracto no contiene movimientos.');
  const info: ImportDocumentInfo = {
    token: randomUUID(), filename: basename(filename).slice(0, 200), detectedBank,
    headers, mapping, sample: rows.slice(0, 3).map(row => headers.map((_, i) => text(row[i]))), rowCount: rows.length,
    lastFour: number ? number.slice(-4) : '', owner: afterLabel(ownerRow, 'titular:'),
    firstDate: '', lastDate: '',
  };
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  if (mapping.date >= 0) {
    try { const dates = rows.map(row => date(row[mapping.date], date1904)).sort(); info.firstDate = dates[0]; info.lastDate = dates.at(-1)!; }
    catch { /* The user can choose another date column in the mapping step. */ }
  }
  return { info, rows, sourceRows: indexedRows.map(row => row.number), firstDataRow: index + 2, original: buffer, digest: hash(buffer), identity: canonicalNumber ? hash(`${detectedBank ?? 'bank'}:${canonicalNumber}`) : '', date1904 };
}

function money(value: unknown): number {
  if (typeof value === 'number') {
    const cents = Math.round(value * 100);
    if (Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < .0001 && Math.abs(cents) <= 1e12) return cents;
  }
  if (typeof value === 'string') {
    let normalized = value.trim().replace(/[€\s\u00a0]/g, '');
    if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(normalized)) normalized = normalized.replace(/\./g, '');
    if (/^-?\d+(?:[.,]\d{1,2})?$/.test(normalized)) {
      const negative = normalized.startsWith('-');
      const [whole, fraction = ''] = normalized.replace(/^-/, '').split(/[.,]/);
      const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      if (Number.isSafeInteger(cents) && Math.abs(cents) <= 1e12) return negative ? -cents : cents;
    }
  }
  throw new Error('importe no válido (usa formato español y euros)');
}

function date(value: unknown, date1904: boolean): string {
  let result = '';
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value, { date1904 });
    if (parsed) result = `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  } else {
    const valueText = text(value);
    const es = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(valueText);
    result = es ? `${es[3]}-${es[2].padStart(2, '0')}-${es[1].padStart(2, '0')}` : valueText;
  }
  if (!validDate(result)) throw new Error('fecha no válida (usa día/mes/año o año-mes-día)');
  return result;
}

export function parseMovements(document: ImportDocument, mapping: ColumnMapping): { rows: ParsedMovement[]; hasBalances: boolean } {
  for (const key of ['date', 'description', 'amount'] as const) if (mapping[key] < 0 || mapping[key] >= document.info.headers.length) throw new AccountError(400, `Selecciona la columna de ${key === 'date' ? 'fecha' : key === 'description' ? 'descripción' : 'importe'}.`);
  const chosen = Object.values(mapping).filter(v => v >= 0);
  if (new Set(chosen).size !== chosen.length || chosen.some(v => v >= document.info.headers.length)) throw new AccountError(400, 'Cada campo debe usar una columna diferente del extracto.');
  const hasBalances = mapping.balance >= 0;
  let rows = document.rows.map((row, i): ParsedMovement => {
    try {
      const description = text(row[mapping.description]);
      if (!description || description.length > 3000) throw new Error('descripción vacía o demasiado larga');
      return {
        date: date(row[mapping.date], document.date1904), description,
        valueDate: mapping.valueDate >= 0 ? date(row[mapping.valueDate], document.date1904) : null,
        amountCents: money(row[mapping.amount]), balanceAfterCents: hasBalances ? money(row[mapping.balance]) : null,
        category: mapping.category >= 0 ? text(row[mapping.category]).slice(0, 200) : '',
        subcategory: mapping.subcategory >= 0 ? text(row[mapping.subcategory]).slice(0, 200) : '',
        comment: mapping.comment >= 0 ? text(row[mapping.comment]).slice(0, 3000) : '',
        sourceRow: document.sourceRows[i], fingerprint: '',
      };
    } catch (error) { throw new AccountError(400, `Fila ${document.sourceRows[i]}: ${(error as Error).message}. No se ha importado nada.`); }
  });
  if (hasBalances) {
    const consistent = (candidate: ParsedMovement[]) => candidate.every((row, i) => i === 0 || (row.balanceAfterCents! - row.amountCents === candidate[i - 1].balanceAfterCents && row.date >= candidate[i - 1].date));
    if (!consistent(rows)) {
      const reversed = [...rows].reverse();
      if (!consistent(reversed)) throw new AccountError(400, 'Los saldos no encadenan con los importes y las fechas. Puede faltar algún movimiento, haber otra divisa o una columna incorrecta. Revisa el extracto completo.');
      rows = reversed;
    }
  } else rows.sort((a, b) => a.date.localeCompare(b.date) || a.sourceRow - b.sourceRow);
  const occurrences = new Map<string, number>();
  rows.forEach(row => {
    const signature = hash(JSON.stringify([row.date, normal(row.description), row.amountCents, row.balanceAfterCents]));
    const ordinal = (occurrences.get(signature) ?? 0) + 1;
    occurrences.set(signature, ordinal);
    row.fingerprint = hash(`${signature}:${ordinal}`);
  });
  return { rows, hasBalances };
}
