import { describe, expect, it } from "vitest";
import { columnCount, deleteColumn, deleteRow, detectDelimiter, insertColumn, insertRow, parseCsv, serializeCsv, setCell } from "./csv";

const rt = (text: string, delimiter: "," | ";" | "\t" | "|" = ",") => serializeCsv(parseCsv(text, delimiter));

describe("parseCsv", () => {
  it("splits rows and fields", () => {
    expect(parseCsv("a,b\n1,2\n", ",").rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("unquotes, with doubled quotes, embedded delimiters and embedded newlines", () => {
    const model = parseCsv('"a ""b""","x,y","line1\nline2"\n', ",");
    expect(model.rows).toEqual([['a "b"', "x,y", "line1\nline2"]]);
  });

  it("handles every delimiter", () => {
    expect(parseCsv("a;b;c", ";").rows).toEqual([["a", "b", "c"]]);
    expect(parseCsv("a\tb", "\t").rows).toEqual([["a", "b"]]);
    expect(parseCsv("a|b|", "|").rows).toEqual([["a", "b", ""]]);
  });

  it("keeps ragged rows as they are and records each row's line ending", () => {
    const model = parseCsv("a,b,c\r\n1\n2,3\r\n", ",");
    expect(model.rows).toEqual([["a", "b", "c"], ["1"], ["2", "3"]]);
    expect(model.eols).toEqual(["\r\n", "\n", "\r\n"]);
    expect(columnCount(model)).toBe(3);
  });

  it("does not add a row for the final newline, and an empty file has no rows", () => {
    expect(parseCsv("a\n", ",").rows).toEqual([["a"]]);
    expect(parseCsv("a", ",").eols).toEqual([""]);
    expect(parseCsv("", ",").rows).toEqual([]);
    expect(parseCsv("a\n\n", ",").rows).toEqual([["a"], [""]]);
  });

  it("tolerates a stray quote and an unterminated quoted field", () => {
    expect(parseCsv('a"b,c', ",").rows).toEqual([['a"b', "c"]]);
    expect(parseCsv('"abc', ",").rows).toEqual([["abc"]]);
    expect(parseCsv('"ab"cd,e', ",").rows).toEqual([["abcd", "e"]]);
  });
});

describe("serializeCsv round trip", () => {
  const samples = [
    "a,b\n1,2\n",
    "a,b\r\n1,2\r\n",
    "a,b\r\n1,2\n3,4\r\n", // mixed line endings
    "a,b\n1,2", // no trailing newline
    '"a","b"\n"1","2"\n', // needless quotes kept
    '"a ""q""","x,y","l1\nl2"\n',
    ",,\n,,\n",
    "a,b,\n",
    'a"b,c\n',
    '"abc',
    "",
    "\n\n",
    "a,b\n1\n1,2,3,4\n", // ragged
    "\u{feff}a,b\n", // a BOM character that reached the text stays a cell character
    "héllo,世界\n",
  ];
  for (const sample of samples) {
    it(`is byte identical for ${JSON.stringify(sample)}`, () => expect(rt(sample)).toBe(sample));
  }

  it("is byte identical for other delimiters", () => {
    expect(rt("a;b\r\n\"x;y\";2\r\n", ";")).toBe("a;b\r\n\"x;y\";2\r\n");
    expect(rt("a\tb\n1\t2\n", "\t")).toBe("a\tb\n1\t2\n");
  });
});

describe("editing", () => {
  it("changes only the edited cell and leaves the rest of the text as it was", () => {
    const model = parseCsv('"a","b"\r\n1,2\r\n', ",");
    expect(serializeCsv(setCell(model, 1, 1, "9"))).toBe('"a","b"\r\n1,9\r\n');
  });

  it("quotes a new value only when it needs it", () => {
    const model = parseCsv("a,b\n", ",");
    expect(serializeCsv(setCell(model, 0, 0, "x,y"))).toBe('"x,y",b\n');
    expect(serializeCsv(setCell(model, 0, 0, 'say "hi"'))).toBe('"say ""hi""",b\n');
    expect(serializeCsv(setCell(model, 0, 0, "l1\nl2"))).toBe('"l1\nl2",b\n');
    expect(serializeCsv(setCell(model, 0, 0, "plain"))).toBe("plain,b\n");
    expect(serializeCsv(setCell(parseCsv("a;b\n", ";"), 0, 0, "x;y"))).toBe('"x;y";b\n');
  });

  it("setting a value back is written with the plain rule, not the old quoting", () => {
    const model = parseCsv('"a",b\n', ",");
    expect(serializeCsv(setCell(setCell(model, 0, 0, "z"), 0, 0, "a"))).toBe("a,b\n");
  });

  it("pads a short row when a cell beyond its end is set", () => {
    const model = parseCsv("a,b,c\n1\n", ",");
    expect(serializeCsv(setCell(model, 1, 2, "x"))).toBe("a,b,c\n1,,x\n");
  });

  it("inserts and deletes rows keeping the trailing newline state", () => {
    const withNewline = parseCsv("a,b\r\n1,2\r\n", ",");
    expect(serializeCsv(insertRow(withNewline, 2))).toBe("a,b\r\n1,2\r\n,\r\n");
    expect(serializeCsv(insertRow(withNewline, 1))).toBe("a,b\r\n,\r\n1,2\r\n");
    expect(serializeCsv(deleteRow(withNewline, 1))).toBe("a,b\r\n");
    const without = parseCsv("a,b\n1,2", ",");
    expect(serializeCsv(insertRow(without, 2))).toBe("a,b\n1,2\n,");
    expect(serializeCsv(deleteRow(without, 1))).toBe("a,b");
  });

  it("inserts and deletes columns", () => {
    const model = parseCsv("a,b\n1,2\n", ",");
    expect(serializeCsv(insertColumn(model, 1))).toBe("a,,b\n1,,2\n");
    expect(serializeCsv(insertColumn(model, 2))).toBe("a,b,\n1,2,\n");
    expect(serializeCsv(deleteColumn(model, 0))).toBe("b\n2\n");
  });
});

describe("detectDelimiter", () => {
  it("picks the delimiter that gives consistent columns", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n1\t2\t3\n")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3\n")).toBe("|");
  });

  it("ignores delimiters inside quotes and decimals with a comma in a semicolon file", () => {
    expect(detectDelimiter('"a,b";c\n"1,5";2\n')).toBe(";");
    expect(detectDelimiter("x;y\n1,5;2\n3,5;4\n")).toBe(";");
  });

  it("falls back to a comma, or to a tab for .tsv, when nothing is delimited", () => {
    expect(detectDelimiter("just one column\nnext\n")).toBe(",");
    expect(detectDelimiter("just one column\n", "data.tsv")).toBe("\t");
    expect(detectDelimiter("")).toBe(",");
  });
});
