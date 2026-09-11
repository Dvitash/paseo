// Luau stream mode, adapted from @codemirror/legacy-modes/mode/lua (MIT,
// Marijn Haverbeke et al.) and extended for Luau: `continue`/`export`/`type`/
// `typeof` keywords, backtick interpolated strings, binary/underscored number
// literals, and the Luau + Roblox builtin surface. Registered for both `lua`
// and `luau` in parsers.ts — Luau is a superset, so one mode covers both.
import type { StreamParser, StringStream } from "@codemirror/language";

interface LuauState {
  basecol: number;
  indentDepth: number;
  cur: (stream: StringStream, state: LuauState) => string | null;
  interpStack: number[];
  parenDepth: number;
}

function wordRE(words: string[]): RegExp {
  return new RegExp(`^(?:${words.join("|")})$`, "i");
}
function prefixRE(words: string[]): RegExp {
  return new RegExp(`^(?:${words.join("|")})`, "i");
}

const builtins = wordRE([
  // Lua 5.1 base + Luau additions
  "_G",
  "_VERSION",
  "assert",
  "collectgarbage",
  "dofile",
  "error",
  "gcinfo",
  "getfenv",
  "getmetatable",
  "ipairs",
  "load",
  "loadfile",
  "loadstring",
  "module",
  "newproxy",
  "next",
  "pairs",
  "pcall",
  "print",
  "rawequal",
  "rawget",
  "rawlen",
  "rawset",
  "require",
  "select",
  "setfenv",
  "setmetatable",
  "tonumber",
  "tostring",
  "type",
  "typeof",
  "unpack",
  "xpcall",
  // coroutine
  "coroutine.create",
  "coroutine.resume",
  "coroutine.running",
  "coroutine.status",
  "coroutine.wrap",
  "coroutine.yield",
  "coroutine.isyieldable",
  "coroutine.close",
  // debug
  "debug.debug",
  "debug.getfenv",
  "debug.gethook",
  "debug.getinfo",
  "debug.getlocal",
  "debug.getmetatable",
  "debug.getregistry",
  "debug.getupvalue",
  "debug.setfenv",
  "debug.sethook",
  "debug.setlocal",
  "debug.setmetatable",
  "debug.setupvalue",
  "debug.traceback",
  "debug.info",
  "debug.profilebegin",
  "debug.profileend",
  "debug.resetmemorycategory",
  "debug.setmemorycategory",
  // io
  "io.close",
  "io.flush",
  "io.input",
  "io.lines",
  "io.open",
  "io.output",
  "io.popen",
  "io.read",
  "io.stderr",
  "io.stdin",
  "io.stdout",
  "io.tmpfile",
  "io.type",
  "io.write",
  // math
  "math.abs",
  "math.acos",
  "math.asin",
  "math.atan",
  "math.atan2",
  "math.ceil",
  "math.clamp",
  "math.cos",
  "math.cosh",
  "math.deg",
  "math.exp",
  "math.floor",
  "math.fmod",
  "math.frexp",
  "math.huge",
  "math.ldexp",
  "math.log",
  "math.log10",
  "math.map",
  "math.max",
  "math.min",
  "math.modf",
  "math.noise",
  "math.pi",
  "math.pow",
  "math.rad",
  "math.random",
  "math.randomseed",
  "math.round",
  "math.sign",
  "math.sin",
  "math.sinh",
  "math.sqrt",
  "math.tan",
  "math.tanh",
  // os
  "os.clock",
  "os.date",
  "os.difftime",
  "os.getenv",
  "os.remove",
  "os.rename",
  "os.setenv",
  "os.setlocale",
  "os.time",
  "os.tmpname",
  // package
  "package.config",
  "package.cpath",
  "package.loaded",
  "package.loadlib",
  "package.path",
  "package.preload",
  "package.seeall",
  // string
  "string.byte",
  "string.char",
  "string.dump",
  "string.find",
  "string.format",
  "string.gmatch",
  "string.gsub",
  "string.len",
  "string.lower",
  "string.match",
  "string.pack",
  "string.packsize",
  "string.rep",
  "string.reverse",
  "string.split",
  "string.sub",
  "string.unpack",
  "string.upper",
  // table
  "table.clear",
  "table.clone",
  "table.concat",
  "table.create",
  "table.find",
  "table.foreach",
  "table.foreachi",
  "table.freeze",
  "table.getn",
  "table.insert",
  "table.isfrozen",
  "table.maxn",
  "table.move",
  "table.pack",
  "table.remove",
  "table.sort",
  "table.unpack",
  // Luau-only libraries
  "bit32.arshift",
  "bit32.band",
  "bit32.bnot",
  "bit32.bor",
  "bit32.btest",
  "bit32.bxor",
  "bit32.countlz",
  "bit32.countrz",
  "bit32.extract",
  "bit32.lrotate",
  "bit32.lshift",
  "bit32.replace",
  "bit32.rrotate",
  "bit32.rshift",
  "buffer.create",
  "buffer.fromstring",
  "buffer.tostring",
  "buffer.len",
  "buffer.readi8",
  "buffer.readi16",
  "buffer.readi32",
  "buffer.readu8",
  "buffer.readu16",
  "buffer.readu32",
  "buffer.readf32",
  "buffer.readf64",
  "buffer.writei8",
  "buffer.writei16",
  "buffer.writei32",
  "buffer.writeu8",
  "buffer.writeu16",
  "buffer.writeu32",
  "buffer.writef32",
  "buffer.writef64",
  "buffer.readstring",
  "buffer.writestring",
  "buffer.copy",
  "buffer.fill",
  "utf8.char",
  "utf8.charpattern",
  "utf8.codepoint",
  "utf8.codes",
  "utf8.graphemes",
  "utf8.len",
  "utf8.nfcnormalize",
  "utf8.nfdnormalize",
  "utf8.offset",
  "vector.create",
  "vector.floor",
  "vector.ceil",
  "vector.abs",
  "vector.sign",
  "vector.clamp",
  "vector.min",
  "vector.max",
  "vector.lerp",
  "vector.magnitude",
  "vector.normalize",
  "vector.cross",
  "vector.dot",
  "vector.angle",
  // Roblox globals
  "game",
  "workspace",
  "script",
  "plugin",
  "shared",
  "_G",
  "Instance",
  "Enum",
  "Vector2",
  "Vector3",
  "Vector2int16",
  "Vector3int16",
  "CFrame",
  "Color3",
  "BrickColor",
  "UDim",
  "UDim2",
  "Rect",
  "Region3",
  "Region3int16",
  "Ray",
  "TweenInfo",
  "NumberRange",
  "NumberSequence",
  "NumberSequenceKeypoint",
  "ColorSequence",
  "ColorSequenceKeypoint",
  "PhysicalProperties",
  "PathWaypoint",
  "Random",
  "DateTime",
  "Faces",
  "Axes",
  "CatalogSearchParams",
  "FloatCurveKey",
  "RotationCurveKey",
  "OverlapParams",
  "RaycastParams",
  "Font",
  "task.spawn",
  "task.defer",
  "task.delay",
  "task.wait",
  "task.cancel",
  "task.synchronize",
  "task.desynchronize",
  "warn",
  "tick",
  "time",
  "elapsedTime",
  "wait",
  "spawn",
  "delay",
  "printidentity",
  "stats",
  "version",
  "settings",
  "UserSettings",
  "ipairs",
  "pairs",
]);

