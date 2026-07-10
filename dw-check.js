#!/usr/bin/env node

/**
 * dw-check — Valida scripts DataWeave 2.x pela API pública do MuleSoft Playground.
 *
 * Uso:
 *   node dw-check.js <script.dwl> [--input nome=arquivo.json ...]
 *   node dw-check.js --inline "%dw 2.0 ..." [--input nome=arquivo.json ...]
 *   node dw-check.js <script.dwl> --syntax-only
 *   node dw-check.js <script.dwl> --json
 *
 * Exemplos:
 *   node dw-check.js meu-script.dwl
 *   node dw-check.js meu-script.dwl --input payload=entrada.json
 *   node dw-check.js meu-script.dwl --input payload=entrada.json --input vars=variaveis.json
 *   node dw-check.js --inline "%dw 2.0\noutput json\n---\n{ a: 1 }"
 *   node dw-check.js meu-script.dwl --json > resultado.json
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
  console.error(`\x1b[31merro:\x1b[0m ${msg}`);
  process.exit(code);
}

function warn(msg) {
  console.error(`\x1b[33maviso:\x1b[0m ${msg}`);
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
      reject(new Error("Timeout após 30s"));
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
      if (!result.inline) die("Falta o script após --inline");
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
      if (!raw) die("Falta o valor após --input. Use: --input nome=arquivo.json");
      const eqIdx = raw.indexOf("=");
      if (eqIdx === -1) die(`Formato inválido para --input "${raw}". Use: nome=arquivo.json`);
      const name = raw.slice(0, eqIdx);
      const filePath = raw.slice(eqIdx + 1);
      try {
        result.inputs[name] = fs.readFileSync(filePath, "utf-8");
        result.inputPaths[name] = filePath;
        dim(`input "${name}" ← ${filePath}`);
      } catch (err) {
        die(`Não foi possível ler o arquivo de input "${filePath}": ${err.message}`);
      }
      i++;
      continue;
    }

    if (arg === "--syntax-only" || arg === "-s") {
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

    // Assume que é o arquivo de script
    if (!result.script && !arg.startsWith("-")) {
      result.script = arg;
      i++;
      continue;
    }

    die(`Argumento desconhecido: ${arg}`);
  }

  return result;
}

function printHelp() {
  console.log(`
\x1b[1mdw-check\x1b[0m — Valida scripts DataWeave 2.x

\x1b[1mUso:\x1b[0m
  dw-check <script.dwl> [opções]
  dw-check --inline "<script>" [opções]

\x1b[1mOpções:\x1b[0m
  --input, -in <nome=arquivo>   Adiciona um input (payload, vars, etc.)
                                 Pode ser usado múltiplas vezes.
                                 Ex: --input payload=dados.json
  --syntax-only, -s             Apenas checagem de sintaxe (sem validação de tipos)
  --output, -o                  Mostra o output da transformação em caso de sucesso
  --json, -j                    Saída em formato JSON (ideal para CI/CD)
  --silent, -q                  Sem output no stdout em caso de sucesso (só status code)
  --agent                       Saída otimizada para agentes AI (JSON com contexto,
                                código ao redor do erro, e sugestões de correção)
  --help, -h                    Mostra esta ajuda

\x1b[1mExemplos:\x1b[0m
  dw-check script.dwl
  dw-check script.dwl --input payload=entrada.json
  dw-check script.dwl --input payload=entrada.json --input vars=ctx.json
  dw-check --inline "%dw 2.0\\noutput json\\n---\\npayload" --syntax-only
  dw-check script.dwl --json
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

// ─── Formatação de erros ──────────────────────────────────────────────────────

function formatError(error, scriptLines) {
  const lines = [];

  lines.push(`\x1b[1;31m✘ ${error.kind || "Erro"}\x1b[0m`);
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
      `  \x1b[2mem\x1b[0m ${src} \x1b[2mline\x1b[0m ${loc.start.line}:${loc.start.column}`
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
      suggestions.push(`adicione --input ${ref}=arquivo.json`);
    }
    suggestions.push(`verifique se a variável '${ref}' está definida`);
    if (!msg.includes("line:")) {
      // Erro sem localização — pode ser problema de input directive
      suggestions.push("adicione diretiva 'input' no header do script (ex: input payload application/json)");
    }
    return suggestions.join("; ");
  }

  if (msg.includes("missing object field expression")) {
    return "adicione um valor após ':' (ex: { campo: valor })";
  }

  if (msg.includes("invalid input")) {
    return "verifique a sintaxe do header (%dw 2.0, output, input directives)";
  }

  if (msg.includes("no variable named")) {
    const ref = (error.message.match(/'([^']+)'/) || [])[1] || "?";
    return `a variável '${ref}' não foi declarada. Adicione --input ${ref}=arquivo.json ou declare a diretiva 'input' no header`;
  }

  if (msg.includes("invalid") && msg.includes("expected")) {
    return "verifique a sintaxe — há um token inesperado na posição indicada";
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
      die(`Não foi possível ler o script "${opts.script}": ${err.message}`);
    }
  } else {
    // Tenta ler do stdin
    if (process.stdin.isTTY) {
      die("Nenhum script fornecido. Use --help para ver as opções.");
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
    die("Script vazio.");
  }

  // Validação syntax-only: usa a API também, mas podemos adicionar header
  const actionHeader = opts.syntaxOnly
    ? { "X-DataweaveAction": "weaveType" }
    : { "X-DataweaveAction": "preview" };

  const body = buildRequestBody(scriptContent, opts.inputs, opts.inputPaths);

  // Loga o que vai ser enviado (modo verboso implícito)
  const quietMode = opts.jsonOutput || opts.silent || opts.agentMode;
  if (!quietMode) {
    const inputKeys = Object.keys(opts.inputs);
    if (inputKeys.length > 0) {
      dim(`inputs: ${inputKeys.join(", ")}`);
    }
    if (opts.syntaxOnly) {
      dim("modo: syntax-only");
    }
    dim("enviando para API...");
  }

  let response;
  try {
    response = await postJSON(`${API_ORIGIN}${API_PATH}`, body, actionHeader);
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
      die(`Falha na requisição: ${err.message}`);
    }
    process.exit(2);
  }

  // Processa a resposta
  if (!response.data || typeof response.data !== "object") {
    if (opts.agentMode) {
      console.log(JSON.stringify({
        status: "network_error",
        error: `Resposta inesperada da API (HTTP ${response.status})`,
        script: { name: scriptLabel },
      }, null, 2));
    } else if (opts.jsonOutput) {
      console.log(JSON.stringify({ success: false, error: "Resposta inválida da API" }, null, 2));
    } else {
      die(`Resposta inesperada da API (HTTP ${response.status})`);
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
      console.log(`\x1b[32m✔ Script válido\x1b[0m (${scriptLabel})`);
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
    // Erro
    if (opts.agentMode) {
      console.log(JSON.stringify(
        formatAgentOutput(result, scriptContent, scriptLabel, opts),
        null, 2
      ));
    } else if (opts.jsonOutput) {
      console.log(JSON.stringify(formatErrorJSON(result.error), null, 2));
    } else {
      console.log("");
      console.log(formatError(result.error, scriptContent.split("\n")));
      console.log("");
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\x1b[31merro fatal:\x1b[0m ${err.message}`);
  process.exit(2);
});
