# Laboratório: o Conclave encontra problemas úteis?

**Escopo:** este laboratório testa apenas `conclave check`, sem IA. Para comparar Ask, Investigate e modelos reais, siga [o laboratório com IA](product-lab-ai.md). Não generalize os resultados offline para o produto com raciocínio por modelos.

Este laboratório cria **10 repositórios Git independentes**, dentro de `.conclave/product-lab/run-XXXXXX/repos/`. Cada um tem um commit inicial correto em `main` e um commit em `candidate`. Sete candidatos contêm regressões e três preservam o comportamento. São projetos sintéticos pequenos, sem dependências, credenciais ou downloads. Nenhum repositório externo foi clonado.

O objetivo é medir a revisão completa pela CLI, incluindo Git, análise e relatório. Não basta o comando funcionar ou imprimir WARN. Um teste de comportamento independente estabelece o gabarito de cada caso. Não se espera artificialmente que o Conclave acerte todos.

## Suítes

`basic` (padrão) contém os dez casos abaixo. `hard` contém 20 cenários com vários arquivos, refatoração misturada ao defeito e objetivos no formato de ticket: 14 defeitos (off-by-one, `||` vs `??`, `forEach` assíncrono, cache sem invalidação, comparador booleano, path traversal codificado, ponto flutuante em dinheiro, endpoint sem checagem de dono, retry não idempotente, `bind` no `destroy`, regex sem âncoras, estado compartilhado, resposta antiga sobrescrevendo, `allSettled` escondendo falha) e 6 refatorações saudáveis que parecem perigosas. Cada cenário tem categoria e oráculo executável em `tests/product-lab/cases-hard.mjs`. Selecione com `CONCLAVE_LAB_SUITE=hard` em `prepare` ou `all`; `review` e `score` usam a suíte gravada no `manifest.json`.

## Os dez testes

| Caso | Alteração | Gabarito de comportamento |
|---|---|---|
| 01 | Remoção do cleanup de um listener | Callback continua executando depois de dispose: defeito |
| 02 | Remoção do cancelamento de um timer | Registro do timer continua ativo depois de stop: defeito |
| 03 | Catch vazio em gravação assíncrona | Falha do gravador resolve como sucesso: defeito |
| 04 | Chave diferente na gravação e leitura | Valor salvo não é recuperado: defeito |
| 05 | Cleanup usa outro callback com o mesmo nome de parâmetro | Callback original continua ativo: defeito semântico |
| 06 | Retorno de sucesso sem executar gravação | Valor não é armazenado: defeito semântico |
| 07 | Condição de autorização invertida | Admin recusado e usuário comum autorizado: defeito semântico |
| 08 | Refatoração correta do cleanup no módulo | Callback removido e comportamento preservado: saudável |
| 09 | Cleanup correto delegado a outro módulo | Callback removido pelo helper: saudável, desafia falsos positivos |
| 10 | Refatoração de cálculo e comentário com código suspeito | Cálculo preservado; comentário não executa: saudável |

Os casos 01 e 02 são deleções reais de cleanup. O registro pode estar fora da linha alterada: isso também testa a capacidade de perceber a regressão pelo diff. Não transformar o registro em uma nova linha só para ajudar uma regra.

## Execução completa

Requisitos: Node 20 ou superior, Git e dependências do checkout já instaladas. Se faltarem dependências, execute `npm ci` antes. Não precisa de chave de API.

Na raiz do Conclave:

```sh
npm run build:core
node scripts/product-lab.mjs all
```

Cada execução cria uma pasta nova e imprime seu caminho. Não apaga resultados antigos, não faz push, não publica pacotes e não modifica a implementação do Conclave. `build:core` atualiza o executável local em `dist/`.

A sequência é: criar os repositórios → revisar os 10 candidatos → guardar os relatórios e seus hashes → executar os oráculos fora dos repositórios → calcular resultados. O Conclave não recebe gabaritos, títulos dos defeitos, testes do oráculo ou arquivos de resultado como contexto do repositório revisado.

## Execução em etapas para outra IA

```sh
npm run build:core
node scripts/product-lab.mjs prepare
```

Copie o caminho absoluto exibido por `prepare` e use o **mesmo caminho** nas duas etapas:

```sh
node scripts/product-lab.mjs review /CAMINHO/EXATO/DA/EXECUCAO
node scripts/product-lab.mjs score /CAMINHO/EXATO/DA/EXECUCAO
```

`review` chama a CLI real para cada repositório, com base Git explícita e objetivo funcional. `score` exige os dez relatórios anteriores, confere hashes, verifica que os candidatos não foram alterados e executa os testes independentes.

Para comparar outra instalação, use `CONCLAVE_LAB_CLI` com o caminho absoluto do `dist/cli.js` dessa instalação. Use uma execução nova para cada versão; conserve seus resultados separadamente. O programa não instala nem baixa essa versão por conta própria.

