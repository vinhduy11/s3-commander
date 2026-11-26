import { describe, expect, it } from "vitest";
import { formatJson, minifyJson, validateJson } from "./json_tools";

describe("validateJson", () => {
  it("accepts every JSON value kind and surrounding whitespace", () => {
    for (const ok of ['{"a":[1,2.5e3,-0.1,true,false,null,"x\\n\\u00e9"]}', "[]", "{}", "1", '"s"', "null", " \n{ }\n "]) {
      expect(validateJson(ok), ok).toEqual({ ok: true });
    }
  });

  it("reports the line and column of the offending token", () => {
    expect(validateJson('{"a":1,}')).toMatchObject({ ok: false, line: 1, column: 8, offset: 7 });
    expect(validateJson('{\n  "a": 1,\n  "b": }')).toMatchObject({ ok: false, line: 3, column: 8 });
    expect(validateJson("[1, 2")).toMatchObject({ ok: false, line: 1, column: 6, message: "Unexpected end of input" });
    expect(validateJson('{"a":1} x')).toMatchObject({ ok: false, line: 1, column: 9 });
    expect(validateJson("")).toMatchObject({ ok: false, message: "Unexpected end of input" });
  });

  it("rejects what JSON.parse rejects", () => {
    for (const bad of ["{'a':1}", '{"a":01}', "[1,,2]", '{"a" 1}', '"\u0001"', '"\\x"', "tru", "{a:1}", "[1 2]", '{"a":1 "b":2}', "-", "1.", '"abc']) {
      expect(validateJson(bad).ok, bad).toBe(false);
      expect(() => JSON.parse(bad), bad).toThrow();
    }
  });

  it("agrees with JSON.parse on valid documents", () => {
    for (const good of ['{"a":{"b":[{}]}}', "0", "-0.5E+2", '"\\ud83d\\ude00"']) {
      expect(validateJson(good).ok, good).toBe(true);
      expect(() => JSON.parse(good)).not.toThrow();
    }
  });
});

describe("formatJson and minifyJson", () => {
  it("formats with 2 spaces and keeps empty containers inline", () => {
    expect(formatJson('{"a":[1,2,{"b":null}],"c":{},"d":[]}')).toEqual({
      ok: true,
      text: '{\n  "a": [\n    1,\n    2,\n    {\n      "b": null\n    }\n  ],\n  "c": {},\n  "d": []\n}',
    });
  });

  it("keeps number literals, escapes and key order exactly (no JSON.parse round trip)", () => {
    const result = formatJson('{"b":1.0e5,"a":12345678901234567890,"1":"\\u00e9\\/","0":2}');
    expect(result).toEqual({ ok: true, text: '{\n  "b": 1.0e5,\n  "a": 12345678901234567890,\n  "1": "\\u00e9\\/",\n  "0": 2\n}' });
  });

  it("keeps the trailing newline state and the line ending", () => {
    expect(formatJson('{"a":1}\n')).toEqual({ ok: true, text: '{\n  "a": 1\n}\n' });
    expect(formatJson('{"a":1}\r\n', "\r\n")).toEqual({ ok: true, text: '{\r\n  "a": 1\r\n}\r\n' });
  });

  it("minifies, dropping whitespace outside strings", () => {
    expect(minifyJson('{\n  "a": [ 1, 2 ],\n  "b": "x y"\n}\n')).toEqual({ ok: true, text: '{"a":[1,2],"b":"x y"}\n' });
  });

  it("returns the error and no text for invalid JSON", () => {
    const result = formatJson('{"a":}');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: { line: 1, column: 6 } });
    expect(minifyJson("[1,]").ok).toBe(false);
  });
});
