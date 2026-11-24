/**
 * CSV building. Values starting with = + - @ (or tab/CR) are prefixed with an apostrophe so a
 * spreadsheet never runs them as formulas (CSV injection). Output starts with a UTF-8 BOM so
 * Excel shows names and the rupee sign correctly.
 */
const DANGEROUS = /^[=+\-@\t\r]/;

function cell(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (DANGEROUS.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** columns: [{ header, value: (row) => any }] */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(c.value(r))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Paise → "1234.50" (plain number, no currency symbol, so spreadsheets can add it up). */
export const rupees = (paise) => (paise === null || paise === undefined ? '' : (paise / 100).toFixed(2));
