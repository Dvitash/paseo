import { defineLanguageFacet, Language, StreamLanguage } from "@codemirror/language";
import {
  ceylon,
  dart,
  kotlin,
  nesC,
  objectiveC,
  objectiveCpp,
  scala,
  shader,
  squirrel,
} from "@codemirror/legacy-modes/mode/clike";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { apl } from "@codemirror/legacy-modes/mode/apl";
import { asciiArmor } from "@codemirror/legacy-modes/mode/asciiarmor";
import { asn1 } from "@codemirror/legacy-modes/mode/asn1";
import { asterisk } from "@codemirror/legacy-modes/mode/asterisk";
import { brainfuck } from "@codemirror/legacy-modes/mode/brainfuck";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { cobol } from "@codemirror/legacy-modes/mode/cobol";
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript";
import { commonLisp } from "@codemirror/legacy-modes/mode/commonlisp";
import { crystal } from "@codemirror/legacy-modes/mode/crystal";
import { cypher } from "@codemirror/legacy-modes/mode/cypher";
import { d } from "@codemirror/legacy-modes/mode/d";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { dtd } from "@codemirror/legacy-modes/mode/dtd";
import { dylan } from "@codemirror/legacy-modes/mode/dylan";
import { ebnf } from "@codemirror/legacy-modes/mode/ebnf";
import { ecl } from "@codemirror/legacy-modes/mode/ecl";
import { eiffel } from "@codemirror/legacy-modes/mode/eiffel";
import { elm } from "@codemirror/legacy-modes/mode/elm";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { factor } from "@codemirror/legacy-modes/mode/factor";
import { fcl } from "@codemirror/legacy-modes/mode/fcl";
import { forth } from "@codemirror/legacy-modes/mode/forth";
import { fortran } from "@codemirror/legacy-modes/mode/fortran";
import { gas, gasArm } from "@codemirror/legacy-modes/mode/gas";
import { gherkin } from "@codemirror/legacy-modes/mode/gherkin";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { haxe, hxml } from "@codemirror/legacy-modes/mode/haxe";
import { http } from "@codemirror/legacy-modes/mode/http";
import { idl } from "@codemirror/legacy-modes/mode/idl";
import { jinja2 } from "@codemirror/legacy-modes/mode/jinja2";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { liveScript } from "@codemirror/legacy-modes/mode/livescript";
import { mathematica } from "@codemirror/legacy-modes/mode/mathematica";
import { mbox } from "@codemirror/legacy-modes/mode/mbox";
import { mirc } from "@codemirror/legacy-modes/mode/mirc";
import { fSharp, oCaml, sml } from "@codemirror/legacy-modes/mode/mllike";
import { modelica } from "@codemirror/legacy-modes/mode/modelica";
import { mscgen, msgenny, xu } from "@codemirror/legacy-modes/mode/mscgen";
import { mumps } from "@codemirror/legacy-modes/mode/mumps";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { nsis } from "@codemirror/legacy-modes/mode/nsis";
import { ntriples } from "@codemirror/legacy-modes/mode/ntriples";
import { octave } from "@codemirror/legacy-modes/mode/octave";
import { oz } from "@codemirror/legacy-modes/mode/oz";
import { pascal } from "@codemirror/legacy-modes/mode/pascal";
import { pegjs } from "@codemirror/legacy-modes/mode/pegjs";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { pig } from "@codemirror/legacy-modes/mode/pig";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { pug } from "@codemirror/legacy-modes/mode/pug";
import { puppet } from "@codemirror/legacy-modes/mode/puppet";
import { python } from "@codemirror/legacy-modes/mode/python";
import { q } from "@codemirror/legacy-modes/mode/q";
import { r } from "@codemirror/legacy-modes/mode/r";
import { rpmChanges, rpmSpec } from "@codemirror/legacy-modes/mode/rpm";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { sas } from "@codemirror/legacy-modes/mode/sas";
import { sass } from "@codemirror/legacy-modes/mode/sass";
import { scheme } from "@codemirror/legacy-modes/mode/scheme";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { sieve } from "@codemirror/legacy-modes/mode/sieve";
import { smalltalk } from "@codemirror/legacy-modes/mode/smalltalk";
import { solr } from "@codemirror/legacy-modes/mode/solr";
import { sparql } from "@codemirror/legacy-modes/mode/sparql";
import { spreadsheet } from "@codemirror/legacy-modes/mode/spreadsheet";
import {
  cassandra,
  esper,
  gpSQL,
  hive,
  mariaDB,
  msSQL,
  mySQL,
  pgSQL,
  plSQL,
  sparkSQL,
  sqlite,
  standardSQL,
} from "@codemirror/legacy-modes/mode/sql";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { stylus } from "@codemirror/legacy-modes/mode/stylus";
import { tcl } from "@codemirror/legacy-modes/mode/tcl";
import { textile } from "@codemirror/legacy-modes/mode/textile";
import { tiddlyWiki } from "@codemirror/legacy-modes/mode/tiddlywiki";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { troff } from "@codemirror/legacy-modes/mode/troff";
import { ttcn } from "@codemirror/legacy-modes/mode/ttcn";
import { ttcnCfg } from "@codemirror/legacy-modes/mode/ttcn-cfg";
import { turtle } from "@codemirror/legacy-modes/mode/turtle";
import { vb } from "@codemirror/legacy-modes/mode/vb";
import { vbScript } from "@codemirror/legacy-modes/mode/vbscript";
import { velocity } from "@codemirror/legacy-modes/mode/velocity";
import { tlv, verilog } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";
import { wast } from "@codemirror/legacy-modes/mode/wast";
import { webIDL } from "@codemirror/legacy-modes/mode/webidl";
import { xQuery } from "@codemirror/legacy-modes/mode/xquery";
import { yacas } from "@codemirror/legacy-modes/mode/yacas";
import { yaml as yamlMode } from "@codemirror/legacy-modes/mode/yaml";
import { ez80, z80 } from "@codemirror/legacy-modes/mode/z80";
import { parser as jsParser } from "@lezer/javascript";
import { parser as jsonParser } from "@lezer/json";
import { parser as cssParser } from "@lezer/css";
import { parser as cppParser } from "@lezer/cpp";
import { parser as goParser } from "@lezer/go";
import { parser as htmlParser } from "@lezer/html";
import { parser as javaParser } from "@lezer/java";
import { parser as pythonParser } from "@lezer/python";
import { parser as markdownParser } from "@lezer/markdown";
import { parser as phpParser } from "@lezer/php";
import { parser as rustParser } from "@lezer/rust";
import { parser as xmlParser } from "@lezer/xml";
import { parser as yamlParser } from "@lezer/yaml";
import { parser as elixirParser } from "lezer-elixir";
import type { Parser } from "@lezer/common";
import { csharpLanguage } from "./csharp/language.js";
import { astroParser } from "./astro/parser.js";
import { nixLanguage } from "./nix/language.js";
import { parser as svelteBaseParser } from "./svelte/parser.js";
import { configureNesting, defaultNesting } from "./svelte/nesting.js";
import { luauMode } from "./luau/mode.js";

