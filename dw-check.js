#!/usr/bin/env node

/**
 * dw-check — Validate DataWeave 2.x scripts via the MuleSoft Playground public API.
 *
 * Usage:
 *   node dw-check.js <script.dwl> [--input name=file.json ...]
 *   node dw-check.js --inline "%dw 2.0 ..." [--input name=file.json ...]
 *   node dw-check.js <script.dwl> --only-syntax
 *   node dw-check.js <script.dwl> --json
 *
 * Examples:
 *   node dw-check.js my-script.dwl
 *   node dw-check.js my-script.dwl --input payload=data.json
 *   node dw-check.js my-script.dwl --input payload=data.json --input vars=vars.json
 *   node dw-check.js --inline "%dw 2.0\noutput json\n---\n{ a: 1 }"
 *   node dw-check.js my-script.dwl --json > result.json
 */

"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// ─── Constantes ───────────────────────────────────────────────────────────────

const API_ORIGIN = "https://dataweave.mulesoft.com";
const API_PATH = "/transform";
const MAIN_FILE = "main.dwl";

// ─── Utilidades ───────────────────────────────────────────────────────────────

function die(msg, code = 1) {
  console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(code);
}

function warn(msg) {
  console.error(`\x1b[33mwarning:\x1b[0m ${msg}`);
}

function dim(msg) {
  console.error(`\x1b[2m${msg}\x1b[0m`);
}

// ─── Import parsing ─────────────────────────────────────────────────────────

/**
 * Parseia uma linha de import DataWeave.
 * Formatos suportados:
 *   import func1, func2 from modulo::path
 *   import * from modulo::path
 *
 * Retorna null se a linha não for um import.
 */
function parseImportLine(line) {
  const trimmed = line.trim();
  // Remove comentários trailing (// ...)
  const clean = trimmed.replace(/\s*\/\/.*$/, "");
  const match = clean.match(/^import\s+(\*|[\w\s,]+)\s+from\s+([\w:]+)/);
  if (!match) return null;

  const rawFunctions = match[1].trim();
  const modulePath = match[2].trim();
  const wildcard = rawFunctions === "*";

  const functions = wildcard
    ? []
    : rawFunctions.split(/\s*,\s*/).map(function (s) { return s.trim(); }).filter(Boolean);

  return { functions: functions, module: modulePath, wildcard: wildcard };
}

// ─── Module resolution ────────────────────────────────────────────────────

/**
 * Converte um path de módulo DataWeave (mod::sub::name) para caminho de
 * arquivo .dwl e busca nos diretórios de resources fornecidos.
 *
 * Retorna o path absoluto do primeiro arquivo encontrado, ou null.
 */
