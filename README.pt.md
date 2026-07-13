# dw-check

> 🇺🇸 [Read in English](README.md)

CLI para validar scripts DataWeave 2.x via API pública do [MuleSoft DataWeave Playground](https://dataweave.mulesoft.com/learn/dataweave).

Zero dependências. Roda em Node.js >= 14.

## Instalação

```bash
npm install -g @mrvook/dw-check
# ou use via npx:
npx @mrvook/dw-check script.dwl
```

## Uso

```bash
# Validar arquivo de script
dw-check meu-script.dwl

# Validar script inline
dw-check --inline "%dw 2.0\noutput json\n---\n{message: \"hello\"}"

# Com inputs (payload, vars, etc.)
dw-check script.dwl --input payload=entrada.json
dw-check script.dwl --input payload=dados.json --input vars=contexto.json

# Checagem de sintaxe apenas (ignora erros de input)
dw-check script.dwl --only-syntax

# Mostrar output em caso de sucesso
dw-check script.dwl --input payload=entrada.json --output

# Saída JSON (para CI/CD)
dw-check script.dwl --json

# Saída otimizada para agentes AI (com contexto, snippets, sugestões)
dw-check script.dwl --agent

# Silencioso — só retorna exit code (0=ok, 1=erro, 2=falha)
dw-check script.dwl --silent

# Resolver imports de módulos customizados
dw-check script.dwl --resources src/main/resources
dw-check script.dwl -r src/main/resources -r src/test/resources

# Via stdin
cat script.dwl | dw-check --input payload=entrada.json
```

## Exit codes

| Code | Significado |
|------|-------------|
| 0    | Script válido |
| 1    | Erro de compilação/validação |
| 2    | Falha na requisição (rede, timeout) |
| 3    | Resposta inválida da API |

## Formato dos erros

Erros incluem: tipo (`CompilationException`, etc.), mensagem, e localização exata (linha, coluna, snippet).

Exemplo:
```
✘ CompilationException
Missing Object Field Expression. e.g  {a: 123}

4| {message: }
            ^
Location:
main (line: 4, column:10)

  em main line 4:10
```

## Modo somente sintaxe (`--only-syntax`)

A flag `--only-syntax` filtra **erros relacionados a inputs** da resposta da API, mostrando apenas erros de sintaxe e compilação. Útil para validar a estrutura do script sem precisar fornecer dados de entrada reais.

**O que conta como erro de input:**
- `Unable to resolve reference of: \`payload\`.` — script referencia `payload` mas nenhum input foi fornecido
- `No variable named 'vars'.` — script referencia `vars` mas nenhum input foi fornecido
- Erros de diretiva de input ausente

**Comportamento:**
- Se a API retornar **apenas** erros de input → tratado como sucesso (exit code 0), erros suprimidos
- Se a API retornar erros de sintaxe/compilação → exibidos normalmente (exit code 1)
- Se o script for válido → sucesso normalmente

```bash
# Script referencia payload — normalmente daria erro, suprimido com --only-syntax
dw-check script.dwl --only-syntax
# ✔ Script valid (script.dwl) — input errors suppressed

# Script com erro de sintaxe real — ainda é exibido
dw-check script.dwl --only-syntax
# ✘ CompilationException
# Missing Object Field Expression. e.g {a: 123}
```

**Saída JSON** inclui contagem `inputErrorsSuppressed`:
```json
{ "success": true, "output": null, "inputErrorsSuppressed": 1 }
```

## Rastreamento de erros em imports

Quando um módulo importado contém um erro, o `dw-check` rastreia o erro de volta ao **arquivo fonte original e número da linha real** — não apenas a linha do import no script principal.

**Como funciona:**
1. Durante a resolução de imports, comentários de marcação `// @dw-import: <arquivo>` são inseridos no script gerado
2. Cada linha injetada é rastreada com seu arquivo fonte e número de linha original
3. Quando a API reporta um erro em uma linha injetada, a localização é ajustada para apontar para o fonte real

**Exemplo — erro em módulo importado:**

Dado `main.dwl`:
```dataweave
%dw 2.0
output json
import formatName from modules::utils
---
formatName(payload.name)
```

E `modules/utils.dwl` (linha 5 tem erro de sintaxe):
```dataweave
%dw 2.0
import * from dw::core::Strings

fun formatName(name) =
    {name: }  // ← valor ausente após ":" na linha 5
```

Saída:
```
✘ CompilationException
Missing Object Field Expression. e.g {a: 123}

  em modules/utils.dwl line 5:12
```

Em vez de reportar o erro na linha do import em `main.dwl`, aponta para `modules/utils.dwl` linha 5 — a localização real do bug.

**Saída JSON** inclui `sourceFile` na localização:
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

**Imports aninhados** são rastreados por toda a cadeia de dependências. Se `A` importa de `B` que importa de `C`, um erro em `C` apontará corretamente para o arquivo e número de linha em `C`.

## Modo agente (`--agent`)

Output JSON otimizado para consumo por agentes AI (Claude, ChatGPT, etc.):

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
    "suggestion": "adicione --input payload=arquivo.json"
  }]
}
```

## Formatos de input suportados

JSON, XML, CSV, texto, YAML, NDJSON. O MIME type é detectado automaticamente pela extensão do arquivo.

## Imports

**Módulos padrão (stdlib):** todos funcionam — `dw::core::*`, `dw::util::*`, `dw::Runtime::*`, etc.

```bash
dw-check --inline "%dw 2.0
import * from dw::core::Strings
output json
---
{upper: upper('hello')}" --output
```

**Módulos customizados (seus próprios `.dwl`):** resolvidos localmente via flag `--resources`. O CLI inlineia as funções importadas antes de enviar o script para a API.

Dada a estrutura de projeto:
```
src/main/resources/
  modules/
    utils.dwl
  meu-script.dwl