function language(parser: Parser): Language {
  return new Language(defineLanguageFacet(), parser);
}

// Keyed by lowercase file extension. Fence info strings in the app resolve
// through this same table, so bare language names ("shell", "ruby") are
// registered as keys even when no real file uses that extension.
const languagesByExtension: Record<string, Language> = {
  // JavaScript/TypeScript
  js: language(jsParser),
  jsx: language(jsParser.configure({ dialect: "jsx" })),
  ts: language(jsParser.configure({ dialect: "ts" })),
  tsx: language(jsParser.configure({ dialect: "ts jsx" })),
  mjs: language(jsParser),
  cjs: language(jsParser),
  mts: language(jsParser.configure({ dialect: "ts" })),
  cts: language(jsParser.configure({ dialect: "ts" })),
  coffeescript: StreamLanguage.define(coffeeScript),
  coffee: StreamLanguage.define(coffeeScript),
  livescript: StreamLanguage.define(liveScript),
  ls: StreamLanguage.define(liveScript),
  // C / C++ / Objective-C and C-like
  c: language(cppParser),
  h: language(cppParser),
  cc: language(cppParser),
  cpp: language(cppParser),
  cxx: language(cppParser),
  hpp: language(cppParser),
  hxx: language(cppParser),
  hh: language(cppParser),
  m: language(cppParser),
  mm: language(cppParser),
  cu: language(cppParser),
  cuh: language(cppParser),
  ino: language(cppParser),
  objc: StreamLanguage.define(objectiveC),
  objcpp: StreamLanguage.define(objectiveCpp),
  nesc: StreamLanguage.define(nesC),
  nc: StreamLanguage.define(nesC),
  ceylon: StreamLanguage.define(ceylon),
  squirrel: StreamLanguage.define(squirrel),
  nut: StreamLanguage.define(squirrel),
  glsl: StreamLanguage.define(shader),
  vert: StreamLanguage.define(shader),
  frag: StreamLanguage.define(shader),
  geom: StreamLanguage.define(shader),
  comp: StreamLanguage.define(shader),
  tesc: StreamLanguage.define(shader),
  tese: StreamLanguage.define(shader),
  hlsl: StreamLanguage.define(shader),
  fx: StreamLanguage.define(shader),
  wgsl: StreamLanguage.define(shader),
  metal: StreamLanguage.define(shader),
  d: StreamLanguage.define(d),
  di: StreamLanguage.define(d),
  // JSON
  json: language(jsonParser),
  jsonc: language(jsonParser),
  json5: language(jsonParser),
  jsonl: language(jsonParser),
  ndjson: language(jsonParser),
  ipynb: language(jsonParser),
  luaurc: language(jsonParser),
  // CSS
  css: language(cssParser),
  scss: language(cssParser),
  less: language(cssParser),
  sass: StreamLanguage.define(sass),
  stylus: StreamLanguage.define(stylus),
  styl: StreamLanguage.define(stylus),
  // HTML and HTML-templated formats
  html: language(htmlParser),
  htm: language(htmlParser),
  vue: language(htmlParser),
  hbs: language(htmlParser),
  handlebars: language(htmlParser),
  mustache: language(htmlParser),
  twig: language(htmlParser),
  ejs: language(htmlParser),
  eta: language(htmlParser),
  jinja: StreamLanguage.define(jinja2),
  jinja2: StreamLanguage.define(jinja2),
  j2: StreamLanguage.define(jinja2),
  pug: StreamLanguage.define(pug),
  jade: StreamLanguage.define(pug),
  velocity: StreamLanguage.define(velocity),
  vm: StreamLanguage.define(velocity),
  vtl: StreamLanguage.define(velocity),
  // Svelte
  svelte: language(svelteBaseParser.configure({ wrap: configureNesting(defaultNesting) })),
  // Astro
  astro: language(astroParser),
  // XML and XML-based formats
  xml: language(xmlParser),
  svg: language(xmlParser),
  xsd: language(xmlParser),
  xsl: language(xmlParser),
  xslt: language(xmlParser),
  rss: language(xmlParser),
  atom: language(xmlParser),
  plist: language(xmlParser),
  csproj: language(xmlParser),
  fsproj: language(xmlParser),
  vbproj: language(xmlParser),
  vcxproj: language(xmlParser),
  props: language(xmlParser),
  targets: language(xmlParser),
  proj: language(xmlParser),
  xaml: language(xmlParser),
  axaml: language(xmlParser),
  axml: language(xmlParser),
  resx: language(xmlParser),
  wsdl: language(xmlParser),
  nuspec: language(xmlParser),
  filters: language(xmlParser),
  dtd: StreamLanguage.define(dtd),
  hxml: StreamLanguage.define(hxml),
  // Java / JVM
  java: language(javaParser),
  kt: StreamLanguage.define(kotlin),
  kts: StreamLanguage.define(kotlin),
  kotlin: StreamLanguage.define(kotlin),
  scala: StreamLanguage.define(scala),
  sc: StreamLanguage.define(scala),
  groovy: StreamLanguage.define(groovy),
  gvy: StreamLanguage.define(groovy),
  gradle: StreamLanguage.define(groovy),
  jenkinsfile: StreamLanguage.define(groovy),
  // Python and Python-adjacent
  py: language(pythonParser),
  pyw: language(pythonParser),
  pyi: language(pythonParser),
  bzl: language(pythonParser),
  star: language(pythonParser),
  starlark: language(pythonParser),
  bazel: language(pythonParser),
  pyx: StreamLanguage.define(python),
  pxd: StreamLanguage.define(python),
  cython: StreamLanguage.define(python),
  vy: StreamLanguage.define(python),
  vyper: StreamLanguage.define(python),
  // Go
  go: language(goParser),
  // PHP
  php: language(phpParser),
  phtml: language(phpParser),
  php5: language(phpParser),
  // YAML
  yaml: language(yamlParser),
  yml: language(yamlParser),
  yamlfrontmatter: StreamLanguage.define(yamlMode),
  // Rust
  rs: language(rustParser),
  ron: language(rustParser),
  // Swift
  swift: StreamLanguage.define(swift),
  // Dart
  dart: StreamLanguage.define(dart),
  // C#
  cs: csharpLanguage,
  csx: csharpLanguage,
  cake: csharpLanguage,
  // F# / OCaml / SML
  fs: StreamLanguage.define(fSharp),
  fsx: StreamLanguage.define(fSharp),
  fsi: StreamLanguage.define(fSharp),
  fsharp: StreamLanguage.define(fSharp),
  ml: StreamLanguage.define(oCaml),
  mli: StreamLanguage.define(oCaml),
  ocaml: StreamLanguage.define(oCaml),
  sml: StreamLanguage.define(sml),
  sig: StreamLanguage.define(sml),
  fun: StreamLanguage.define(sml),
  // Nix
  nix: nixLanguage,
  // Elixir / Erlang
  ex: language(elixirParser),
  exs: language(elixirParser),
  heex: language(elixirParser),
  eex: language(elixirParser),
  erl: StreamLanguage.define(erlang),
  hrl: StreamLanguage.define(erlang),
  erlang: StreamLanguage.define(erlang),
  // Lua / Luau
  lua: StreamLanguage.define(luauMode),
  luau: StreamLanguage.define(luauMode),
  // Shell
  sh: StreamLanguage.define(shell),
  bash: StreamLanguage.define(shell),
  zsh: StreamLanguage.define(shell),
  ksh: StreamLanguage.define(shell),
  mksh: StreamLanguage.define(shell),
  ash: StreamLanguage.define(shell),
  dash: StreamLanguage.define(shell),
  fish: StreamLanguage.define(shell),
  shell: StreamLanguage.define(shell),
  command: StreamLanguage.define(shell),
  bashrc: StreamLanguage.define(shell),
  zshrc: StreamLanguage.define(shell),
  zprofile: StreamLanguage.define(shell),
  zshenv: StreamLanguage.define(shell),
  bash_profile: StreamLanguage.define(shell),
  bash_aliases: StreamLanguage.define(shell),
  profile: StreamLanguage.define(shell),
  ebuild: StreamLanguage.define(shell),
  eclass: StreamLanguage.define(shell),
  pkgbuild: StreamLanguage.define(shell),
  apkbuild: StreamLanguage.define(shell),
  // Makefiles and build recipes (closest available mode)
  mk: StreamLanguage.define(shell),
  mak: StreamLanguage.define(shell),
  makefile: StreamLanguage.define(shell),
  gmk: StreamLanguage.define(shell),
  just: StreamLanguage.define(shell),
  justfile: StreamLanguage.define(shell),
  // PowerShell / batch-adjacent
  ps1: StreamLanguage.define(powerShell),
  psm1: StreamLanguage.define(powerShell),
  psd1: StreamLanguage.define(powerShell),
  powershell: StreamLanguage.define(powerShell),
  pssc: StreamLanguage.define(powerShell),
  // Perl / Raku
  pl: StreamLanguage.define(perl),
  pm: StreamLanguage.define(perl),
  perl: StreamLanguage.define(perl),
  pod: StreamLanguage.define(perl),
  t: StreamLanguage.define(perl),
  raku: StreamLanguage.define(perl),
  rakumod: StreamLanguage.define(perl),
  p6: StreamLanguage.define(perl),
  pl6: StreamLanguage.define(perl),
  // Ruby
  rb: StreamLanguage.define(ruby),
  rbw: StreamLanguage.define(ruby),
  ruby: StreamLanguage.define(ruby),
  rake: StreamLanguage.define(ruby),
  gemspec: StreamLanguage.define(ruby),
  rakefile: StreamLanguage.define(ruby),
  gemfile: StreamLanguage.define(ruby),
  vagrantfile: StreamLanguage.define(ruby),
  podspec: StreamLanguage.define(ruby),
  // TOML
  toml: StreamLanguage.define(toml),
  // SQL dialects
  sql: StreamLanguage.define(standardSQL),
  mysql: StreamLanguage.define(mySQL),
  mariadb: StreamLanguage.define(mariaDB),
  pgsql: StreamLanguage.define(pgSQL),
  postgresql: StreamLanguage.define(pgSQL),
  plsql: StreamLanguage.define(plSQL),
  pls: StreamLanguage.define(plSQL),
  pck: StreamLanguage.define(plSQL),
  pkb: StreamLanguage.define(plSQL),
  pks: StreamLanguage.define(plSQL),
  mssql: StreamLanguage.define(msSQL),
  tsql: StreamLanguage.define(msSQL),
  sqlite: StreamLanguage.define(sqlite),
  sqlite3: StreamLanguage.define(sqlite),
  cql: StreamLanguage.define(cassandra),
  cassandra: StreamLanguage.define(cassandra),
  hql: StreamLanguage.define(hive),
  hive: StreamLanguage.define(hive),
  sparksql: StreamLanguage.define(sparkSQL),
  esper: StreamLanguage.define(esper),
  greenplum: StreamLanguage.define(gpSQL),
  gpsql: StreamLanguage.define(gpSQL),
  // Diff / patch
  diff: StreamLanguage.define(diff),
  patch: StreamLanguage.define(diff),
  rej: StreamLanguage.define(diff),
  // Docker / containers
  dockerfile: StreamLanguage.define(dockerFile),
  containerfile: StreamLanguage.define(dockerFile),
  dockerignore: StreamLanguage.define(dockerFile),
  // CMake
  cmake: StreamLanguage.define(cmake),
  // INI / properties / dotenv / config
  ini: StreamLanguage.define(properties),
  cfg: StreamLanguage.define(properties),
  conf: StreamLanguage.define(properties),
  properties: StreamLanguage.define(properties),
  editorconfig: StreamLanguage.define(properties),
  env: StreamLanguage.define(properties),
  npmrc: StreamLanguage.define(properties),
  yarnrc: StreamLanguage.define(properties),
  gitconfig: StreamLanguage.define(properties),
  gitmodules: StreamLanguage.define(properties),
  gitattributes: StreamLanguage.define(properties),
  gitignore: StreamLanguage.define(properties),
  ignore: StreamLanguage.define(properties),
  dockerignorefile: StreamLanguage.define(properties),
  hgrc: StreamLanguage.define(properties),
  coveragerc: StreamLanguage.define(properties),
  pylintrc: StreamLanguage.define(properties),
  flake8: StreamLanguage.define(properties),
  inf: StreamLanguage.define(properties),
  service: StreamLanguage.define(properties),
  socket: StreamLanguage.define(properties),
  timer: StreamLanguage.define(properties),
  mount: StreamLanguage.define(properties),
  automount: StreamLanguage.define(properties),
  slice: StreamLanguage.define(properties),
  scope: StreamLanguage.define(properties),
  netdev: StreamLanguage.define(properties),
  network: StreamLanguage.define(properties),
  link: StreamLanguage.define(properties),
  nspawn: StreamLanguage.define(properties),
  swap: StreamLanguage.define(properties),
  desktop: StreamLanguage.define(properties),
  directory: StreamLanguage.define(properties),
  reg: StreamLanguage.define(properties),
  tf: StreamLanguage.define(properties),
  tfvars: StreamLanguage.define(properties),
  hcl: StreamLanguage.define(properties),
  // Nginx
  nginx: StreamLanguage.define(nginx),
  nginxconf: StreamLanguage.define(nginx),
  // HTTP
  http: StreamLanguage.define(http),
  rest: StreamLanguage.define(http),
  // Protobuf / IDL
  proto: StreamLanguage.define(protobuf),
  protobuf: StreamLanguage.define(protobuf),
  protodevel: StreamLanguage.define(protobuf),
  idl: StreamLanguage.define(idl),
  webidl: StreamLanguage.define(webIDL),
  widl: StreamLanguage.define(webIDL),
  // Gherkin / Cucumber
  feature: StreamLanguage.define(gherkin),
  gherkin: StreamLanguage.define(gherkin),
  // Assembly
  asm: StreamLanguage.define(gas),
  s: StreamLanguage.define(gas),
  nasm: StreamLanguage.define(gas),
  gas: StreamLanguage.define(gas),
  arm: StreamLanguage.define(gasArm),
  z80: StreamLanguage.define(z80),
  ez80: StreamLanguage.define(ez80),
  // HDL
  v: StreamLanguage.define(verilog),
  vh: StreamLanguage.define(verilog),
  sv: StreamLanguage.define(verilog),
  svh: StreamLanguage.define(verilog),
  verilog: StreamLanguage.define(verilog),
  tlv: StreamLanguage.define(tlv),
  vhd: StreamLanguage.define(vhdl),
  vhdl: StreamLanguage.define(vhdl),
  // Lisps
  clj: StreamLanguage.define(clojure),
  cljs: StreamLanguage.define(clojure),
  cljc: StreamLanguage.define(clojure),
  cljx: StreamLanguage.define(clojure),
  clojure: StreamLanguage.define(clojure),
  edn: StreamLanguage.define(clojure),
  bb: StreamLanguage.define(clojure),
  lisp: StreamLanguage.define(commonLisp),
  lsp: StreamLanguage.define(commonLisp),
  cl: StreamLanguage.define(commonLisp),
  el: StreamLanguage.define(commonLisp),
  commonlisp: StreamLanguage.define(commonLisp),
  scm: StreamLanguage.define(scheme),
  ss: StreamLanguage.define(scheme),
  rkt: StreamLanguage.define(scheme),
  scheme: StreamLanguage.define(scheme),
  // Functional
  hs: StreamLanguage.define(haskell),
  lhs: StreamLanguage.define(haskell),
  haskell: StreamLanguage.define(haskell),
  elm: StreamLanguage.define(elm),
  cr: StreamLanguage.define(crystal),
  crystal: StreamLanguage.define(crystal),
  jl: StreamLanguage.define(julia),
  julia: StreamLanguage.define(julia),
  // JVM-adjacent scripting
  hx: StreamLanguage.define(haxe),
  haxe: StreamLanguage.define(haxe),
  // Scientific / math
  r: StreamLanguage.define(r),
  rhistory: StreamLanguage.define(r),
  rprofile: StreamLanguage.define(r),
  rt: StreamLanguage.define(r),
  rd: StreamLanguage.define(r),
  rmd: language(markdownParser),
  qmd: language(markdownParser),
  octave: StreamLanguage.define(octave),
  matlab: StreamLanguage.define(octave),
  wl: StreamLanguage.define(mathematica),
  wls: StreamLanguage.define(mathematica),
  mathematica: StreamLanguage.define(mathematica),
  nb: StreamLanguage.define(mathematica),
  mma: StreamLanguage.define(mathematica),
  sas: StreamLanguage.define(sas),
  q: StreamLanguage.define(q),
  // TeX / typesetting
  tex: StreamLanguage.define(stex),
  sty: StreamLanguage.define(stex),
  cls: StreamLanguage.define(stex),
  latex: StreamLanguage.define(stex),
  ltx: StreamLanguage.define(stex),
  dtx: StreamLanguage.define(stex),
  ins: StreamLanguage.define(stex),
  bbx: StreamLanguage.define(stex),
  cbx: StreamLanguage.define(stex),
  stex: StreamLanguage.define(stex),
  troff: StreamLanguage.define(troff),
  roff: StreamLanguage.define(troff),
  man: StreamLanguage.define(troff),
  me: StreamLanguage.define(troff),
  ms: StreamLanguage.define(troff),
  // Pascal / BASIC family
  pas: StreamLanguage.define(pascal),
  pp: StreamLanguage.define(pascal),
  dpr: StreamLanguage.define(pascal),
  lpr: StreamLanguage.define(pascal),
  pascal: StreamLanguage.define(pascal),
  vb: StreamLanguage.define(vb),
  bas: StreamLanguage.define(vb),
  vbs: StreamLanguage.define(vbScript),
  vbscript: StreamLanguage.define(vbScript),
  vba: StreamLanguage.define(vbScript),
  frm: StreamLanguage.define(vb),
  // Systems / other compiled
  f: StreamLanguage.define(fortran),
  for: StreamLanguage.define(fortran),
  ftn: StreamLanguage.define(fortran),
  f77: StreamLanguage.define(fortran),
  f90: StreamLanguage.define(fortran),
  f95: StreamLanguage.define(fortran),
  f03: StreamLanguage.define(fortran),
  f08: StreamLanguage.define(fortran),
  fortran: StreamLanguage.define(fortran),
  cob: StreamLanguage.define(cobol),
  cbl: StreamLanguage.define(cobol),
  cpy: StreamLanguage.define(cobol),
  cobol: StreamLanguage.define(cobol),
  st: StreamLanguage.define(smalltalk),
  smalltalk: StreamLanguage.define(smalltalk),
  forth: StreamLanguage.define(forth),
  fth: StreamLanguage.define(forth),
  "4th": StreamLanguage.define(forth),
  e: StreamLanguage.define(eiffel),
  eiffel: StreamLanguage.define(eiffel),
  mo: StreamLanguage.define(modelica),
  mos: StreamLanguage.define(modelica),
  modelica: StreamLanguage.define(modelica),
  dylan: StreamLanguage.define(dylan),
  dyl: StreamLanguage.define(dylan),
  ecl: StreamLanguage.define(ecl),
  oz: StreamLanguage.define(oz),
  pig: StreamLanguage.define(pig),
  tcl: StreamLanguage.define(tcl),
  tbc: StreamLanguage.define(tcl),
  // Query / semantic
  cypher: StreamLanguage.define(cypher),
  cyp: StreamLanguage.define(cypher),
  sparql: StreamLanguage.define(sparql),
  rq: StreamLanguage.define(sparql),
  ttl: StreamLanguage.define(turtle),
  turtle: StreamLanguage.define(turtle),
  nt: StreamLanguage.define(ntriples),
  ntriples: StreamLanguage.define(ntriples),
  xq: StreamLanguage.define(xQuery),
  xqy: StreamLanguage.define(xQuery),
  xquery: StreamLanguage.define(xQuery),
  xqm: StreamLanguage.define(xQuery),
  xql: StreamLanguage.define(xQuery),
  xqs: StreamLanguage.define(xQuery),
  xqu: StreamLanguage.define(xQuery),
  xqueryfile: StreamLanguage.define(xQuery),
  solr: StreamLanguage.define(solr),
  // WebAssembly text
  wat: StreamLanguage.define(wast),
  wast: StreamLanguage.define(wast),
  // Grammars / notations
  ebnf: StreamLanguage.define(ebnf),
  bnf: StreamLanguage.define(ebnf),
  pegjs: StreamLanguage.define(pegjs),
  peg: StreamLanguage.define(pegjs),
  asn: StreamLanguage.define(asn1({})),
  asn1: StreamLanguage.define(asn1({})),
  // Packaging / install scripts
  spec: StreamLanguage.define(rpmSpec),
  rpm: StreamLanguage.define(rpmSpec),
  rpmchanges: StreamLanguage.define(rpmChanges),
  nsi: StreamLanguage.define(nsis),
  nsh: StreamLanguage.define(nsis),
  nsis: StreamLanguage.define(nsis),
  ppuppet: StreamLanguage.define(puppet),
  puppet: StreamLanguage.define(puppet),
  // Misc legacy modes
  apl: StreamLanguage.define(apl),
  asciiarmor: StreamLanguage.define(asciiArmor),
  asc: StreamLanguage.define(asciiArmor),
  pgp: StreamLanguage.define(asciiArmor),
  sig2: StreamLanguage.define(asciiArmor),
  asterisk: StreamLanguage.define(asterisk),
  brainfuck: StreamLanguage.define(brainfuck),
  bf: StreamLanguage.define(brainfuck),
  b: StreamLanguage.define(brainfuck),
  factor: StreamLanguage.define(factor),
  fcl: StreamLanguage.define(fcl),
  mrc: StreamLanguage.define(mirc),
  mirc: StreamLanguage.define(mirc),
  mbox: StreamLanguage.define(mbox),
  eml: StreamLanguage.define(mbox),
  mscgen: StreamLanguage.define(mscgen),
  msc: StreamLanguage.define(mscgen),
  msgenny: StreamLanguage.define(msgenny),
  xu: StreamLanguage.define(xu),
  mumps: StreamLanguage.define(mumps),
  sieve: StreamLanguage.define(sieve),
  siv: StreamLanguage.define(sieve),
  textile: StreamLanguage.define(textile),
  tid: StreamLanguage.define(tiddlyWiki),
  tiddlywiki: StreamLanguage.define(tiddlyWiki),
  ttcn: StreamLanguage.define(ttcn),
  ttcn3: StreamLanguage.define(ttcn),
  ttcncfg: StreamLanguage.define(ttcnCfg),
  yacas: StreamLanguage.define(yacas),
  ys: StreamLanguage.define(yacas),
  spreadsheet: StreamLanguage.define(spreadsheet),
  // Markdown
  md: language(markdownParser),
  mdx: language(markdownParser),
  markdown: language(markdownParser),
  mdown: language(markdownParser),
  mkd: language(markdownParser),
  mkdn: language(markdownParser),
};