function resolveModuleFile(modulePath, resourcesDirs) {
  // Converte modules::utils::helpers → modules/utils/helpers.dwl
  var filePath = modulePath.replace(/::/g, "/") + ".dwl";

  for (var i = 0; i < resourcesDirs.length; i++) {
    var fullPath = path.resolve(resourcesDirs[i], filePath);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

// ─── Function extraction ───────────────────────────────────────────────────

/**
 * Extrai definições de funções de um conteúdo .dwl.
 *
 * Cada função vai da linha "fun nome(" até antes do próximo "fun " no
 * top-level (mesma indentação) ou EOF. O header do arquivo (%dw, output,
 * diretivas) é ignorado.
 *
 * - wildcard: extrai todas as funções encontradas
 * - functionNames explícito: extrai só as listadas; die() se faltar alguma
 *
 * Retorna { functions: Map<name, code>, ranges: Map<name, {start, end}> }
 * onde start/end são números de linha 1-indexed (inclusive) no conteúdo
 * original (dwlContent) — usados para rastrear a origem de cada linha
 * após injeção de imports.
 */
function extractFunctions(dwlContent, functionNames, wildcard, fileLabel) {
  var lines = dwlContent.split("\n");
  var funRegex = /^(\s*)fun\s+(\w+)\s*\(/;
  var funStarts = [];

  // Encontra todas as definições de função
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(funRegex);
    if (match) {
      funStarts.push({ line: i, name: match[2], indent: match[1].length });
    }
  }

  if (funStarts.length === 0) {
    if (wildcard) return { functions: new Map(), ranges: new Map() };
    die("no functions found in " + fileLabel);
  }

  var functions = new Map();
  var ranges = new Map(); // name → { start: 1-indexed, end: 1-indexed }

  for (var j = 0; j < funStarts.length; j++) {
    var start = funStarts[j];
    var end = (j + 1 < funStarts.length) ? funStarts[j + 1].line : lines.length;

    // Pula funções não solicitadas (modo nomeado)
    if (!wildcard && functionNames.indexOf(start.name) === -1) continue;

    // Track original range antes do trim (0-indexed)
    var origStart = start.line;
    var origEnd = end; // exclusive

    // Extrai linhas [origStart, origEnd)
    var funLines = lines.slice(origStart, origEnd);

    // Remove linhas vazias do final
    while (funLines.length > 0 && funLines[funLines.length - 1].trim() === "") {
      funLines.pop();
      origEnd--;
    }

    // Remove linhas vazias do início da função (entre funções)
    while (funLines.length > 0 && funLines[0].trim() === "") {
      funLines.shift();
      origStart++;
    }

    functions.set(start.name, funLines.join("\n"));
    ranges.set(start.name, { start: origStart + 1, end: origEnd }); // 1-indexed inclusive
  }

  // Verifica funções faltantes no modo nomeado
  if (!wildcard) {
    for (var k = 0; k < functionNames.length; k++) {
      var name = functionNames[k];
      if (!functions.has(name)) {
        die("function '" + name + "' not found in " + fileLabel);
      }
    }
  }

  return { functions: functions, ranges: ranges };
}

// ─── Import resolution orchestrator ──────────────────────────────────────────

/**
 * Resolve todos os imports em um script DataWeave recursivamente.
 *
 * Para cada linha de import encontrada:
 * 1. Localiza o arquivo .dwl nos diretórios de resources
 * 2. Detecta imports circulares (via visited set)
 * 3. Resolve recursivamente imports dentro do arquivo importado
 * 4. Extrai as funções solicitadas do arquivo resolvido
 * 5. Substitui a linha de import pelo código fonte das funções
 * 6. Adiciona comentário de marcação // @dw-import: <file>
 * 7. Constrói lineMap para rastrear arquivo e linha de origem de cada linha
 *
 * Retorna { script, lineMap } onde:
 *   - script: conteúdo modificado (pronto para enviar à API)
 *   - lineMap: array onde lineMap[modifiedLineIdx] = { file, line }
 *     com file = caminho do arquivo fonte e line = número da linha (1-indexed)
 */
function resolveImports(scriptContent, resourcesDirs, visited, sourceFile) {
  if (!visited) visited = new Set();

  var lines = scriptContent.split("\n");
  var importMap = new Map(); // lineIndex → { blockLines: [{code, sourceFile, sourceLine}] }

  // Coleta imports dw:: do script atual para evitar duplicação na re-emissão
  var mainDwImports = [];
  for (var mi = 0; mi < lines.length; mi++) {
    var ml = lines[mi].trim();
    if (/^import\s+.*\s+from\s+dw::/.test(ml)) {
      mainDwImports.push(ml);
    }
  }

  // Primeira passagem: identifica e resolve todos os imports
  for (var i = 0; i < lines.length; i++) {
    var parsed = parseImportLine(lines[i]);
    if (!parsed) continue;

    // Skip built-in dw::* modules — they are available in the DataWeave runtime
    if (/^dw::/.test(parsed.module)) {
      continue;
    }

    // Resolve o arquivo do módulo
    var moduleFile = resolveModuleFile(parsed.module, resourcesDirs);
    if (!moduleFile) {
      die("module '" + parsed.module + "' not found in resources paths: " + resourcesDirs.join(", "));
    }

    // Detecta import circular
    if (visited.has(moduleFile)) {
      var chain = [];
      visited.forEach(function (v) { chain.push(v); });
      chain.push(moduleFile);
      die("circular import detected: " + chain.join(" → "));
    }

    // Lê o arquivo
    var dwlContent;
    try {
      dwlContent = fs.readFileSync(moduleFile, "utf-8");
    } catch (err) {
      die("could not read module '" + moduleFile + "': " + err.message);
    }

    // Resolve recursivamente os imports do arquivo dependente
    var visitedCopy = new Set(visited);
    visitedCopy.add(moduleFile);
    var resolved = resolveImports(dwlContent, resourcesDirs, visitedCopy, moduleFile);

    // Coleta imports dw:: do módulo resolvido para re-emitir (com tracking de linha)
    var dwImportEntries = []; // [{code, sourceLine}] — sourceLine é 1-indexed em resolved.script
    var resolvedLines = resolved.script.split("\n");
    for (var ri = 0; ri < resolvedLines.length; ri++) {
      var rl = resolvedLines[ri].trim();
      if (/^import\s+.*\s+from\s+dw::/.test(rl)) {
        var alreadyInMain = mainDwImports.indexOf(rl) !== -1;
        var alreadyCollected = dwImportEntries.some(function (e) { return e.code === rl; });
        if (!alreadyInMain && !alreadyCollected) {
          dwImportEntries.push({ code: rl, sourceLine: ri + 1 }); // 1-indexed
        }
      }
    }

    // Extrai TODAS as funções do módulo resolvido (não só as solicitadas),
    // pois dependências transitivas já foram inlineadas em resolved.script.
    var extractResult = extractFunctions(
      resolved.script,
      [],
      true,
      moduleFile
    );

    // Valida que as funções explicitamente solicitadas existem
    if (!parsed.wildcard) {
      for (var k = 0; k < parsed.functions.length; k++) {
        if (!extractResult.functions.has(parsed.functions[k])) {
          die("function '" + parsed.functions[k] + "' not found in " + moduleFile);
        }
      }
    }

    // Constrói blockLines: array de {code, sourceFile, sourceLine} para cada linha injetada
    var blockLines = [];

    // 1. Linhas de dw:: import do módulo
    for (var di = 0; di < dwImportEntries.length; di++) {
      var entry = dwImportEntries[di];
      var dwSrc = resolved.lineMap[entry.sourceLine - 1];
      blockLines.push({
        code: entry.code,
        sourceFile: dwSrc ? dwSrc.file : moduleFile,
        sourceLine: dwSrc ? dwSrc.line : entry.sourceLine
      });
    }

    // 2. Comentário de marcação — aponta para a linha do import no arquivo pai
    var markerComment = "// @dw-import: " + moduleFile;
    blockLines.push({
      code: markerComment,
      sourceFile: sourceFile || "<main>",
      sourceLine: i + 1 // linha do import no script atual (1-indexed)
    });

    // 3. Código das funções extraídas — cada linha rastreia sua origem via resolved.lineMap
    extractResult.functions.forEach(function (code, name) {
      var range = extractResult.ranges.get(name);
      var funCodeLines = code.split("\n");
      for (var fl = 0; fl < funCodeLines.length; fl++) {
        var resolvedLineNum = range.start + fl; // 1-indexed em resolved.script
        var src = resolved.lineMap[resolvedLineNum - 1];
        blockLines.push({
          code: funCodeLines[fl],
          sourceFile: src ? src.file : moduleFile,
          sourceLine: src ? src.line : resolvedLineNum
        });
      }
    });

    importMap.set(i, blockLines);
  }

  // Segunda passagem: constrói o script modificado e o lineMap
  var modifiedLines = [];
  var lineMap = []; // 0-indexed: modifiedLineIndex → { file, line }

  for (var i = 0; i < lines.length; i++) {
    var blockLines = importMap.get(i);

    if (blockLines !== undefined) {
      for (var c = 0; c < blockLines.length; c++) {
        var bl = blockLines[c];
        modifiedLines.push(bl.code);
        lineMap.push({ file: bl.sourceFile, line: bl.sourceLine });
      }
    } else {
      modifiedLines.push(lines[i]);
      lineMap.push({ file: sourceFile || "<main>", line: i + 1 });
    }
  }

  return { script: modifiedLines.join("\n"), lineMap: lineMap };
}

// ─── Error location adjustment ──────────────────────────────────────────────

/**
 * Ajusta os números de linha e source identifier em um erro da API do
 * DataWeave Playground para refletir o script original (antes da injeção
 * de imports).
 *
 * Usa o lineMap produzido por resolveImports:
 *   lineMap[modifiedLineIndex] = { file, line }
 *
 * O objeto error é modificado in-place.
 */
function adjustErrorLocation(error, lineMap) {
  if (!error || !error.location || !error.location.start) return error;

  var modifiedLine = error.location.start.line;
  var mapping = lineMap[modifiedLine - 1]; // 0-indexed lookup

  if (mapping != null) {
    error.location.start.line = mapping.line;
    // Atualiza o source identifier para o arquivo real de origem
    if (mapping.file && mapping.file !== "<main>") {
      error.location.sourceIdentifier = mapping.file;
    }
    if (error.location.end && error.location.end.line) {
      var endModified = error.location.end.line;
      var endMapping = lineMap[endModified - 1];
      error.location.end.line = endMapping ? endMapping.line : mapping.line;
    }
  }

  return error;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function postJSON(urlString, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = JSON.stringify(body);
    const transport = url.protocol === "https:" ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers,
      },
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          const data = JSON.parse(raw);
          resolve({ status: res.statusCode, data });
        } catch (_err) {
          resolve({ status: res.statusCode, data: raw });
        }
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("Timeout after 30s"));
    });

    req.write(payload);
    req.end();
  });
}

