# dw-check

> 🇧🇷 [Leia em português](README.pt.md)

CLI to validate DataWeave 2.x scripts via the [MuleSoft DataWeave Playground](https://dataweave.mulesoft.com/learn/dataweave) public API.

Zero dependencies. Runs on Node.js >= 14.

## Installation

```bash
npm install -g @mrvook/dw-check
# or use via npx:
npx @mrvook/dw-check script.dwl
```

## Usage

```bash
# Validate a script file
dw-check my-script.dwl

# Validate inline script
dw-check --inline "%dw 2.0\noutput json\n---\n{message: \"hello\"}"

# With inputs (payload, vars, etc.)
dw-check script.dwl --input payload=input.json
dw-check script.dwl --input payload=data.json --input vars=context.json

# Syntax check only
dw-check script.dwl --syntax-only

# Show output on success
dw-check script.dwl --input payload=input.json --output

# JSON output (for CI/CD)
dw-check script.dwl --json

# AI-agent-optimized output (with context, snippets, suggestions)
dw-check script.dwl --agent

# Silent — only returns exit code (0=ok, 1=error, 2=failure)
dw-check script.dwl --silent

# Via stdin
cat script.dwl | dw-check --input payload=input.json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | Valid script |
| 1    | Compilation/validation error |
| 2    | Request failure (network, timeout) |
| 3    | Invalid API response |

## Error format

Errors include: type (`CompilationException`, etc.), message, and exact location (line, column, snippet).

Example:
```
✘ CompilationException
Missing Object Field Expression. e.g  {a: 123}

4| {message: }
            ^
Location:
main (line: 4, column:10)

  in main line 4:10
```

## Agent mode (`--agent`)

JSON output optimized for AI agents (Claude, ChatGPT, etc.):

```json
{
  "status": "error",
  "script": { "name": "script.dwl", "lines": 4 },
  "errors": [{
    "severity": "error",
    "kind": "CompilationException",
    "message": "Unable to resolve reference of: `payload`.",
    "location": { "source": "main", "start": { "line": 4, "column": 1 } },
    "context": [
      { "line": 2, "text": "output json", "error": false },
      { "line": 3, "text": "---", "error": false },
      { "line": 4, "text": "payload", "error": true }
    ],
    "suggestion": "add --input payload=file.json"
  }]
}
```

## Supported input formats

JSON, XML, CSV, text, YAML, NDJSON. MIME type is auto-detected from file extension.

## Imports

**Standard library modules (stdlib):** all work — `dw::core::*`, `dw::util::*`, `dw::Runtime::*`, etc.

```bash
dw-check --inline "%dw 2.0
import * from dw::core::Strings
output json
---
{upper: upper('hello')}" --output
```

**Custom modules (your own `.dwl` files):** not supported by the `/transform` endpoint. It only accepts a main script + inputs.

**Workaround:** declare reusable functions directly in the script (no `import`).

## `$` in strings

`$` inside DataWeave strings triggers interpolation: `$var` (shorthand) or `$(expr)`. For a literal `$`, escape with `\$`.

| Script | Result |
|--------|--------|
| `"$(name)"` | Interpolates the `name` variable |
| `"$100"` | Error — `$` attempts interpolation |
| `"\$100"` | `$100` (literal) |

This is correct DataWeave 2.x behavior. Scripts with `$` inside CDATA in Mule XML work because the Mule expression parser processes the `$` before DataWeave sees it.

## Disclaimer

This tool is an unofficial wrapper around the [DataWeave Playground](https://dataweave.mulesoft.com/learn/dataweave) public API. It is not maintained by MuleSoft/Salesforce.
