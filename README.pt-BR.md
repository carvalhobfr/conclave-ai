<div align="center">

# Conclave

### Um companheiro de PR que transforma mudanças de código em evidências revisáveis.

**Conclave simplifica e protege o caminho entre o código alterado e o merge aprovado por uma pessoa.**

[English](README.md) · [Português (Brasil)](README.pt-BR.md)

[![npm](https://img.shields.io/npm/v/conclave-ai?logo=npm&color=CB3837)](https://www.npmjs.com/package/conclave-ai)
[![npm downloads](https://img.shields.io/npm/dm/conclave-ai?logo=npm&label=downloads%2Fmonth&color=CB3837)](https://www.npmjs.com/package/conclave-ai)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Licença: MIT](https://img.shields.io/badge/license-MIT-4C1)](LICENSE)
[![Changelog](https://img.shields.io/badge/changelog-histórico%20de%20versões-8B5CF6)](CHANGELOG.pt-BR.md)

[Início rápido](#início-rápido) · [CLI e idiomas](#ajuda-da-cli-e-idiomas) · [Como funciona](#como-o-review-funciona-sem-ia) · [Skill de agent](#skill-para-codex-e-claude-code) · [Interface visual](#cockpit-visual-de-review) · [Changelog](CHANGELOG.pt-BR.md)

</div>

---

> **0.9:** `0.9.0` introduz cobertura explícita das regras e um relatório voltado à decisão. Editor de critérios, procedência verificada do CI, coleta comportamental e colaboração de equipes continuam planejados. Veja o [plano da 0.9](docs/product-0.9.md).


Conclave entra depois da mudança de código e antes da aprovação. Ele compara o Git real, mapeia o código ao redor, aponta riscos e evidências e entrega a próxima ação para o desenvolvedor, coding agent ou revisor humano.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-pr-flow.svg" alt="Uma mudança passa pelo contexto e pelas evidências do Conclave antes da aprovação humana e do merge" width="920"></p>

```text
mudança → review do Conclave → agent corrige → Conclave confere de novo → humano aprova → merge
```

Conclave é deliberadamente somente leitura. Ele não edita arquivos, aplica patches, executa scripts do repositório, cria commit, faz push, aprova ou realiza merge.

## Escolha o caminho mais curto

| Quero… | Comece aqui |
| --- | --- |
| Revisar minha branch atual e todas as mudanças locais | `conclave check .` |
| Comparar duas branches sem trocar o checkout | `conclave compare .` |
| Deixar Codex ou Claude usar o Conclave naturalmente | `conclave setup .` |
| Ler o resultado no navegador | `conclave open .` |
| Conhecer os comandos sem decorar flags | `conclave help` |

## Início rápido

Requisitos: Node.js 20+ e Git. Node é o runtime do Conclave; o repositório analisado não precisa ser um projeto Node.

```bash
npm install --save-dev conclave-ai
npx conclave check .
```

Isso basta para o fluxo normal. Não precisa de chave de API nem de indexação prévia.

`check` é o comando recomendado. Ele:

- detecta o repositório e a provável base do PR;
- inclui commits da branch, arquivos preparados, mudanças locais e novos arquivos ainda não rastreados pelo Git;
- usa o último commit como objetivo de review transparente quando você não informa um;
- cria um mapa local novo—não é necessário rodar `index` antes;
- mostra resumo do PR, findings, código afetado, evidências e próximos passos;
- gera um prompt acionável para o seu coding agent; e
- salva o relatório completo no histórico local.

Use a forma explícita quando quiser:

```bash
# Workspace atual contra uma base escolhida
npx conclave check . --base origin/main \
  --objective "Adicionar login sem senha sem quebrar a restauração da sessão"

# Duas refs commitadas sem trocar de branch
npx conclave compare . --base origin/main --head feature/login \
  --objective "Adicionar login sem senha"

# Saída para agent ou CI
npx conclave check . --base origin/main --json > conclave-review.json

# Conferir a correção sem mudar silenciosamente o objetivo ou contrato
npx conclave check . --base origin/main \
  --objective "Adicionar login sem senha sem quebrar a restauração da sessão" \
  --previous-report conclave-review.json --json > conclave-recheck.json
```

A nova conferência continua na mesma série. O Conclave verifica o digest do relatório anterior, compara objetivo e contrato, cria fingerprints dos findings recorrentes e diferencia repetição idêntica de progresso, estagnação ou regressão. Use `--new-series` somente quando quiser aceitar deliberadamente uma nova baseline. Testes e builds executados externamente podem entrar com `--receipt` repetível; o vínculo com o artefato é verificado, mas a evidência continua autorrelatada até existir verificação de attestations. Veja [linhagem de review e recibos](docs/review-lineage.md).

Yarn e pnpm também funcionam:

```bash
yarn add --dev conclave-ai && yarn conclave check .
pnpm add --save-dev conclave-ai && pnpm exec conclave check .
```

Para testar sem adicionar dependência:

```bash
npx --yes --package=conclave-ai@latest conclave check .
```

Prefere um fluxo guiado? Rode apenas `npx conclave`. Quer entender o comando antes? Rode `npx conclave help check`.

## Como o review funciona sem IA

O review é uma análise determinística de código, não uma resposta de chat.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-review-pipeline.svg" alt="A comparação Git passa por índice estrutural, grafo de impacto, checks e um veredito com evidências" width="900"></p>

1. O Git fornece a comparação e o patch exatos.
2. Parsers locais identificam arquivos e **unidades de código**: funções, métodos, classes, interfaces e módulos nomeados. A documentação antiga chamava isso de “símbolos”.
3. Um grafo acompanha imports, exports, chamadas, referências, containers e consumidores.
4. Checks determinísticos desafiam escopo, mudança pública sem teste alterado, erro visível ao parser, impacto fora do diff, deleções e claims opcionais. Defeitos visíveis no próprio texto alterado saem do mesmo jeito: recurso sem candidato de limpeza correspondente no mesmo arquivo, erro jogado fora por um `catch` vazio e armazenamento endereçado por literal onde o mesmo arquivo usa uma constante nomeada.
5. Conclave retorna `PASS`, `WARN`, `BLOCK` ou `INCONCLUSIVE`, com arquivo e linha sempre que houver evidência disponível.

Nenhum código é enviado a uma LLM durante o review. Não precisa de chave de API. Isso é evidência útil, não compilador, test runner, scanner de segurança, prova de runtime nem aprovação automática. A autoridade do merge continua humana.

### Linguagens

| Linguagem | Funções/classes | Imports | Grafo de impacto | Detecção de testes |
| --- | ---: | ---: | ---: | ---: |
| TypeScript / JavaScript / TSX / JSX | Sim | Sim | Sim | Sim |
| Python | Sim | Sim | Sim | Sim |
| Java | Sim | Sim | Sim | Sim |

Outras linguagens textuais ainda entram no diff e no controle de escopo, mas sem a mesma profundidade do grafo. Veja [ROADMAP.md](ROADMAP.md).

## Quando vale gastar um modelo

O review informa quais regras restritas examinaram a mudança e quais perguntas continuam abertas. Um achado, ou sua ausência, nunca verifica uma dimensão inteira de risco.

| Cobertura | Significado |
| --- | --- |
| `partial` | Regras aplicáveis examinaram apenas seu escopo declarado. Consulte `checks` e `remainingQuestions`. |
| `unchecked` | Nenhuma regra determinística aplicável examinou a dimensão no código disponível. |

`escalation.recommended` indica que há verificação pendente. Conforme a pergunta, use testes relevantes, revisão humana ou raciocínio opcional de modelo. Isso nunca inicia um modelo nem executa scripts do repositório. Um modelo não substitui evidência de execução. Valores históricos v2 `evidenced` e `checked-clean` continuam legíveis com limitações explícitas.

```bash
conclave check . --json | jq '.report.escalation'
```

## Ajuda da CLI e idiomas

Você não precisa decorar a CLI. Rode `conclave` ou `conclave start .` para abrir o menu guiado. `conclave help` mostra todos os comandos agrupados por objetivo; `conclave help <comando>` explica o que um comando faz, quando usar, seus limites, sintaxe e exemplos práticos:

```bash
conclave help
conclave help check
conclave help symbol
```

A ajuda faz parte da própria CLI, então sempre corresponde à versão instalada.

| Comando | Para que serve |
| --- | --- |
| `conclave check .` | Revisar a branch atual e todas as mudanças locais juntas |
| `conclave compare .` | Escolher duas refs locais ou remotas |
| `conclave open .` | Abrir o cockpit visual no navegador |
| `conclave setup .` | Instalar skills e, opcionalmente, GitHub Actions |
| `conclave doctor .` | Diagnosticar Git, linguagens, skills e CI |
| `conclave history .` | Ver reviews locais anteriores |
| `conclave handoff .` | Imprimir o último prompt de correção para um agente |
| `conclave review ... --json` | Relatório determinístico de baixo nível |
| `conclave ask ...` / `investigate` | Raciocínio opcional usando um provedor |

`conclave index` é apenas um cache opcional para busca, grafo e Ask. Ele cria `.conclave/code-index-v2.json`; o review nunca confunde esse arquivo com a mudança analisada.

### Inglês, português ou espanhol

Inglês é o idioma padrão da CLI. Você pode salvar português do Brasil ou espanhol europeu como preferência global do usuário, a partir de qualquer repositório:

```bash
conclave config --language pt-BR
conclave config --language es-ES
conclave config --language en       # volta ao padrão
conclave config                     # mostra idioma e configuração do provider
```

A escolha vale para menu guiado, ajuda, prompts, progresso, rótulos do review, mensagens de atualização e setup de provider. Ela fica na configuração do usuário (`~/.config/conclave/config.json` no macOS/Linux, com equivalentes para XDG e Windows), não dentro do repositório. `CONCLAVE_LANGUAGE=es-ES conclave help` sobrescreve o idioma em uma única execução. As chaves do JSON continuam em inglês para não quebrar skills, CI e outras integrações.

## Skill para Codex e Claude Code

A skill é o fluxo do agente; a CLI é o motor local de revisão. Ela ensina Codex ou Claude Code a escolher a mudança, preservar o veredito, citar evidências, responder de forma legível, devolver achados para correção e conferir novamente. Ela não dá poder de mutação ao Conclave.

Setup interativo no repositório:

```bash
npx --yes --package=conclave-ai@latest conclave setup .
```

Ou instale os dois adapters diretamente:

```bash
npx --yes --package=conclave-ai@latest conclave skill install \
  --target both --scope project --project .
```

O npm baixa o pacote somente para executar o comando e copia a skill pequena para `.agents/skills/conclave-validate` e `.claude/skills/conclave-validate`; nada é adicionado ao `package.json`. Use `--scope user` para instalar na sua conta ou `--target portable --destination ...` para outro agent.

Depois, peça naturalmente: “Use o Conclave para revisar a mudança atual antes do merge.” A resposta legível aparece na conversa do agente; o JSON exato continua disponível.

## GitHub Actions

```bash
npx --yes --package=conclave-ai@latest conclave setup . \
  --agents none --github-actions
```

O workflow independe da linguagem do projeto: baixa apenas o Conclave, sem `npm ci` nem build específico. Ele escreve o resumo do job, cria annotations, atualiza um comentário no PR, guarda o JSON como artefato e falha somente em `BLOCK` ou `INCONCLUSIVE`. PRs vindos de fork ainda recebem resumo e artefato quando o GitHub remove a permissão de comentário.

## Cockpit visual de review

```bash
npx conclave open .
```

Conclave inicia um servidor somente em loopback, abre o navegador e carrega o repositório automaticamente. A interface mostra resumo, achados, alegações, código afetado, diff exato, instrução copiável para o agente, JSON e histórico local. Ask e Investigate aparecem quando existe um provedor configurado.

A UI usa o mesmo motor da CLI. Ela não corrige nem aplica o patch. Encerre com `Ctrl+C`.

## Configuração opcional de IA

Review nunca precisa de chave. Um provedor é usado apenas nos modos read-only `ask` e `investigate`:

```bash
conclave init
conclave provider-check
```

O setup guiado aceita chaves compatíveis com OpenAI/Codex, OpenRouter — incluindo chaves do plano OpenRouter Go —, Anthropic e OpenCode Zen, com perfis prontos e IDs de modelos personalizados. A entrada é escondida e salva somente no `.env` local ignorado pelo Git. O navegador nunca recebe a chave.

## Atualização e diagnóstico

```bash
conclave update --check
conclave update --local
conclave update --global
conclave doctor .
```

Se já estiver na última versão, `conclave update` explica isso claramente e não tenta executar um binário local inexistente.

## Vereditos e limites

| Veredito | Significado | Próxima ação |
| --- | --- | --- |
| `PASS` | Nenhum blocker ou warning determinístico encontrado | Rodar testes relevantes e pedir review humano |
| `WARN` | Ainda existe risco revisável | Inspecionar ou corrigir e conferir novamente |
| `BLOCK` | Evidência contradiz escopo, claims ou segurança estrutural | Enviar o handoff ao coding agent e conferir novamente |
| `INCONCLUSIVE` | A evidência não permite uma conclusão segura | Melhorar base, objetivo, contrato ou parser |

Quando não há diff, o resultado é “Nothing to review”, não uma falha inventada.

Veja o [changelog](CHANGELOG.pt-BR.md) para mudanças publicadas e futuras, o [roadmap](ROADMAP.md), os [limites de segurança](docs/security.md), a [linhagem de review e os recibos](docs/review-lineage.md) e o [schema do relatório](schemas/validation-report.v2.schema.json).

## Desenvolvimento

```bash
npm install
npm run verify
```

Contribuições são bem-vindas sob a [licença MIT](LICENSE). Veja [CONTRIBUTING.md](CONTRIBUTING.md).