// ─── Parsing de argumentos ────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    script: null,
    inline: null,
    inputs: {},        // nome -> conteúdo string
    inputPaths: {},    // nome -> path original (para detectar MIME type)
    syntaxOnly: false,
    jsonOutput: false,
    showOutput: false,
    silent: false,
    agentMode: false,
    resources: [],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--inline" || arg === "-i") {
      result.inline = args[++i];
      if (!result.inline) die("Missing script after --inline");
      // Expande escapes comuns do shell (\\n, \\t, \\r)
      result.inline = result.inline
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r");
      i++;
      continue;
    }

    if (arg === "--input" || arg === "-in") {
      const raw = args[++i];
      if (!raw) die("Missing value after --input. Use: --input name=file.json");
      const eqIdx = raw.indexOf("=");
      if (eqIdx === -1) die(`Invalid format for --input "${raw}". Use: name=file.json`);
      const name = raw.slice(0, eqIdx);
      const filePath = raw.slice(eqIdx + 1);
      try {
        result.inputs[name] = fs.readFileSync(filePath, "utf-8");
        result.inputPaths[name] = filePath;
        dim(`input "${name}" ← ${filePath}`);
      } catch (err) {
        die(`Could not read input file "${filePath}": ${err.message}`);
      }
      i++;
      continue;
    }

    if (arg === "--only-syntax" || arg === "-s") {
      result.syntaxOnly = true;
      i++;
      continue;
    }

    if (arg === "--json" || arg === "-j") {
      result.jsonOutput = true;
      i++;
      continue;
    }

    if (arg === "--output" || arg === "-o") {
      result.showOutput = true;
      i++;
      continue;
    }

    if (arg === "--silent" || arg === "-q") {
      result.silent = true;
      i++;
      continue;
    }

    if (arg === "--agent") {
      result.agentMode = true;
      i++;
      continue;
    }

    if (arg === "--resources" || arg === "-r") {
      var resPath = args[++i];
      if (!resPath) die("Missing path after --resources");
      result.resources.push(resPath);
      dim("resources ← " + resPath);
      i++;
      continue;
    }

    // Assume que é o arquivo de script
    if (!result.script && !arg.startsWith("-")) {
      result.script = arg;
      i++;
      continue;
    }

    die(`Unknown argument: ${arg}`);
  }

  return result;
}