const keywords = wordRE([
  "and",
  "break",
  "continue",
  "do",
  "else",
  "elseif",
  "end",
  "export",
  "false",
  "for",
  "function",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "type",
  "typeof",
  "until",
  "while",
]);

const indentTokens = wordRE(["function", "if", "repeat", "do", "\\(", "{"]);
const dedentTokens = wordRE(["end", "until", "\\)", "}"]);
const dedentPartial = prefixRE(["end", "until", "\\)", "}", "else", "elseif"]);

function readBracket(stream: StringStream): number {
  let level = 0;
  while (stream.eat("=")) ++level;
  stream.eat("[");
  return level;
}

function startString(stream: StringStream, state: LuauState, ch: string): string | null {
  let fn: ((stream: StringStream, state: LuauState) => string) | null = null;
  if (ch === '"' || ch === "'") fn = quoted(ch);
  else if (ch === "`") fn = interpolated();
  else if (ch === "[" && /[[=]/.test(stream.peek() ?? "")) {
    fn = bracketed(readBracket(stream), "string");
  }
  if (!fn) return null;
  state.cur = fn;
  return fn(stream, state);
}

function normal(stream: StringStream, state: LuauState): string | null {
  const ch = stream.next();
  if (ch === "-" && stream.eat("-")) {
    if (stream.eat("[") && /[[=]/.test(stream.peek() ?? "")) {
      const fn = bracketed(readBracket(stream), "comment");
      state.cur = fn;
      return fn(stream, state);
    }
    stream.skipToEnd();
    return "comment";
  }
  if (ch !== undefined) {
    const stringStyle = startString(stream, state, ch);
    if (stringStyle !== null) return stringStyle;
  }
  if (ch === "{" || ch === "(") {
    state.parenDepth++;
    return null;
  }
  if (ch === "}" || ch === ")") {
    if (state.parenDepth > 0) state.parenDepth--;
    // A `}` that closes a `{expr}` interpolation inside a backtick string.
    const frame = state.interpStack[state.interpStack.length - 1];
    if (ch === "}" && frame !== undefined && state.parenDepth === frame) {
      state.interpStack.pop();
      const fn = interpolated();
      state.cur = fn;
      return fn(stream, state);
    }
    return null;
  }
  if (ch !== undefined && /\d/.test(ch)) {
    stream.eatWhile(/[\w.%]/);
    return "number";
  }
  if (ch !== undefined && /[\w_]/.test(ch)) {
    stream.eatWhile(/[\w\\\-_.]/);
    return "variable";
  }
  return null;
}

function bracketed(level: number, style: string) {
  return function (stream: StringStream, state: LuauState): string {
    let curlev: number | null = null;
    let ch: string | void;
    while ((ch = stream.next()) != null) {
      if (curlev == null) {
        if (ch === "]") curlev = 0;
      } else if (ch === "=") {
        ++curlev;
      } else if (ch === "]" && curlev === level) {
        state.cur = normal;
        break;
      } else {
        curlev = null;
      }
    }
    return style;
  };
}

function quoted(quote: string) {
  return function (stream: StringStream, state: LuauState): string {
    let escaped = false;
    let ch: string | void;
    while ((ch = stream.next()) != null) {
      if (ch === quote && !escaped) break;
      escaped = !escaped && ch === "\\";
    }
    if (!escaped) state.cur = normal;
    return "string";
  };
}

// Backtick string with `{expr}` interpolation. String content is styled
// "string"; `{` pushes an interpolation frame and hands the stream back to
// `normal`, which pops back here on the matching `}`.
function interpolated() {
  return function (stream: StringStream, state: LuauState): string {
    let ch: string | void;
    while ((ch = stream.next()) != null) {
      if (ch === "`") {
        state.cur = normal;
        return "string";
      }
      if (ch === "\\") {
        stream.next();
        continue;
      }
      if (ch === "{") {
        state.interpStack.push(state.parenDepth);
        state.parenDepth++;
        state.cur = normal;
        return "string";
      }
    }
    return "string";
  };
}

export const luauMode: StreamParser<LuauState> = {
  name: "luau",

  startState(): LuauState {
    return { basecol: 0, indentDepth: 0, cur: normal, interpStack: [], parenDepth: 0 };
  },

  token(stream: StringStream, state: LuauState): string | null {
    if (stream.eatSpace()) return null;
    let style = state.cur(stream, state);
    const word = stream.current();
    if (style === "variable") {
      if (keywords.test(word)) style = "keyword";
      else if (builtins.test(word) || builtins.test(word.split(".")[0])) style = "builtin";
    }
    if (style !== "comment" && style !== "string") {
      if (indentTokens.test(word)) ++state.indentDepth;
      else if (dedentTokens.test(word)) --state.indentDepth;
    }
    return style;
  },

  indent(state: LuauState, textAfter: string, cx): number {
    const closing = dedentPartial.test(textAfter);
    return state.basecol + cx.unit * (state.indentDepth - (closing ? 1 : 0));
  },

  languageData: {
    indentOnInput: /^\s*(?:end|until|else|\)|\})$/,
    commentTokens: { line: "--", block: { open: "--[[", close: "]]" } },
  },
};
