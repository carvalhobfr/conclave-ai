# Laboratório com IA: comparação de modos

O laboratório original executa somente `conclave check`, com **zero chamadas de modelo**. Seus 2 acertos em 7 defeitos medem a camada determinística, não Ask ou Investigate.

| Dimensão | Valores | Significado |
|---|---|---|
| Comando | check | Revisão determinística, sem IA |
| Comando | ask | Caminho investigator-judge |
| Comando | investigate | Caminho conclave, com seleção condicional de papéis |
| Runtime | free | Provedor externo em CONCLAVE_FREE_*; exige modelo e credencial; o nome não comprova custo zero |
| Runtime | api | Provedor externo em CONCLAVE_* |
| Runtime | local | IA local em Ollama/LM Studio; local não significa sem IA |
| Preset | free-like | Roteamento econômico; exclui Architect |
| Preset | full | Permite papéis adicionais quando necessários; não garante cinco agentes |
| Preset | local | Preset do runtime local; também usa modelo |

Os cartões Essential e Free trial são configurações de provedor/modelo/preset (OpenCode Go com Investigate/full), não motores independentes: `deepseek-v4.1-flash` e `space-bunny-free`. Modelos caros (deepseek-v4-pro, qwen3.8-max) foram retirados dos cartões por custo; continuam testáveis com `CONCLAVE_LAB_MODELS`. Nomes de modelo não provam disponibilidade; o preflight de cada linha decide.

## Execução

Requer dependências instaladas e configuração dos provedores. Faz chamadas reais, potencialmente cobradas, enviando somente código dos repositórios sintéticos. Não altera `.env` nem imprime credenciais.

```sh
npm run build:core
node scripts/product-lab.mjs all
node scripts/product-lab-ai.mjs run /CAMINHO/DA/EXECUCAO/OFFLINE
```

Cada execução cria `ai-XXXXXX` dentro do laboratório. Não altere o motor ou execute builds durante o experimento: o digest dos JavaScripts em `dist/` é verificado antes e depois.

A matriz inclui Ask, Investigate/free-like e Investigate/full para API e Free; as linhas `ui-*` dos cartões quando há credencial para o OpenCode Go; Ask e Investigate/local para modelos instalados descobertos no Ollama e LM Studio, somente com `CONCLAVE_LAB_LOCAL=1` (lento: modelos pequenos levam dezenas de minutos); e o resultado offline anterior. `CONCLAVE_LAB_MODELS=modelo-a,modelo-b` acrescenta linhas Ask e Investigate/full para cada modelo no provedor API configurado; `CONCLAVE_LAB_ONLY=id-a,id-b` restringe às linhas listadas, inclusive as geradas (`model-<modelo>-investigate-full`). `CONCLAVE_LAB_MIXES` (JSON) acrescenta linhas Investigate/full com modelo por papel (`roles`) e `fallback`, para comparar misturas. `CONCLAVE_LAB_CONCURRENCY=N` revisa até N casos em paralelo por linha na nuvem (cada caso é um repositório próprio). Rodadas grandes consomem a cota de 5 horas do OpenCode Go; `Go usage limit exceeded` é falha de infraestrutura, não de qualidade. Ask não repete presets que alterariam papéis já excluídos por investigator-judge. Não percorre todos os modelos comerciais. O caminho interno single-pass não é comando público e não integra esta matriz.

## Controles

- CLI real com `--json --debug`, sem respostas simuladas; pergunta idêntica por caso em todos os modos.
- Gabarito e testes independentes ficam fora dos repositórios analisados.
- Commit, base e árvore de trabalho conferidos antes/depois; embedding local feature-hash em todas as linhas.
- Overrides de papéis e fallback removidos somente do ambiente dos subprocessos; todos os papéis usam o modelo da linha e limites padrão do produto.
- Uma execução por célula, sem escolher a melhor resposta; reparos/retries nativos são registrados.
- Limite de cinco minutos por CLI. Timeout e execução incompleta são falhas operacionais, não falsos negativos.
- Preflight precede cada configuração. Credencial, protocolo ou modelo indisponível bloqueiam a linha, sem pontuação de qualidade.
- Credenciais nunca são reaproveitadas em outro provedor/endpoint.

O preload de observação registra modelo solicitado/retornado, papel, HTTP, tokens e duração. Não altera headers, prompts ou respostas e não grava credenciais.

## Evidências e classificação

`experiment.json` fixa matriz, pergunta, limites e digest. Cada configuração contém `preflight.json` e, por caso tentado, `NN.stdout.json`, `NN.stderr.txt`, `NN.calls.jsonl` e `NN.meta.json`. Os arquivos preservam resposta completa, tentativas HTTP, modelos retornados, término, agentes, métricas e digest.

Qualidade de IA não é deduzida de palavras-chave. Um avaliador preenche `adjudications.json` após congelar as respostas, com entradas como:

```json
{
  "configId": "ID_EXATO_DA_CONFIGURACAO",
  "caseId": "01",
  "prediction": "defect",
  "certainty": "uncertain",
  "quote": "Trecho literal da resposta final ou de um claim supported",
  "evidenceIds": ["ID_REAL_DO_RELATORIO"],
  "explanation": "Explique a correspondência entre a falha específica apontada e o comportamento comprovado pelo teste independente."
}
```

`prediction`: defect, clean ou uncertain (abstenção sem diagnóstico concreto). Para defect, `certainty` é obrigatória: supported ou uncertain. A rubrica v2 mede **sinais específicos**, assim como o WARN de uma regra offline: uma hipótese que localiza corretamente o defeito com evidência conta como sinal, mas permanece explicitamente incerta. Um pedido genérico de testes não conta. Claims rejeitados não contam; claims incertos nunca viram prova confirmada. `tentativeTruePositives` e `supportedTruePositives` distinguem os dois resultados. Defeitos exigem evidência de fonte existente. O programa valida citação e IDs; a classificação semântica ainda precisa de revisão independente. Essa rubrica foi definida antes da classificação dos casos; ela não modifica respostas ou gabaritos.

```sh
node scripts/product-lab-ai.mjs table /CAMINHO/DA/PASTA/ai-XXXXXX
```

`COMPARACAO.md` e `comparison.json` conservam todas as linhas. Precisão e taxa de detecção só são calculadas após dez casos completos e classificados. Abstenção aparece separadamente e reduz a detecção sobre os sete defeitos; não é acerto em caso saudável. Falhas ficam sem nota; resultados não classificados ficam pendentes.

## Uso na documentação

Conservar resultados ruins e falhas. Para alegar qualidade: revisar classificações, identificar versão/modelos, repetir para medir variação e acrescentar casos inéditos. Correção de adaptador ou motor exige novo experimento; não combinar versões na mesma linha. Dez casos sintéticos não representam acurácia em PRs reais. Tokens não são custo monetário sem preços verificados. Tempo/chamadas de preflight ficam separados. `publishableAccuracy: false` não muda automaticamente quando a nota sobe.

## Prompt para outra IA

Execute os laboratórios offline e com IA conforme os guias. Não altere o motor, modelos ou gabaritos para favorecer resultados. As chamadas remotas precisam estar autorizadas. Registre impedimentos sem substituir credenciais ou provedores. Classifique somente resultados completos, com citações exatas e IDs de evidência. Registre abstenções e contradições. Gere a tabela distinguindo disponibilidade, qualidade, agentes efetivos, modelos, tokens e tempo. Não generalize o resultado offline para o Conclave com IA nem faça uma alegação promocional com base nesses dez casos.