function printHelp() {
  console.log(`
\x1b[1mdw-check\x1b[0m — Validate DataWeave 2.x scripts

\x1b[1mUsage:\x1b[0m
  dw-check <script.dwl> [options]
  dw-check --inline "<script>" [options]

\x1b[1mOptions:\x1b[0m
  --input, -in <name=file>      Add an input (payload, vars, etc.)
                                 Can be used multiple times.
                                 Ex: --input payload=data.json
  --only-syntax, -s              Only check syntax (ignore input-related errors
                                 like missing payload/vars)
  --output, -o                  Show transformation output on success
  --json, -j                    JSON output (ideal for CI/CD)
  --silent, -q                  No stdout on success (status code only)
  --agent                       AI agent-optimized output (JSON with context,
                                error code snippets, and fix suggestions)
  --resources, -r <path>        Add a resources directory for import resolution
                                 Can be used multiple times (first-match wins).
                                 Ex: --resources src/main/resources
  --help, -h                    Show this help

\x1b[1mExamples:\x1b[0m
  dw-check script.dwl
  dw-check script.dwl --input payload=data.json
  dw-check script.dwl --input payload=data.json --input vars=ctx.json
  dw-check --inline "%dw 2.0\\noutput json\\n---\\npayload" --only-syntax
  dw-check script.dwl --json
  dw-check script.dwl --resources src/main/resources
`);
}

