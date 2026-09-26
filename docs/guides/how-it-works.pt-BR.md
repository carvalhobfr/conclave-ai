# Como o review do Conclave funciona

[English](how-it-works.md) · [Português (Brasil)](how-it-works.pt-BR.md) · [← README](../../README.pt-BR.md)

O review é análise determinística de código, não uma resposta de chat. Nenhum código é enviado a um modelo e nenhuma chave de API é necessária.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-review-pipeline.svg" alt="A comparação Git passa por índice estrutural, grafo de impacto, checks e um veredito com evidências" width="900"></p>

1. **O Git** fornece a comparação e o patch exatos.
2. **Parsers locais** identificam arquivos e unidades de código: funções, métodos, classes, interfaces e módulos nomeados.
3. **Um grafo de relações** acompanha imports, exports, chamadas, referências, containers e consumidores.
4. **Checks determinísticos** questionam escopo, código público alterado sem teste alterado, erros visíveis ao parser, impacto fora do diff, deleções e claims opcionais. Também apontam defeitos visíveis no próprio texto alterado: um recurso obtido e nunca liberado, um erro engolido por um `catch` vazio e um armazenamento endereçado por literal onde o mesmo arquivo usa uma constante nomeada.
5. **Um veredito** (`PASS`, `WARN`, `BLOCK` ou `INCONCLUSIVE`) com evidência de arquivo e linha sempre que disponível.

Isso é evidência útil, não compilador, test runner, scanner de segurança, prova de execução nem aprovação automática. A decisão do merge continua humana.

## Linguagens suportadas

| Linguagem | Funções/classes | Imports | Grafo de impacto | Detecção de testes |
| --- | ---: | ---: | ---: | ---: |
| TypeScript / JavaScript / TSX / JSX | Sim | Sim | Sim | Sim |
| Python | Sim | Sim | Sim | Sim |
| Java | Sim | Sim | Sim | Sim |

Outras linguagens textuais aparecem no diff e na evidência de escopo, sem a mesma profundidade do grafo. Veja o [roadmap](../../ROADMAP.md).

## Cobertura e quando vale usar um modelo

Cada relatório diz quais regras restritas examinaram a mudança e quais perguntas continuam abertas. Um achado, ou a falta dele, nunca verifica uma área de risco inteira.

| Cobertura | Significado |
| --- | --- |
| `partial` | Regras aplicáveis examinaram só o escopo declarado. Consulte `checks` e `remainingQuestions`. |
| `unchecked` | Nenhuma regra determinística aplicável examinou esta área no código disponível. |

`escalation.recommended` indica que vale verificar mais: testes relevantes, revisão humana ou raciocínio opcional de modelo (`conclave investigate`). Isso nunca inicia um modelo nem executa scripts do repositório sozinho, e um modelo não substitui evidência de execução.

```bash
conclave check . --json | jq '.report.escalation'
```

## Vereditos

| Veredito | Significado | Próxima ação |
| --- | --- | --- |
| `PASS` | Nenhum blocker ou warning determinístico encontrado | Rodar testes relevantes e pedir review humano |
| `WARN` | Ainda existe risco a revisar | Inspecionar ou corrigir e conferir de novo |
| `BLOCK` | A evidência contradiz escopo, claims ou segurança estrutural | Enviar o handoff ao coding agent e conferir de novo |
| `INCONCLUSIVE` | A evidência disponível não permite uma conclusão segura | Melhorar base, objetivo, contrato ou evidência do parser |

Uma comparação sem arquivos alterados mostra "Nothing to review", não uma falha.

## O que o Conclave nunca faz

O review é somente leitura: não altera código, não executa scripts, não faz commit, push, aprovação nem merge. Salvar critérios e feedback grava só metadados locais de review. Os comandos separados `collect` e `smoke` executam um plano limitado apenas quando você os chama. Veja [limites de segurança](../security.md).

## Referência

- [Linhagem de review e recibos](../review-lineage.md)
- [Critérios de aceite](../acceptance.md) · [Evidências de CI](../ci-evidence.md) · [Browser smoke](../browser-smoke.md)
- Schema do relatório: [v5](../../schemas/validation-report.v5.schema.json) (versões anteriores em [`schemas/`](../../schemas))
