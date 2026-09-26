# CLI do Conclave

[English](cli.md) · [Português (Brasil)](cli.pt-BR.md) · [← README](../../README.pt-BR.md)

A CLI é o motor do Conclave. O [cockpit](cockpit.pt-BR.md), a [skill de agente](agent-skill.pt-BR.md) e o [GitHub Action](github-actions.pt-BR.md) chamam a CLI por baixo.

## Instalação

```bash
npm install -g conclave-ai          # uma vez, para todo repositório (recomendado)
npm install --save-dev conclave-ai  # ou por projeto: npx conclave check .
```

Yarn e pnpm também funcionam: `yarn add --dev conclave-ai` ou `pnpm add --save-dev conclave-ai`. Você precisa de Node.js 20+ e Git; o projeto revisado pode ser de qualquer linguagem.

## Você não precisa decorar nada

```bash
conclave              # menu guiado
conclave help         # todos os comandos, agrupados por objetivo
conclave help check   # um comando: o que faz, opções, exemplos
```

O menu guiado deixa qualquer ação a no máximo duas escolhas: a lista principal, mais os submenus **Mais ferramentas…** e **Configurações…**. A ajuda vem com a CLI, então sempre corresponde à versão instalada.

## Comandos do dia a dia

| Comando | O que faz |
| --- | --- |
| `conclave check .` | Revisa a branch atual e todas as mudanças locais (recomendado) |
| `conclave compare .` | Escolhe duas branches numa lista e compara sem trocar o checkout |
| `conclave open .` | Abre o [cockpit](cockpit.pt-BR.md) no navegador |
| `conclave history .` | Lista reviews anteriores deste repositório |
| `conclave handoff .` | Mostra o último prompt de correção para o seu coding agent |
| `conclave setup .` | Instala a [skill de agente](agent-skill.pt-BR.md) e, se quiser, o [workflow do GitHub](github-actions.pt-BR.md) |
| `conclave doctor .` | Verifica Git, linguagens, skills e integração com CI |
| `conclave ask . "pergunta"` | Responde uma pergunta sobre o código (precisa de provider) |
| `conclave investigate . "comportamento"` | Questiona hipóteses sobre um comportamento (precisa de provider) |

### O que o `check` faz por você

- encontra o repositório e a provável base do pull request;
- inclui commits da branch e arquivos preparados, alterados e novos;
- usa o último commit como objetivo transparente quando você não informa um;
- cria um mapa de código local novo (sem precisar de `index`);
- mostra resumo, achados, código afetado, evidências e próximos passos;
- escreve um prompt que o seu coding agent pode executar; e
- salva o relatório completo no histórico local.

### Sendo explícito

```bash
# Workspace atual contra uma base escolhida, com objetivo declarado
conclave check . --base origin/main \
  --objective "Adicionar login sem senha sem quebrar a restauração da sessão"

# Duas refs commitadas, sem trocar de branch
conclave compare . --base origin/main --head feature/login \
  --objective "Adicionar login sem senha"

# Saída em JSON para scripts ou CI
conclave check . --base origin/main --json > conclave-review.json
```

### Conferir de novo depois de uma correção

```bash
conclave check . --base origin/main \
  --objective "Adicionar login sem senha sem quebrar a restauração da sessão" \
  --previous-report conclave-review.json --json > conclave-recheck.json
```

A nova conferência continua na mesma série de review. O Conclave verifica o relatório anterior, mantém objetivo e critérios fixos e diferencia progresso real de uma repetição idêntica, estagnação ou regressão. Use `--new-series` só para aceitar de propósito uma nova baseline. Anexe resultados externos de teste ou build com a flag repetível `--receipt`. Veja [linhagem de review e recibos](../review-lineage.md).

### Critérios de aceite

```bash
conclave criteria .
```

Salva o objetivo e os critérios que `check` e `review` devem cumprir. Veja [aceite](../acceptance.md).

### Códigos de saída

| Saída | Veredito |
| ---: | --- |
| 0 | `PASS` ou `WARN` |
| 1 | `BLOCK` |
| 2 | `INCONCLUSIVE` |

## Configurações e chaves de API

O review nunca precisa de chave. Um provider só é usado por `ask`, `investigate` e pelos modos Ask e Investigate do cockpit.

### Primeira configuração: três passos

```bash
conclave init             # provider → modelo → chave de API (entrada oculta)
conclave provider-check   # envia uma pequena requisição de teste
```

Providers suportados: OpenCode Go (padrão recomendado de baixo custo), OpenAI, OpenRouter e Anthropic. Rode `conclave models` para ver os perfis de modelo mantidos. Se você rodar `init` de novo com o mesmo provider, apertar Enter na chave mantém a chave salva.

Sem interação, para scripts:

```bash
echo "$KEY" | conclave init --provider opencode-go --api-key-stdin
```

### Trocar um valor

```bash
conclave config                              # cada valor e sua origem; segredos mascarados
conclave config set api-key                  # pedido de forma oculta
echo "$KEY" | conclave config set api-key    # ou via pipe
conclave config set model deepseek-v4.1-flash
conclave config set provider openrouter      # também muda o mode para api
conclave config get model
conclave config unset base-url
conclave config edit                         # abre o arquivo no $EDITOR
conclave config path                         # mostra o caminho do arquivo
```

Chaves curtas: `provider`, `model`, `api-key`, `base-url`, `reasoning`, `mode`, `fallback-model`. Qualquer nome `CONCLAVE_*` também funciona, por exemplo `conclave config set judge-model <id>`.

### Onde as configurações ficam

| Origem | Local | Tem prioridade sobre |
| --- | --- | --- |
| Ambiente do shell | `export CONCLAVE_MODEL=…` | tudo |
| Arquivo do projeto | `./.env` (só quando já define chaves `CONCLAVE_*`) | configurações do usuário |
| Configurações do usuário | `~/.config/conclave/credentials.env` | — |

As configurações do usuário são gravadas com permissão só do dono (`0600`), então uma instalação global funciona em qualquer repositório. Use `--project` em `init` ou `config set` para gravar em `./.env`. `CONCLAVE_CONFIG_HOME` muda a pasta de configurações.

### Idioma da interface

```bash
conclave config --language pt-BR   # português do Brasil
conclave config --language es-ES   # espanhol (Espanha)
conclave config --language en      # volta ao padrão
```

O idioma vale para menus, ajuda, prompts e rótulos do review. `CONCLAVE_LANGUAGE=es-ES conclave help` sobrescreve para um único comando. Os campos do JSON continuam sempre em inglês para não quebrar integrações.

## Atualização e diagnóstico

```bash
conclave --version
conclave update --check    # última versão no npm
conclave update --global   # atualiza uma instalação global
conclave update --local    # atualiza a dependência do projeto
conclave doctor .
```

## Comandos avançados

| Comando | Para que serve |
| --- | --- |
| `conclave review . --working\|--staged\|--base <ref>\|--commit <sha> --objective "…" --json` | Gate de evidência de baixo nível com fonte exata |
| `conclave index .` | Cache opcional reutilizável (`.conclave/code-index-v2.json`) para busca, grafo e Ask |
| `conclave search`, `symbol`, `text`, `graph`, `path`, `retrieve` | Explorar o mapa de código |
| `conclave collect`, `smoke` | Executar explicitamente um plano limitado de evidência; veja [evidências de CI](../ci-evidence.md) e [browser smoke](../browser-smoke.md) |
| `conclave mcp .` | Expor o Conclave para clientes MCP |
| `conclave eval …` | Avaliações de recuperação e raciocínio |

Rode `conclave help <comando>` para ver os detalhes de qualquer um deles.
