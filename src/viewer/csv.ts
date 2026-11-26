// CSV/TSV parsing and serialization (RFC 4180 quoting). The model keeps, per cell, the exact text
// it came from, plus each row's line ending, so a table edit changes only the cells that were
// edited: delimiter, quoting style, line endings and the trailing newline of everything else stay.

export type Delimiter = "," | ";" | "\t" | "|";
export const DELIMITERS: Delimiter[] = [",", ";", "\t", "|"];

export type CsvModel = {
  rows: string[][];
  /** The source text of each cell (quotes included); null for a cell edited in the table. */
  raws: (string | null)[][];
  /** Line ending after each row; "" for a last row without one. */
  eols: string[];
  delimiter: Delimiter;
};

export function parseCsv(text: string, delimiter: Delimiter): CsvModel {
  const model: CsvModel = { rows: [], raws: [], eols: [], delimiter };
  const size = text.length;
  const atBreak = (at: number) => text[at] === "\n" || (text[at] === "\r" && text[at + 1] === "\n");
  let at = 0;
  while (at < size) {
    const row: string[] = [];
    const raw: string[] = [];
    let eol = "";
    for (;;) {
      const start = at;
      let value: string;
      if (text[at] === '"') {
        value = "";
        at++;
        while (at < size) {
          if (text[at] === '"') {
            if (text[at + 1] !== '"') break;
            value += '"';
            at += 2;
          } else value += text[at++];
        }
        if (at < size) at++; // the closing quote
        // Anything between the closing quote and the delimiter is kept as part of the value.
        while (at < size && text[at] !== delimiter && !atBreak(at)) value += text[at++];
      } else {
        while (at < size && text[at] !== delimiter && !atBreak(at)) at++;
        value = text.slice(start, at);
      }
      row.push(value);
      raw.push(text.slice(start, at));
      if (at >= size) break;
      if (text[at] === delimiter) {
        at++;
        continue;
      }
      eol = text[at] === "\r" ? "\r\n" : "\n";
      at += eol.length;
      break;
    }
    model.rows.push(row);
    model.raws.push(raw);
    model.eols.push(eol);
  }
  return model;
}

const needsQuotes = (value: string, delimiter: Delimiter) => value.includes(delimiter) || /["\r\n]/.test(value);

function cellText(value: string, raw: string | null | undefined, delimiter: Delimiter): string {
  if (raw !== null && raw !== undefined) return raw;
  return needsQuotes(value, delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeCsv(model: CsvModel): string {
  return model.rows
    .map((row, r) => row.map((value, c) => cellText(value, model.raws[r][c], model.delimiter)).join(model.delimiter) + model.eols[r])
    .join("");
}

export const columnCount = (model: CsvModel) => model.rows.reduce((most, row) => Math.max(most, row.length), 0);

const defaultEol = (model: CsvModel) => model.eols.find((eol) => eol !== "") ?? "\n";

function copyOf(model: CsvModel): CsvModel {
  return { ...model, rows: model.rows.map((row) => [...row]), raws: model.raws.map((row) => [...row]), eols: [...model.eols] };
}

/** After rows were added or removed: every row but the last ends with a line break, and the last
 *  one keeps the file's trailing-newline state. */
function fixEndings(model: CsvModel, hadTrailing: boolean): CsvModel {
  const eol = defaultEol(model);
  const last = model.rows.length - 1;
  model.eols = model.eols.map((current, index) => (index < last ? current || eol : hadTrailing ? current || eol : ""));
  return model;
}

const hasTrailing = (model: CsvModel) => model.eols.length > 0 && model.eols[model.eols.length - 1] !== "";

export function setCell(model: CsvModel, row: number, col: number, value: string): CsvModel {
  if (model.rows[row]?.[col] === value) return model;
  const next = copyOf(model);
  while (next.rows[row].length <= col) {
    next.rows[row].push("");
    next.raws[row].push("");
  }
  next.rows[row][col] = value;
  next.raws[row][col] = null;
  return next;
}

export function insertRow(model: CsvModel, at: number): CsvModel {
  const next = copyOf(model);
  const cells = Math.max(1, columnCount(model));
  next.rows.splice(at, 0, Array<string>(cells).fill(""));
  next.raws.splice(at, 0, Array<string>(cells).fill(""));
  next.eols.splice(at, 0, defaultEol(model));
  return fixEndings(next, hasTrailing(model));
}

export function deleteRow(model: CsvModel, at: number): CsvModel {
  const next = copyOf(model);
  next.rows.splice(at, 1);
  next.raws.splice(at, 1);
  next.eols.splice(at, 1);
  return fixEndings(next, hasTrailing(model));
}

export function insertColumn(model: CsvModel, at: number): CsvModel {
  const next = copyOf(model);
  next.rows.forEach((row, r) => {
    while (row.length < at) {
      row.push("");
      next.raws[r].push("");
    }
    row.splice(at, 0, "");
    next.raws[r].splice(at, 0, "");
  });
  return next;
}

export function deleteColumn(model: CsvModel, at: number): CsvModel {
  const next = copyOf(model);
  next.rows.forEach((row, r) => {
    row.splice(at, 1);
    next.raws[r].splice(at, 1);
  });
  return next;
}

const SAMPLE_CHARS = 64 * 1024;

/** The delimiter that splits the first rows into the same number of columns, most columns wins.
 *  Quoted fields are respected. Falls back to a tab for `.tsv` and to a comma otherwise. */
export function detectDelimiter(text: string, fileName = ""): Delimiter {
  const truncated = text.length > SAMPLE_CHARS;
  let best: Delimiter = fileName.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const rows = parseCsv(text.slice(0, SAMPLE_CHARS), delimiter).rows;
    if (truncated) rows.pop(); // the last row of a cut sample is incomplete
    if (!rows.length) continue;
    const counts = new Map<number, number>();
    for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    const [modal, matching] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    const score = modal > 1 ? (matching / rows.length) * (modal - 1) : 0;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}
