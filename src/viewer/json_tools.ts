// JSON validation with an error position, plus Format and Minify that work on the token text, so
// number literals, escapes and key order are never changed (a JSON.parse round trip would).

export type JsonError = { message: string; offset: number; line: number; column: number };
export type JsonCheck = { ok: true } | ({ ok: false } & JsonError);
export type JsonResult = { ok: true; text: string } | { ok: false; error: JsonError };

class Failure {
  constructor(
    readonly message: string,
    readonly offset: number,
  ) {}
}

const WHITESPACE = " \t\n\r";
const DIGITS = "0123456789";
const describe = (char: string) => (char === undefined ? "end of input" : `'${char}'`);

/** Splits valid JSON into tokens (structure characters and raw value text); throws a Failure otherwise. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const size = text.length;
  let at = 0;

  const skip = () => {
    while (at < size && WHITESPACE.includes(text[at])) at++;
  };
  const unexpected = (what = "") => {
    if (at >= size) throw new Failure("Unexpected end of input", at);
    throw new Failure(`Unexpected ${describe(text[at])}${what}`, at);
  };
  const digits = () => {
    if (!DIGITS.includes(text[at] ?? "x")) unexpected(", expected a digit");
    while (at < size && DIGITS.includes(text[at])) at++;
  };
  const string = () => {
    const start = at++;
    for (;;) {
      if (at >= size) throw new Failure("Unexpected end of input", at);
      const char = text[at];
      if (char === '"') break;
      if (char < " ") throw new Failure("Unexpected control character in a string", at);
      if (char === "\\") {
        const next = text[at + 1];
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) throw new Failure("Invalid \\u escape", at);
          at += 6;
          continue;
        }
        if (next === undefined || !'"\\/bfnrt'.includes(next)) throw new Failure("Invalid escape sequence", at);
        at += 2;
        continue;
      }
      at++;
    }
    out.push(text.slice(start, ++at));
  };
  const number = () => {
    const start = at;
    if (text[at] === "-") at++;
    if (text[at] === "0") at++;
    else digits();
    if (text[at] === ".") {
      at++;
      digits();
    }
    if (text[at] === "e" || text[at] === "E") {
      at++;
      if (text[at] === "+" || text[at] === "-") at++;
      digits();
    }
    out.push(text.slice(start, at));
  };
  const literal = (word: string) => {
    if (!text.startsWith(word, at)) unexpected();
    out.push(word);
    at += word.length;
  };
  const container = (open: "{" | "[", close: "}" | "]") => {
    out.push(open);
    at++;
    skip();
    if (text[at] === close) {
      out.push(close);
      at++;
      return;
    }
    for (;;) {
      skip();
      if (open === "{") {
        if (text[at] !== '"') unexpected(", expected a string key");
        string();
        skip();
        if (text[at] !== ":") unexpected(", expected ':'");
        out.push(":");
        at++;
      }
      value();
      skip();
      if (text[at] === ",") {
        out.push(",");
        at++;
      } else if (text[at] === close) {
        out.push(close);
        at++;
        return;
      } else unexpected(`, expected ',' or '${close}'`);
    }
  };
  function value() {
    skip();
    const char = text[at];
    if (char === "{") container("{", "}");
    else if (char === "[") container("[", "]");
    else if (char === '"') string();
    else if (char === "-" || (char !== undefined && DIGITS.includes(char))) number();
    else if (char === "t") literal("true");
    else if (char === "f") literal("false");
    else if (char === "n") literal("null");
    else unexpected();
  }

  value();
  skip();
  if (at < size) throw new Failure("Unexpected data after the end of the value", at);
  return out;
}

function located(failure: Failure, text: string): JsonError {
  const before = text.slice(0, failure.offset);
  const line = before.split("\n").length;
  return { message: failure.message, offset: failure.offset, line, column: failure.offset - before.lastIndexOf("\n") };
}

function run<T>(text: string, action: (tokens: string[]) => T): { ok: true; value: T } | { ok: false; error: JsonError } {
  try {
    return { ok: true, value: action(tokenize(text)) };
  } catch (err) {
    if (err instanceof Failure) return { ok: false, error: located(err, text) };
    throw err;
  }
}

export function validateJson(text: string): JsonCheck {
  const result = run(text, () => undefined);
  return result.ok ? { ok: true } : { ok: false, ...result.error };
}

const endsWithNewline = (text: string) => /\n[ \t\r]*$/.test(text);

function rewrite(text: string, eol: string, build: (tokens: string[]) => string): JsonResult {
  const result = run(text, build);
  if (!result.ok) return result;
  return { ok: true, text: result.value + (endsWithNewline(text) ? eol : "") };
}

/** Pretty-prints with 2 spaces; empty containers stay on one line. */
export function formatJson(text: string, eol: "\n" | "\r\n" = "\n"): JsonResult {
  return rewrite(text, eol, (tokens) => {
    let depth = 0;
    let out = "";
    const line = () => `${eol}${"  ".repeat(depth)}`;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token === "{" || token === "[") {
        const closer = token === "{" ? "}" : "]";
        if (tokens[index + 1] === closer) {
          out += token + closer;
          index++;
        } else {
          depth++;
          out += token + line();
        }
      } else if (token === "}" || token === "]") {
        depth--;
        out += line() + token;
      } else if (token === ",") out += "," + line();
      else if (token === ":") out += ": ";
      else out += token;
    }
    return out;
  });
}

/** Removes all whitespace outside strings. */
export function minifyJson(text: string, eol: "\n" | "\r\n" = "\n"): JsonResult {
  return rewrite(text, eol, (tokens) => tokens.join(""));
}
