# Skill de agente do Conclave

[English](agent-skill.md) · [Português (Brasil)](agent-skill.pt-BR.md) · [← README](../../README.pt-BR.md)

A skill ensina o Claude Code e o Codex a revisar o próprio trabalho com o Conclave antes do merge. O agente escolhe a mudança, roda a [CLI](cli.pt-BR.md), mantém o veredito exatamente como veio, cita evidências e devolve os achados para correção e nova conferência.

## Instalação

No repositório, escolha os agentes e, se quiser, o workflow do GitHub:

```bash
conclave setup .
```

Ou instale direto, sem perguntas:

```bash
conclave skill install --target both --scope project --project .
```

| Opção | Valores |
| --- | --- |
| `--target` | `claude` (`.claude/skills/`), `codex` (`.agents/skills/`), `both` ou `portable --destination <pasta>` para outros agentes |
| `--scope` | `project` (este repositório, pode ser commitado para o time) ou `user` (todos os repositórios da sua máquina) |
| `--force` | Substitui uma cópia existente diferente |

Sem instalação global, use o prefixo `npx --yes --package=conclave-ai@latest`; nada é adicionado ao `package.json`.

## Como usar

Peça em linguagem natural:

- "Use o Conclave para revisar a mudança atual antes do merge."
- "Isso está pronto para merge?"
- "Você terminou mesmo? Confere com o Conclave."
- "Compara `feature/login` com `main` usando o Conclave."

O agente responde com:

1. o veredito e o resumo;
2. o achado mais importante, com arquivo e linha;
3. a próxima ação; e
4. o que ficou sem verificação.

A leitura que o próprio agente faz do código aparece separada, sob o título "model review", e nunca muda o veredito do Conclave. Peça o JSON bruto quando quiser.

## Ciclo de correção

```text
review → agente corrige os achados citados → confere de novo com --previous-report → você aprova
```

Em `BLOCK`, `WARN` ou `INCONCLUSIVE`, o agente devolve a evidência e o prompt de correção, corrige e revisa de novo na mesma série. O Conclave aponta repetição do mesmo diff, achados que não somem e regressões.

## Regras que a skill garante

- `BLOCK` e `INCONCLUSIVE` nunca viram aprovação, e `WARN` nunca é chamado de totalmente provado.
- Confiança do agente ou uma mensagem de "pronto" nunca contam como evidência.
- Scripts do repositório não rodam sem a sua autorização. O agente pede que você rode o seu type checker e linter e anexa os resultados como recibos.
- O agente nunca lê, mostra ou configura chaves de API. O review não precisa de uma.

## Como a skill encontra o Conclave

Nesta ordem:

1. `CONCLAVE_CLI_PATH`;
2. um `dist/cli.js` cujo `package.json` seja `conclave-ai` (a CLI própria de outro projeto nunca é executada);
3. `CONCLAVE_BIN`;
4. um `conclave` global no `PATH`;
5. `npx`, fixado na versão da skill.

Instale globalmente (`npm install -g conclave-ai`) para os reviews começarem sem download. O primeiro review de um repositório grande monta o mapa de código; aumente `CONCLAVE_TIMEOUT_MS` acima do padrão de 300000 ms se precisar.

## MCP

Clientes que falam MCP podem chamar o Conclave como ferramenta:

```bash
conclave mcp /caminho/do/repositorio
```

A skill prefere a ferramenta MCP `conclave_validate` quando ela está disponível e aplica as mesmas regras ao relatório.