// ─── MIME types ────────────────────────────────────────────────────────────────

const MIME_MAP = {
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".dw": "application/dw",
  ".dwl": "application/dw",
  ".ndjson": "application/x-ndjson",
  ".avro": "application/avro",
  ".bin": "application/octet-stream",
  ".js": "application/javascript",
  ".html": "text/html",
  ".htm": "text/html",
};

function detectMimeType(filePathOrName) {
  const ext = path.extname(filePathOrName).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

// ─── Construção do request ────────────────────────────────────────────────────

function buildRequestBody(scriptContent, inputs, inputPaths) {
  const fsMap = {};
  fsMap[MAIN_FILE] = scriptContent;

  const inputsMap = {};
  for (const [name, content] of Object.entries(inputs)) {
    const filePath = inputPaths[name] || name;
    const mimeType = detectMimeType(filePath);
    const encoded = Buffer.from(content, "utf-8").toString("base64");

    inputsMap[name] = {
      value: encoded,
      kind: "binary",
      properties: {},
      mimeType: mimeType,
    };
  }

  return {
    main: MAIN_FILE,
    fs: fsMap,
    inputs: inputsMap,
  };
}

// ─── Error classification ──────────────────────────────────────────────────

/**
 * Classifica se um erro da API do DataWeave é relacionado a inputs
 * (payload, vars, attributes não fornecidos).
 *
 * Erros de input não são erros de sintaxe — indicam apenas que o script
 * referencia variáveis de entrada que não foram fornecidas.
 */
function isInputError(error) {
  if (!error || !error.message) return false;

  var msg = error.message.toLowerCase();

  // Padrões que indicam erro de input (não de sintaxe)
  var inputPatterns = [
    /unable to resolve reference/,
    /no variable named/,
    /cannot find.*input/i,
    /missing.*input/i,
  ];

  for (var p = 0; p < inputPatterns.length; p++) {
    if (inputPatterns[p].test(msg)) return true;
  }

  return false;
}

function formatError(error, scriptLines) {
  const lines = [];

  lines.push(`\x1b[1;31m✘ ${error.kind || "Error"}\x1b[0m`);
  lines.push(`\x1b[31m${error.message}\x1b[0m`);

  if (error.location) {
    const loc = error.location;
    lines.push("");

    // Mostra o snippet de código com destaque no erro
    if (loc.locationString) {
      // O locationString já vem formatado da API
      const locLines = loc.locationString.split("\n");
      for (const ll of locLines) {
        if (ll.includes("^")) {
          lines.push(`\x1b[1;31m${ll}\x1b[0m`);
        } else if (ll.startsWith(" ")) {
          lines.push(`\x1b[2m${ll}\x1b[0m`);
        } else {
          lines.push(ll);
        }
      }
    }

    lines.push("");
    const src = loc.sourceIdentifier || "main";
    lines.push(
      `  \x1b[2mat\x1b[0m ${src} \x1b[2mline\x1b[0m ${loc.start.line}:${loc.start.column}`
    );
  }

  return lines.join("\n");
}

function formatErrorJSON(error) {
  return {
    success: false,
    error: {
      kind: error.kind || "Unknown",
      message: error.message,
      location: error.location
        ? {
            source: error.location.sourceIdentifier || "main",
            sourceFile: error.location.sourceFile || error.location.sourceIdentifier || null,
            line: error.location.start?.line,
            column: error.location.start?.column,
            endLine: error.location.end?.line,
            endColumn: error.location.end?.column,
          }
        : null,
    },
  };
}

// ─── Formatação agent mode ────────────────────────────────────────────────────

/**
 * Extrai o trecho de código ao redor do erro para dar contexto ao agente.
 */
function extractContext(scriptLines, startLine, endLine, radius = 2) {
  const from = Math.max(1, startLine - radius);
  const to = Math.min(scriptLines.length, endLine + radius);
  const ctx = [];
  for (let i = from; i <= to; i++) {
    ctx.push({
      line: i,
      text: scriptLines[i - 1] || "",
      error: i >= startLine && i <= endLine,
    });
  }
  return ctx;
}

/**
 * Gera sugestão de correção baseada no tipo de erro.
 */
function suggestFix(error, scriptLines) {
  const msg = (error.message || "").toLowerCase();
  const loc = error.location;

  if (msg.includes("unable to resolve reference")) {
    const ref = (error.message.match(/`([^`]+)`/) || [])[1] || "?";
    const suggestions = [];
    if (ref === "payload" || ref === "vars" || ref === "attributes") {
      suggestions.push(`add --input ${ref}=file.json`);
    }
    suggestions.push(`check if variable '${ref}' is defined`);
    if (!msg.includes("line:")) {
      // Error without location — may be missing input directive
      suggestions.push("add 'input' directive in script header (e.g.: input payload application/json)");
    }
    return suggestions.join("; ");
  }

  if (msg.includes("missing object field expression")) {
    return "add a value after ':' (e.g.: { field: value })";
  }

  if (msg.includes("invalid input")) {
    return "check header syntax (%dw 2.0, output, input directives)";
  }

  if (msg.includes("no variable named")) {
    const ref = (error.message.match(/'([^']+)'/) || [])[1] || "?";
    return `variable '${ref}' was not declared. Add --input ${ref}=file.json or declare 'input' directive in header`;
  }

  if (msg.includes("invalid") && msg.includes("expected")) {
    return "check syntax — unexpected token at the indicated position";
  }

  return null;
}

function formatAgentOutput(result, scriptContent, scriptLabel, opts) {
  const scriptLines = scriptContent.split("\n");

  const output = {
    status: result.success ? "ok" : "error",
    script: {
      name: scriptLabel,
      lines: scriptLines.length,
      hasInputs: Object.keys(opts.inputs).length > 0,
      inputNames: Object.keys(opts.inputs),
      syntaxOnly: opts.syntaxOnly || false,
    },
  };

  if (result.success) {
    if (result.result?.content) {
      try {
        output.result = JSON.parse(result.result.content);
      } catch {
        output.result = result.result.content;
      }
      output.contentType = result.result.contentType || null;
    }
    if (result.logs && result.logs.length > 0) {
      output.logs = result.logs;
    }
  } else {
    const err = result.error;
    output.errors = [
      {
        severity: "error",
        kind: err.kind || "Unknown",
        message: err.message || "Unknown error",
        location: err.location
          ? {
              source: err.location.sourceIdentifier || "main",
              sourceFile: err.location.sourceFile || err.location.sourceIdentifier || null,
              start: {
                line: err.location.start?.line,
                column: err.location.start?.column,
                index: err.location.start?.index,
              },
              end: {
                line: err.location.end?.line,
                column: err.location.end?.column,
                index: err.location.end?.index,
              },
            }
          : null,
      },
    ];

    // Contexto do código ao redor do erro
    if (err.location?.start?.line) {
      output.errors[0].context = extractContext(
        scriptLines,
        err.location.start.line,
        err.location.end?.line || err.location.start.line,
        2
      );
      output.errors[0].errorLine = err.location.locationString || null;
    }

    // Sugestão de correção
    const suggestion = suggestFix(err, scriptLines);
    if (suggestion) {
      output.errors[0].suggestion = suggestion;
    }
  }

  return output;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  // Lê o script
  let scriptContent;
  let scriptLabel;

  if (opts.inline) {
    scriptContent = opts.inline;
    scriptLabel = "<inline>";
  } else if (opts.script) {
    try {
      scriptContent = fs.readFileSync(opts.script, "utf-8");
      scriptLabel = opts.script;
      dim(`script ← ${opts.script}`);
    } catch (err) {
      die(`Could not read script "${opts.script}": ${err.message}`);
    }
  } else {
    // Tenta ler do stdin
    if (process.stdin.isTTY) {
      die("No script provided. Use --help to see options.");
    }
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    scriptContent = Buffer.concat(chunks).toString("utf-8");
    scriptLabel = "<stdin>";
    dim("script ← stdin");
  }

  if (!scriptContent || scriptContent.trim().length === 0) {
    die("Empty script.");
  }

  // Detecta imports sem --resources
  if (!opts.resources || opts.resources.length === 0) {
    var firstImport = null;
    var lines = scriptContent.split("\n");
    for (var li = 0; li < lines.length; li++) {
      firstImport = parseImportLine(lines[li]);
      if (firstImport) break;
    }
    if (firstImport) {
      die(
        "script contains import (" + firstImport.module + ") but --resources was not provided.\n" +
        "  Use: dw-check script.dwl --resources path/to/resources"
      );
    }
  }

  // ─── Resolução de imports ────────────────────────────────────────────────
  var lineMap = null;
  if (opts.resources && opts.resources.length > 0) {
    var hasImports = scriptContent.split("\n").some(function (l) {
      return parseImportLine(l) !== null;
    });
    if (hasImports) {
      if (!opts.jsonOutput && !opts.silent && !opts.agentMode) {
        dim("resolving imports...");
      }
      var resolved = resolveImports(scriptContent, opts.resources, null, scriptLabel);
      scriptContent = resolved.script;
      lineMap = resolved.lineMap;
    }
  }

  const body = buildRequestBody(scriptContent, opts.inputs, opts.inputPaths);

  // Loga o que vai ser enviado (modo verboso implícito)
  const quietMode = opts.jsonOutput || opts.silent || opts.agentMode;
  if (!quietMode) {
    const inputKeys = Object.keys(opts.inputs);
    if (inputKeys.length > 0) {
      dim(`inputs: ${inputKeys.join(", ")}`);
    }
    if (opts.syntaxOnly) {
      dim("mode: syntax-only");
    }
    dim("sending to API...");
  }

  let response;
  try {
    response = await postJSON(`${API_ORIGIN}${API_PATH}`, body);
  } catch (err) {
    if (opts.agentMode) {
      console.log(JSON.stringify({
        status: "network_error",
        error: err.message,
        script: { name: scriptLabel, lines: (scriptContent.match(/\n/g) || []).length + 1 },
      }, null, 2));
    } else if (opts.jsonOutput) {
      console.log(JSON.stringify({ success: false, error: err.message }, null, 2));
    } else {
      die(`Request failed: ${err.message}`);
    }
    process.exit(2);
  }

  // Processa a resposta
  if (!response.data || typeof response.data !== "object") {
    if (opts.agentMode) {
      console.log(JSON.stringify({
        status: "network_error",
        error: `Unexpected API response (HTTP ${response.status})`,
        script: { name: scriptLabel },
      }, null, 2));
    } else if (opts.jsonOutput) {
      console.log(JSON.stringify({ success: false, error: "Invalid API response" }, null, 2));
    } else {
      die(`Unexpected API response (HTTP ${response.status})`);
    }
    process.exit(3);
  }

  const result = response.data;

  if (result.success) {
    // Sucesso
    if (opts.agentMode) {
      console.log(JSON.stringify(
        formatAgentOutput(result, scriptContent, scriptLabel, opts),
        null, 2
      ));
    } else if (opts.jsonOutput) {
      console.log(JSON.stringify({
        success: true,
        output: result.result?.content || null,
        contentType: result.result?.contentType || null,
        logs: result.logs || [],
      }, null, 2));
    } else if (!opts.silent) {
      console.log(`\x1b[32m✔ Script valid\x1b[0m (${scriptLabel})`);
      if (opts.showOutput && result.result?.content) {
        console.log("");
        console.log("\x1b[1m── Output ──\x1b[0m");
        console.log(result.result.content);
      }
      if (result.logs && result.logs.length > 0) {
        console.log("");
        console.log("\x1b[1m── Logs ──\x1b[0m");
        for (const log of result.logs) {
          console.log(`  \x1b[2m${log}\x1b[0m`);
        }
      }
    }
    process.exit(0);
  } else {
    // Erro — filtra erros de input se --only-syntax
    if (opts.syntaxOnly && isInputError(result.error)) {
      // Erro é relacionado a input (payload/vars ausente) — suprime
      if (opts.agentMode) {
        console.log(JSON.stringify({
          status: "ok",
          script: {
            name: scriptLabel,
            lines: (scriptContent.match(/\n/g) || []).length + 1,
            hasInputs: Object.keys(opts.inputs).length > 0,
            inputNames: Object.keys(opts.inputs),
            syntaxOnly: true,
            inputErrorsSuppressed: 1,
          },
          result: null,
        }, null, 2));
      } else if (opts.jsonOutput) {
        console.log(JSON.stringify({
          success: true,
          output: null,
          contentType: null,
          logs: [],
          inputErrorsSuppressed: 1,
        }, null, 2));
      } else if (!opts.silent) {
        console.log(`\x1b[32m✔ Script valid\x1b[0m (${scriptLabel}) \x1b[2m— input errors suppressed\x1b[0m`);
      }
      process.exit(0);
    }

    if (opts.agentMode) {
      var agentOutput = formatAgentOutput(result, scriptContent, scriptLabel, opts);
      // Ajusta linhas de erro para script original (após context extraction)
      if (lineMap && agentOutput.errors) {
        for (var ei = 0; ei < agentOutput.errors.length; ei++) {
          var errWrapper = { location: agentOutput.errors[ei].location };
          adjustErrorLocation(errWrapper, lineMap);
          agentOutput.errors[ei].location = errWrapper.location;
        }
      }
      console.log(JSON.stringify(agentOutput, null, 2));
    } else if (opts.jsonOutput) {
      if (lineMap) adjustErrorLocation(result.error, lineMap);
      console.log(JSON.stringify(formatErrorJSON(result.error), null, 2));
    } else {
      if (lineMap) adjustErrorLocation(result.error, lineMap);
      console.log("");
      console.log(formatError(result.error, scriptContent.split("\n")));
      console.log("");
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\x1b[31mfatal error:\x1b[0m ${err.message}`);
  process.exit(2);
});
