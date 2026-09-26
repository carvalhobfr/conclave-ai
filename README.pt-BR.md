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

[Início rápido](#início-rápido) · [CLI](docs/guides/cli.pt-BR.md) · [Cockpit](docs/guides/cockpit.pt-BR.md) · [Skill de agente](docs/guides/agent-skill.pt-BR.md) · [GitHub Actions](docs/guides/github-actions.pt-BR.md) · [FAQ](#perguntas-frequentes)

</div>

---

O Conclave fica entre uma mudança de código e a aprovação dela. Ele compara a mudança real do Git, mapeia o código ao redor e aponta riscos com evidência de arquivo e linha, depois entrega a próxima ação para você, para o seu coding agent ou para quem vai revisar.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-pr-flow.svg" alt="Uma mudança passa pelo contexto e pelas evidências do Conclave antes da aprovação humana e do merge" width="920"></p>

```text
mudança → review do Conclave → agente corrige → Conclave confere de novo → humano aprova → merge
```

## Conteúdo

- [Por que o Conclave](#por-que-o-conclave)
- [Instalação](#instalação)
- [Início rápido](#início-rápido)
- [Um motor, três jeitos de usar](#um-motor-três-jeitos-de-usar)
- [Receitas](#receitas)
- [Vereditos e códigos de saída](#vereditos-e-códigos-de-saída)
- [Configuração](#configuração)
- [Privacidade e segurança](#privacidade-e-segurança)
- [Comparação com outras ferramentas](#comparação-com-outras-ferramentas)
- [Perguntas frequentes](#perguntas-frequentes)
- [Solução de problemas](#solução-de-problemas)
- [Documentação](#documentação)

## Por que o Conclave

- **Revisa a mudança que você tem de verdade.** Commits da branch e arquivos preparados, alterados e novos numa única passada, contra uma base detectada automaticamente.
- **Segue o raio de impacto.** Um grafo local de código encontra quem chama, importa e consome o que você mudou, inclusive fora do diff.
- **Evidência, não achismo.** Todo achado aponta arquivo e linha e diz o que fazer. Nenhum achado afirma mais do que a regra verificou.
- **Feito para coding agents.** Cada review gera um prompt de correção, e a nova conferência distingue progresso real do mesmo diff reenviado, de estagnação e de regressão.
- **Privado e gratuito por padrão.** O review roda localmente e de forma determinística: sem chave de API, sem código enviado a modelo, sem telemetria.
- **Somente leitura.** O Conclave nunca altera arquivos, faz commit, push, aprovação ou merge.
- **Qualquer repositório.** Análise profunda para TypeScript, JavaScript, Python e Java; qualquer outro arquivo de texto ainda conta para escopo e diff.

## Instalação

Requisitos: **Node.js 20+** e **Git**. O projeto revisado pode ser de qualquer linguagem.

```bash
npm install -g conclave-ai          # recomendado: uma instalação para todos os repositórios
```

Outras opções:

```bash
npm install --save-dev conclave-ai  # por projeto, depois: npx conclave check .
yarn add --dev conclave-ai          # depois: yarn conclave check .
pnpm add --save-dev conclave-ai     # depois: pnpm exec conclave check .
npx --yes conclave-ai check .       # rodar uma vez sem instalar
```

Confira a instalação com `conclave --version` e `conclave doctor .`.

## Início rápido

```bash
cd seu-repositorio
conclave check .
```

Exemplo de saída para uma branch que adicionou um parâmetro de senha ao `login()`:

```text
PR summary: Update src/auth.ts
Comparison: Current workspace compared with master
This change updates 1 file, touches 1 code units, and may affect 2 files through local dependencies.
Verdict: WARN

Risks:
- WARNING: Changed code has an empty catch block
- WARNING: The change affects code outside the diff
- WARNING: Exported behavior changed without a test change

Next steps:
- Review the findings, correct confirmed problems and collect the missing verification evidence.

Next for your coding agent:
Address the Conclave review findings below.
  - src/auth.ts:2: Changed code has an empty catch block
  - src/app.ts:1: explicit named import login
  - src/auth.ts:1: Changed exported symbol without changed test evidence
```

O relatório completo também lista o que ainda falta verificar e os desafios independentes que valem a pena rodar, e fica salvo no histórico local. Com `conclave config --language pt-BR`, a saída aparece em português.

Não sabe o que rodar? Digite `conclave` para abrir o menu guiado, ou `conclave help <comando>` para qualquer comando.

## Um motor, três jeitos de usar

| | Produto | Ideal para | Comece com | Guia |
| --- | --- | --- | --- | --- |
| ⌨️ | **CLI** | Terminal, scripts e CI | `conclave check .` | [Guia da CLI](docs/guides/cli.pt-BR.md) |
| 🖥️ | **Cockpit** | Ler resultados, diffs e histórico no navegador | `conclave open .` | [Guia do cockpit](docs/guides/cockpit.pt-BR.md) |
| 🤖 | **Skill de agente** | Fazer o Claude Code ou o Codex revisar o próprio trabalho antes do merge | `conclave setup .` | [Guia da skill](docs/guides/agent-skill.pt-BR.md) |

E ainda um [workflow pronto de GitHub Actions](docs/guides/github-actions.pt-BR.md) que comenta em cada pull request. Todos usam o mesmo motor local e compartilham configurações e histórico.

## Receitas

**Revisar antes de abrir o pull request**

```bash
conclave check . --objective "Adicionar login sem senha sem quebrar a restauração da sessão"
```

**Comparar duas branches sem trocar o checkout**

```bash
conclave compare .                                     # escolher numa lista
conclave compare . --base origin/main --head feature/login --objective "Adicionar login sem senha"
```

**Passar os achados ao coding agent e conferir de novo**

```bash
conclave check . --json > review.json
conclave handoff .                                     # prompt para colar no agente
# …o agente corrige…
conclave check . --previous-report review.json         # mesma série: progresso, estagnação ou regressão
```

**Deixar o agente fazer isso por você**

```bash
conclave setup .
# depois peça ao Claude Code ou Codex: "Está pronto para merge? Confere com o Conclave."
```

**Bloquear o CI pelo veredito**

```bash
conclave setup . --agents none --github-actions        # ou, em qualquer CI:
conclave check . --base origin/main --json > conclave.json   # saída 1 = BLOCK, 2 = INCONCLUSIVE
```

**Usar o relatório em scripts**

```bash
conclave check . --json | jq '.report.findings[] | {severity, title, file: .evidence[0].path, line: .evidence[0].startLine}'
```

O JSON tem três campos de topo: `summary`, `report` (veja o [schema](schemas/validation-report.v5.schema.json)) e `handoff`. Os nomes dos campos são estáveis e sempre em inglês.

## Vereditos e códigos de saída

| Veredito | Saída | Significado | Próxima ação |
| --- | ---: | --- | --- |
| `PASS` | 0 | Nenhum blocker ou warning determinístico encontrado | Rodar seus testes e pedir review humano |
| `WARN` | 0 | Ainda existe um risco a revisar | Inspecionar ou corrigir e conferir de novo |
| `BLOCK` | 1 | A evidência contradiz escopo, claims ou segurança estrutural | Enviar o handoff ao coding agent e conferir de novo |
| `INCONCLUSIVE` | 2 | A evidência não permite uma conclusão segura | Melhorar base, objetivo ou critérios |

`PASS` é evidência, não aprovação. Uma comparação sem arquivos alterados mostra "Nothing to review". [Como o review funciona →](docs/guides/how-it-works.pt-BR.md)

## Configuração

O review **não precisa de configuração nem de chave**. Um modelo só é usado pelos modos opcionais Ask e Investigate:

```bash
conclave init                               # provider → modelo → chave de API, três passos
conclave config                             # mostra cada configuração e de onde ela vem
conclave config set api-key                 # troca a chave (entrada oculta)
conclave config set model deepseek-v4.1-flash
conclave config --language pt-BR            # interface em português ou espanhol (es-ES)
```

| Provider | Observações |
| --- | --- |
| OpenCode Go | Padrão recomendado de baixo custo |
| OpenAI, Anthropic, OpenRouter | Perfis de modelo mantidos; qualquer ID de modelo funciona |
| Ollama, LM Studio | Totalmente local, nada sai da sua máquina; veja [modelos locais](docs/guides/cli.pt-BR.md#modelos-locais) |

As configurações ficam por usuário em `~/.config/conclave/credentials.env` (permissão só do dono). Variáveis do shell têm prioridade, depois um `.env` do projeto, depois as configurações do usuário. [Todas as configurações e variáveis de ambiente →](docs/guides/cli.pt-BR.md#configurações-e-chaves-de-api)

## Privacidade e segurança

| | Review (`check`, `compare`, `review`) | Ask / Investigate |
| --- | --- | --- |
| Código enviado a modelo | Nunca | Trechos limitados, só ao provider que você configurou |
| Chamadas de rede | Nenhuma | Só o seu provider |
| Precisa de chave de API | Não | Sim (ou um modelo local) |
| Executa scripts do repositório | Nunca | Nunca |
| Telemetria | Nenhuma | Nenhuma |

O Conclave só grava em `.conclave/` no seu repositório (cache do mapa de código, histórico, critérios) e na sua pasta de configurações de usuário. O cockpit escuta apenas em `127.0.0.1`, e o navegador nunca recebe a sua chave de API. Veja [limites de segurança](docs/security.md).

## Comparação com outras ferramentas

| | Encontra | Precisa de | Papel do Conclave |
| --- | --- | --- | --- |
| Type checker / linter | Erros de tipo, estilo, padrões ruins conhecidos | Setup de build | Complementar. Anexe os resultados a um review com `--receipt`. |
| Suíte de testes | Regressões de comportamento cobertas | Testes | Complementar. O Conclave aponta código público alterado sem teste alterado. |
| Revisor de código com IA | Qualquer coisa, com precisão variável | Enviar código a um modelo | O Conclave é determinístico e local; raciocínio de modelo é opcional e separado do veredito. |
| **Conclave** | Desvio de escopo, raio de impacto, testes faltando, erros engolidos, claims não cumpridas | Git | Evidência e próxima ação para quem decide, pessoa ou agente. |

## Perguntas frequentes

**O Conclave envia meu código para algum lugar?**
Não durante o review. Só Ask e Investigate chamam um modelo, e apenas o provider que você configurou. Com Ollama ou LM Studio, nada sai da sua máquina.

**É gratuito?**
Sim, licença MIT, e o review não custa nada para rodar. Ask e Investigate custam o que o seu provider cobra; o preset Essential mediu cerca de US$ 0,0015 por execução no nosso product lab.

**Meu projeto não é JavaScript. Funciona?**
Sim. Node.js é só o runtime do Conclave. TypeScript, JavaScript, Python e Java têm o grafo completo; outras linguagens têm evidência de diff, escopo e arquivo.

**Devo commitar `.conclave/`?**
Não. Adicione `.conclave/` ao `.gitignore`; ele guarda o cache local e o histórico de reviews.

**`PASS` significa que posso fazer merge?**
Não. Significa que os checks determinísticos não encontraram blocker nem warning. Rode seus testes e peça review a uma pessoa. O Conclave nunca aprova nem faz merge.

**Ele corrige os problemas que encontra?**
Não, de propósito. Ele escreve um prompt de correção para o seu coding agent e confere o resultado.

**Qual a diferença de pedir para uma IA revisar meu PR?**
O veredito vem de regras determinísticas com evidência citada, então a mesma mudança sempre recebe a mesma resposta, e um modelo confiante não consegue convencê-lo a aprovar.

## Solução de problemas

| Problema | Solução |
| --- | --- |
| `Nothing to review` | Não há mudanças contra a base detectada. Informe uma: `conclave check . --base origin/main`. |
| Base errada detectada | Use `--base <ref>`. Rode `git fetch` antes se a base for uma branch remota. |
| `conclave: command not found` | Instale globalmente (`npm install -g conclave-ai`) ou use `npx conclave`. |
| Ask diz que falta chave ou modelo | Rode `conclave init` e depois `conclave provider-check`. |
| Uma configuração não muda | `conclave config` mostra de onde vem cada valor; variável do shell ou `.env` do projeto têm prioridade sobre as configurações do usuário. |
| Porta do cockpit em uso | `conclave open . --port 4318` |
| Skill de agente estoura o tempo num repositório grande | Defina `CONCLAVE_TIMEOUT_MS=600000` (o padrão é 300000). |
| Qualquer outra coisa | `conclave doctor .` verifica Git, linguagens, skills e CI. [Abra uma issue](https://github.com/carvalhobfr/conclave-ai/issues) com a saída dele. |

## Documentação

| Guia | Conteúdo |
| --- | --- |
| [CLI](docs/guides/cli.pt-BR.md) | Todos os comandos, opções, configurações, variáveis de ambiente, modelos locais |
| [Cockpit](docs/guides/cockpit.pt-BR.md) | Interface no navegador, Conclaves salvos, fluxos em três cliques |
| [Skill de agente](docs/guides/agent-skill.pt-BR.md) | Setup no Claude Code e Codex, prompts, ciclo de correção, MCP |
| [GitHub Actions](docs/guides/github-actions.pt-BR.md) | Workflow de pull request e evidências de CI |
| [Como funciona](docs/guides/how-it-works.pt-BR.md) | Pipeline, linguagens, cobertura, quando vale usar um modelo |
| [Linhagem de review](docs/review-lineage.md) | Séries de correção, recibos, rebaselines (em inglês) |
| [Segurança](docs/security.md) | Limites de confiança e modelo de ameaças (em inglês) |
| [Changelog](CHANGELOG.pt-BR.md) · [Roadmap](ROADMAP.md) | Versões e direção |

## Contribuindo

```bash
git clone https://github.com/carvalhobfr/conclave-ai.git
cd conclave-ai
npm install
npm run verify      # typecheck, lint, build, testes, avaliações, audit
```

Issues e pull requests são bem-vindos. Veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE)