```

Com `meu-script.dwl`:
```dataweave
%dw 2.0
output json
import formatName, validateEmail from modules::utils
---
formatName(payload.name)
```

E `modules/utils.dwl`:
```dataweave
%dw 2.0
import * from dw::core::Strings

fun formatName(name) = trim(upper(name))
fun validateEmail(email) = email contains "@"
```

Execute:
```bash
dw-check meu-script.dwl --resources src/main/resources
```

**Formatos de import suportados:**
- Import nomeado: `import foo, bar from modules::utils`
- Import wildcard: `import * from modules::utils`
- Imports aninhados: módulos que importam outros módulos são resolvidos recursivamente
- Imports circulares: detectados e reportados como erro fatal

Paths de módulo usam `::` como separador (convenção DataWeave), mapeados para paths do sistema de arquivos: `modules::utils` → `modules/utils.dwl`.

A flag `--resources` pode ser usada múltiplas vezes. O primeiro diretório que contiver o arquivo `.dwl` solicitado vence.

**Mapeamento de linhas:** quando a API reporta um erro, os números de linha são ajustados de volta para o script original (antes da injeção dos imports). Se o erro se origina de um módulo importado, o output mostra o caminho do arquivo do módulo e o número real da linha dentro daquele arquivo. Veja [Rastreamento de erros em imports](#rastreamento-de-erros-em-imports) para detalhes.

## `$` em strings

`$` dentro de strings DataWeave dispara interpolação: `$var` (shorthand) ou `$(expr)`. Para `$` literal, escape com `\$`.

| Script | Resultado |
|--------|-----------|
| `"$(name)"` | Interpola a variável `name` |
| `"$100"` | Erro — `$` tenta interpolar |
| `"\$100"` | `$100` (literal) |

Comportamento correto do DataWeave 2.x. Scripts com `$` em CDATA no Mule XML funcionam porque o parser de expressão do Mule processa o `$` antes do DataWeave.

## Disclaimer

Esta ferramenta é um wrapper não-oficial da API pública do [DataWeave Playground](https://dataweave.mulesoft.com/learn/dataweave). Não é mantida pela MuleSoft/Salesforce.