// Exact basenames for extensionless or conventionally-named files.
const languagesByBasename: Record<string, Language> = {
  dockerfile: StreamLanguage.define(dockerFile),
  containerfile: StreamLanguage.define(dockerFile),
  "cmakelists.txt": StreamLanguage.define(cmake),
  makefile: StreamLanguage.define(shell),
  gnumakefile: StreamLanguage.define(shell),
  justfile: StreamLanguage.define(shell),
  rakefile: StreamLanguage.define(ruby),
  gemfile: StreamLanguage.define(ruby),
  vagrantfile: StreamLanguage.define(ruby),
  brewfile: StreamLanguage.define(ruby),
  podfile: StreamLanguage.define(ruby),
  fastfile: StreamLanguage.define(ruby),
  jenkinsfile: StreamLanguage.define(groovy),
  pkgbuild: StreamLanguage.define(shell),
  apkbuild: StreamLanguage.define(shell),
  sconstruct: language(pythonParser),
  sconscript: language(pythonParser),
  wscript: language(pythonParser),
  snakefile: language(pythonParser),
  build: language(pythonParser),
  "build.bazel": language(pythonParser),
  "workspace.bazel": language(pythonParser),
  workspace: language(pythonParser),
  "module.bazel": language(pythonParser),
  "cargo.lock": StreamLanguage.define(toml),
  pipfile: StreamLanguage.define(toml),
  "poetry.lock": StreamLanguage.define(toml),
  "gopkg.lock": StreamLanguage.define(toml),
  "go.mod": StreamLanguage.define(properties),
  "go.sum": StreamLanguage.define(properties),
  ".bashrc": StreamLanguage.define(shell),
  ".zshrc": StreamLanguage.define(shell),
  ".zprofile": StreamLanguage.define(shell),
  ".zshenv": StreamLanguage.define(shell),
  ".zlogin": StreamLanguage.define(shell),
  ".bash_profile": StreamLanguage.define(shell),
  ".bash_aliases": StreamLanguage.define(shell),
  ".bash_logout": StreamLanguage.define(shell),
  ".profile": StreamLanguage.define(shell),
  ".xprofile": StreamLanguage.define(shell),
  ".kshrc": StreamLanguage.define(shell),
  ".env": StreamLanguage.define(properties),
  ".gitignore": StreamLanguage.define(properties),
  ".gitattributes": StreamLanguage.define(properties),
  ".gitmodules": StreamLanguage.define(properties),
  ".gitconfig": StreamLanguage.define(properties),
  ".dockerignore": StreamLanguage.define(properties),
  ".editorconfig": StreamLanguage.define(properties),
  ".npmrc": StreamLanguage.define(properties),
  ".yarnrc": StreamLanguage.define(properties),
  ".hgrc": StreamLanguage.define(properties),
  ".luaurc": language(jsonParser),
  ".prettierrc": language(jsonParser),
  ".eslintrc": language(jsonParser),
  ".babelrc": language(jsonParser),
  license: StreamLanguage.define(properties),
};

// Prefix rules for families like Dockerfile.dev / Makefile.am / .env.local.
const basenamePrefixes: Array<[string, Language]> = [
  ["dockerfile", StreamLanguage.define(dockerFile)],
  ["containerfile", StreamLanguage.define(dockerFile)],
  ["makefile", StreamLanguage.define(shell)],
  [".env", StreamLanguage.define(properties)],
  [".gitignore", StreamLanguage.define(properties)],
];

export function getLanguageForFile(filename: string): Language | null {
  const base = filename.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const exact = languagesByBasename[base];
  if (exact) return exact;
  for (const [prefix, lang] of basenamePrefixes) {
    if (base.startsWith(prefix)) return lang;
  }
  const ext = base.split(".").pop();
  if (!ext || ext === base) return null;
  return languagesByExtension[ext] ?? null;
}

export function getParserForFile(filename: string): Parser | null {
  return getLanguageForFile(filename)?.parser ?? null;
}

export function isLanguageSupported(filename: string): boolean {
  return getParserForFile(filename) !== null;
}

export function getSupportedExtensions(): string[] {
  return Object.keys(languagesByExtension);
}
