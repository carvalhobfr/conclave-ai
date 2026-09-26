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

[Comece em 30 segundos](#comece-em-30-segundos) · [CLI](docs/guides/cli.pt-BR.md) · [Cockpit](docs/guides/cockpit.pt-BR.md) · [Skill de agente](docs/guides/agent-skill.pt-BR.md) · [GitHub Actions](docs/guides/github-actions.pt-BR.md) · [Como funciona](docs/guides/how-it-works.pt-BR.md)

</div>

---

O Conclave entra depois da mudança de código e antes da aprovação. Ele compara a mudança real do Git, mapeia o código ao redor, aponta riscos com evidência de arquivo e linha e entrega a próxima ação para você, para o seu coding agent ou para quem vai revisar.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-pr-flow.svg" alt="Uma mudança passa pelo contexto e pelas evidências do Conclave antes da aprovação humana e do merge" width="920"></p>

```text
mudança → review do Conclave → agente corrige → Conclave confere de novo → humano aprova → merge
```

**Sem chave de API. Nenhum código enviado a modelo. Somente leitura.** O review é análise determinística de código; nunca altera arquivos, faz commit, push, aprova ou faz merge.

## Comece em 30 segundos

Você precisa de Node.js 20+ e Git. O projeto analisado não precisa ser Node.

```bash
npm install -g conclave-ai
conclave check .
```

Isso revisa os commits da branch e todos os arquivos preparados, alterados e novos, e mostra resumo, achados, evidências e um prompt que o seu coding agent pode executar. Não sabe o que rodar? Digite `conclave` para abrir o menu guiado.

Prefere não instalar? `npx --yes conclave-ai check .` também funciona.

## Um motor, três jeitos de usar

| | Produto | Ideal para | Comece com | Guia |
| --- | --- | --- | --- | --- |
| ⌨️ | **CLI** | Revisar pelo terminal, scripts e CI | `conclave check .` | [Guia da CLI](docs/guides/cli.pt-BR.md) |
| 🖥️ | **Cockpit** | Ler resultados, diffs e histórico no navegador | `conclave open .` | [Guia do cockpit](docs/guides/cockpit.pt-BR.md) |
| 🤖 | **Skill de agente** | Fazer o Claude Code ou o Codex revisar o próprio trabalho antes do merge | `conclave setup .` | [Guia da skill](docs/guides/agent-skill.pt-BR.md) |

E ainda um [workflow pronto de GitHub Actions](docs/guides/github-actions.pt-BR.md) que comenta em cada pull request.

Os três usam o mesmo motor local e as mesmas configurações, então um review feito em um aparece no histórico dos outros.

## O que o veredito significa

| Veredito | Significado | Próxima ação |
| --- | --- | --- |
| `PASS` | Nenhum blocker ou warning determinístico encontrado | Rodar seus testes e pedir review humano |
| `WARN` | Ainda existe um risco a revisar | Inspecionar ou corrigir e conferir de novo |
| `BLOCK` | A evidência contradiz escopo, claims ou segurança estrutural | Enviar o handoff ao coding agent e conferir de novo |
| `INCONCLUSIVE` | A evidência não permite uma conclusão segura | Melhorar base, objetivo ou critérios |

`PASS` é evidência, não aprovação: o Conclave não é compilador, test runner nem scanner de segurança, e a decisão do merge continua humana. [Como o review funciona →](docs/guides/how-it-works.pt-BR.md)

## Opcional: IA para Ask e Investigate

O review nunca precisa de chave. Um modelo só é usado quando você faz perguntas sobre o código:

```bash
conclave init                  # provider → modelo → chave de API, três passos
conclave config set api-key    # trocar a chave depois (entrada oculta)
```

As chaves ficam salvas por usuário em `~/.config/conclave/credentials.env`, com permissão só do dono, e nunca chegam ao navegador. [Todas as configurações →](docs/guides/cli.pt-BR.md#configurações-e-chaves-de-api)

## Saiba mais

- [Como o review funciona](docs/guides/how-it-works.pt-BR.md): pipeline, linguagens, cobertura e quando vale usar um modelo
- [Linhagem de review e recibos](docs/review-lineage.md): ciclos de correção e evidências de teste anexadas
- [Limites de segurança](docs/security.md)
- [Changelog](CHANGELOG.pt-BR.md) · [Roadmap](ROADMAP.md)

## Desenvolvimento

```bash
npm install
npm run verify
```

Contribuições são bem-vindas sob a [licença MIT](LICENSE). Veja [CONTRIBUTING.md](CONTRIBUTING.md).