## Evidências produzidas

- `manifest.json`: caminhos, objetivos e commits de cada repositório.
- `repos/case-01` até `repos/case-10`: projetos Git reais para inspeção manual.
- `baselines/`: cópias corretas que também precisam passar no teste independente.
- `reports/NN.stdout.json`: saída original completa do Conclave.
- `reports/NN.stderr.txt`: erros e mensagens auxiliares.
- `review-ledger.json`: argumentos, códigos de saída, duração e hashes dos relatórios.
- `oracles/NN.mjs`: teste de comportamento executável fora do repositório.
- `oracles/NN.result.json`: saída e status do teste na versão inicial e candidata.
- `score.json`: métricas, achados, lacunas e limitações.
- `RESULTADO.md`: tabela resumida para leitura.

Para repetir somente o comportamento de um caso, a partir da pasta da execução:

```sh
node oracles/01.mjs "$PWD/baselines/case-01/src/feature.js"
node oracles/01.mjs "$PWD/repos/case-01/src/feature.js"
```

A primeira chamada deve imprimir `ORACLE_PASS` e sair com 0. No caso 01 a segunda deve imprimir `ORACLE_ASSERTION_FAILED` e sair com 1. Esse erro é o defeito deliberado. Um erro de importação, timeout ou falha da ferramenta **não** vale como defeito comprovado.

## Como interpretar sem maquiar o resultado

- **TP:** candidato defeituoso e regra relacionada aponta o problema em `src/feature.js`.
- **FN:** candidato defeituoso sem esse achado específico. PASS, WARN genérico, aviso de ausência de testes e pedido de revisão humana não contam como detecção.
- **FP:** candidato saudável recebe uma das regras de defeito de fonte. Aqui significa sinal desnecessário para o comportamento testado, não necessariamente uma afirmação categoricamente falsa do relatório.
- **TN:** candidato saudável sem esses achados específicos. Pode haver outros avisos, registrados separadamente.
- **Precisão:** TP / (TP + FP). **Recall:** TP / (TP + FN).

O programa mapeia três regras conhecidas (`unreleased-resource`, `discarded-error`, `inconsistent-key`). Casos sem regra mapeada contam conservadoramente como FN. Se uma versão futura detectar um deles por outra regra, anote a evidência em uma análise adicional, mantendo o score automático original. Não mude o gabarito depois de ver os resultados.

`harnessVerified: true` e saída 0 significam que o laboratório executou corretamente e comprovou seus cenários. **Não significam que o Conclave passou nos dez casos.** `productApproved` permanece `false`: aprovação de produto não é dedutível desta amostra. Uma falha inesperada de preparação, CLI ou oráculo encerra a execução com erro; não a esconda como falso negativo.

Observe também:

1. O achado explica o defeito ou só pede atenção genérica?
2. Arquivo e linha ajudam alguém a corrigir?
3. Quantos avisos surgiram nos três casos saudáveis?
4. O relatório mantém abertas as perguntas que não conseguiu verificar?
5. A recomendação economiza trabalho ou exige investigar um comportamento já correto?

Estes são testes de módulos JavaScript. Eventos usam `EventTarget`; armazenamento usa um adaptador em memória; timers usam registro controlado; autorização é testada como função. Não há navegador real, reinício de processo para persistência, servidor HTTP ou avaliação de outras linguagens. Dez casos sintéticos não estimam acurácia comercial nem substituem o piloto com PRs reais.

## Prompt pronto para uma IA executora

> Trabalhe na raiz deste checkout do Conclave. Leia `docs/product-lab.md`. Sua tarefa é executar e auditar o laboratório, sem corrigir o Conclave nem os cenários. Rode `npm run build:core` e `node scripts/product-lab.mjs all`. Se faltar dependência, rode `npm ci`; não configure provedores nem credenciais. Guarde o caminho da execução. Leia `RESULTADO.md`, `score.json`, os dez relatórios originais e os resultados dos dez oráculos. Confirme que todas as versões iniciais passam, os sete candidatos defeituosos falham por assertion e os três saudáveis passam. Apresente uma tabela com os dez casos, defeito real, veredito do Conclave, achado específico com arquivo/linha, TP/FP/TN/FN e avisos genéricos. Informe precisão e recall como métricas desta amostra sintética. Não conte WARN, sugestão de testes ou escalonamento como detecção. Para cada FN, explique o que o teste independente comprovou e o que o Conclave deixou passar. Para cada FP, explique por que o comportamento é correto. Cite os arquivos de evidência. Não altere os gabaritos, esconda erros, faça commit/push ou declare o produto aprovado. Se houver falha do laboratório, reporte o comando e o erro e pare antes de concluir sobre o produto.
