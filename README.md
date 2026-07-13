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

# Syntax check only (ignores input-related errors like missing payload)
dw-check script.dwl --only-syntax

# Show output on success
dw-check script.dwl --input payload=input.json --output

# JSON output (for CI/CD)
dw-check script.dwl --json

# AI-agent-optimized output (with context, snippets, suggestions)
dw-check script.dwl --agent

# Silent — only returns exit code (0=ok, 1=error, 2=failure)
dw-check script.dwl --silent

# Resolve custom module imports
dw-check script.dwl --resources src/main/resources
dw-check script.dwl -r src/main/resources -r src/test/resources

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

## Syntax-only mode (`--only-syntax`)

The `--only-syntax` flag filters out **input-related errors** from the API response, showing only syntax and compilation errors. This is useful when you want to validate script structure without providing actual input data.

**What counts as an input error:**
- `Unable to resolve reference of: \`payload\`.` — script references `payload` but no input was provided
- `No variable named 'vars'.` — script references `vars` but no input was provided
- Missing input directive errors

**Behavior:**
- If the API returns **only** input errors → treated as success (exit code 0), errors are suppressed
- If the API returns syntax/compilation errors → shown normally (exit code 1)
- If the script is valid → success as usual

```bash
# Script references payload — normally an error, suppressed with --only-syntax
dw-check script.dwl --only-syntax
# ✔ Script valid (script.dwl) — input errors suppressed

# Script has a real syntax error — still shown
dw-check script.dwl --only-syntax
# ✘ CompilationException
# Missing Object Field Expression. e.g {a: 123}
```

**JSON output** includes `inputErrorsSuppressed` count:
```json
{ "success": true, "output": null, "inputErrorsSuppressed": 1 }
```

## Import error tracking

When an imported module contains an error, `dw-check` traces the error back to the **original source file and line number** — not just the import statement in the main script.

**How it works:**
1. During import resolution, `// @dw-import: <file>` marker comments are inserted into the generated script
2. Each injected line is tracked with its source file and original line number
3. When the API reports an error on an injected line, the location is adjusted to point to the actual source

**Example — error in imported module:**

Given `main.dwl`:
```dataweave
%dw 2.0
output json
import formatName from modules::utils
---
formatName(payload.name)
```

And `modules/utils.dwl` (line 5 has a syntax error):
```dataweave
%dw 2.0
import * from dw::core::Strings

fun formatName(name) =
    {name: }  // ← missing value after colon at line 5
```

Output:
```
✘ CompilationException
Missing Object Field Expression. e.g {a: 123}

  at modules/utils.dwl line 5:12
```

Instead of reporting the error at the import line in `main.dwl`, it points to `modules/utils.dwl` line 5 — the actual location of the bug.

**JSON output** includes `sourceFile` in the location:
```json
{
  "success": false,
  "error": {
    "kind": "CompilationException",
    "message": "Missing Object Field Expression.",
    "location": {
      "source": "modules/utils.dwl",
      "sourceFile": "modules/utils.dwl",
      "line": 5,
      "column": 12
    }
  }
}
```

**Nested imports** are fully traced through the dependency chain. If `A` imports from `B` which imports from `C`, an error in `C` will correctly point to `C`'s file and line number.

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

**Custom modules (your own `.dwl` files):** resolved locally via the `--resources` flag. The CLI inlines imported functions before sending the script to the API.

Given a project structure:
```
src/main/resources/
  modules/
    utils.dwl
  my-script.dwl
```

With `my-script.dwl`:
```dataweave
%dw 2.0
output json
import formatName, validateEmail from modules::utils
---
formatName(payload.name)
```

And `modules/utils.dwl`:
```dataweave
%dw 2.0
import * from dw::core::Strings

fun formatName(name) = trim(upper(name))
fun validateEmail(email) = email contains "@"
```

Run:
```bash
dw-check my-script.dwl --resources src/main/resources
```

**Supported import formats:**
- Named imports: `import foo, bar from modules::utils`
- Wildcard imports: `import * from modules::utils`
- Nested imports: modules that import other modules are resolved recursively
- Circular imports: detected and reported as fatal errors

Module paths use `::` as separator (DataWeave convention), mapped to filesystem paths: `modules::utils` → `modules/utils.dwl`.

The `--resources` flag can be used multiple times. The first directory containing the requested `.dwl` file wins.

**Line mapping:** when the API reports an error, line numbers are adjusted back to the original script (before import inlining). If the error originates from an imported module, the output shows the module's file path and the actual line number within that file. See [Import error tracking](#import-error-tracking) for details.

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
