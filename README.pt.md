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

# Checagem de sintaxe apenas
dw-check script.dwl --syntax-only

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

**Mapeamento de linhas:** quando a API reporta um erro, os números de linha são ajustados de volta para o script original (antes da injeção dos imports), para que a localização do erro corresponda aos seus arquivos fonte.

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
