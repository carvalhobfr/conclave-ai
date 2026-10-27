# Changelog

Todas as mudanças relevantes do Conclave são documentadas aqui. O projeto segue [Versionamento Semântico](https://semver.org/lang/pt-BR/) e a estrutura do [Keep a Changelog](https://keepachangelog.com/pt-BR/).

[English](CHANGELOG.md) · [Português (Brasil)](CHANGELOG.pt-BR.md)

## [0.22.0] — 2026-10-27

- Novo `conclave commits [path]`: commits recentes, do mais novo ao mais antigo, com autor, data e tamanho. `--analyze` roda a revisão determinística em cada commit contra o primeiro pai (veredito, contagem de achados e principais achados; sem chamada de modelo, sem executar código do repositório, nada extraído). `--base`, `--head` e `--limit` escolhem o intervalo e `--json` segue o novo `schemas/commit-timeline.v1.schema.json`. Biblioteca: novo `commits()`.

## [0.21.0] — 2026-10-22

Provedores por assinatura: Ask e Investigate podem usar o plano do Claude ou do Codex que você já paga, sem chave de API.

- Novos provedores `claude-cli` e `codex-cli` rodam o `claude` e o `codex` instalados com o login da sua assinatura, então os pedidos não precisam de chave de API. Os dois podem ser escolhidos no cockpit e com `CONCLAVE_PROVIDER`. O prompt vai pelo stdin com limite de tempo, as chaves de API são removidas do ambiente deles para usar a assinatura, e eles rodam numa pasta temporária; o Claude roda em modo print com ferramentas desligadas e sem fontes de configuração, o Codex em modo exec com sandbox só de leitura, ignorando a configuração do usuário. `CONCLAVE_CLAUDE_COMMAND` e `CONCLAVE_CODEX_COMMAND` trocam o binário.
- O build mantém `dist/cli.js` executável, então um checkout ligado (`npm link`) continua rodando `conclave` depois de `npm run build`, em vez de falhar com "permission denied".

## [0.20.0] — 2026-10-13

Inteligência de Repositório: auditorias do repositório inteiro, um registro de achados com triagem humana, propostas de issue locais e o cockpit de repositório. É a primeira versão no npm desde a 0.18.0; ela também traz as mudanças da 0.19.0 abaixo, que nunca foi publicada.

- Correções da auditoria vindas da revisão: um arquivo excluído que apenas compartilha o radical com um import (`foo.test.ts` para `./foo`, `foo.json` para `./foo.js`) não esconde mais um import quebrado; uma auditoria Smart ou Deep compara o tamanho da região mostrada ao verificador com `--max-input-tokens` antes da chamada, em vez de assumir 2.000 tokens; e quando mais de 50 arquivos são retidos por segurança, os arquivos de código ficam entre os 50 listados, para que o aviso de código oculto não se perca.
- Grafo entre arquivos: um import com extensão explícita `.js`, `.jsx`, `.mjs` ou `.cjs` agora resolve para o fonte TypeScript que o emite (`./store.js` → `store.ts`), como projetos no estilo NodeNext escrevem. Dois fontes que emitiriam o mesmo arquivo são ambíguos e não geram aresta, e um import nunca resolve para outra linguagem. Neste repositório, os imports relativos resolvidos passam de 5 para 579 de 585 e as arestas entre arquivos de 18 para 3.483.
- Identidade de achados: dois achados do mesmo tipo no mesmo arquivo não compartilham mais `id` e `fingerprint`. Achados com uma única localização são ancorados no símbolo que os contém e na linha sinalizada; uma revisão que continua de um relatório antigo mantém a linhagem sem rebaseline.
- Cobertura: os relatórios ganham a seção opcional `coverage`, e um arquivo alterado que foi excluído por segurança ou não pôde ser analisado pelo parser, e código alterado que esteja ausente do índice por outro motivo, geram um aviso `coverage-gap` em vez de passar em silêncio. `scan` e `index` listam os caminhos excluídos por segurança. O schema v5 declara o novo campo opcional; atualize uma cópia fixada do schema se você valida relatórios de forma estrita.
- `conclave collect` não repassa mais o ambiente da CLI aos comandos do plano. Eles recebem uma lista mínima de variáveis, sem chave de provedor nem valor `CONCLAVE_*`; `--forward-env NOME` repassa mais uma variável pelo nome. Isso não é um sandbox. Um plano que dependia de uma variável herdada agora precisa de `--forward-env`.
- Segurança: o conteúdo do repositório enviado a um modelo agora passa por uma única fronteira. Os trechos de diff usados por `ask` e `investigate` eram enviados sem verificação, então uma credencial em uma linha adicionada ou removida podia chegar ao provedor; trechos de diff, excertos, a requisição montada, a entrada de embeddings remotos e os excertos do MCP agora são redigidos, conteúdo que não pode ser sanitizado é retido, e o resultado informa o que foi redigido (`contextProtection`). Baseado em padrões; veja docs/security.md para o que não é detectado.
- Novo `conclave audit [repositório]`: auditoria determinística do repositório inteiro como está no disco, com `--json`, `--no-write`, `--fail-on` e `--require-complete`, códigos de saída próprios e schema próprio (`schemas/audit-report.v1.schema.json`). Sem chamada de modelo, sem execução de código, sem rede. Seis regras, duas baseadas no grafo (`unresolved-import`, `import-cycle`). Relatórios e veredictos de review não mudam. Veja docs/repository-audit.md.
- As regras agora rodam em um único pipeline com escopo explícito (`change` ou `repository`). Biblioteca: novo `audit()`.
- Linhagem de achados: um fingerprint antigo é herdado por apenas um achado atual, então um defeito adicionado ao lado de outro existente é relatado como novo.
- Novos `conclave findings` e `conclave issues`: um fluxo local, revisado por pessoas, sobre os resultados da auditoria. `conclave audit` agora registra cada execução em um registro de achados (`.conclave/findings/ledger.json`) com os estados `new`, `persistent`, `resolved`, `reappeared` e `not-evaluated`; um achado cujo arquivo ou regra a auditoria não cobriu nunca é marcado como resolvido. `findings classify` registra a decisão de uma pessoa (confirmado, falso positivo, risco aceito, precisa de investigação) no log de feedback já existente. `issues propose` cria um rascunho de issue a partir de modelos fixos de texto; a aprovação é uma ação explícita separada, vinculada a uma revisão do texto, e uma edição, uma reclassificação ou uma mudança na evidência do código a anula. Nada é publicado e não existe `issues publish`. O servidor do cockpit ganha rotas locais equivalentes. Veja `docs/finding-workflow.md`.
- Gestão de ruído da auditoria: `conclave audit --update-baseline` grava `.conclave-baseline.json`, e os achados da baseline continuam visíveis sem reprovar `--fail-on` (`--no-baseline` a desconsidera). `.conclave-audit.json` declara caminhos específicos, como fixtures propositalmente inválidas, como inelegíveis para propostas de issue ou isentos do código de saída; arquivos de teste não são excluídos como categoria.
- Contagem de cobertura da auditoria: `coverage.excluded` contava um diretório ignorado como uma entrada, enquanto `filesDiscovered` contava arquivos, então seus valores não somavam os arquivos não analisados. O relatório ganha `coverage.accounting`, uma partição por arquivo com os diretórios ignorados contados à parte, e a saída no terminal informa os dois. Os relatórios de auditoria também ganham `repository.id`, `policy`, `summary.baselined`/`exempt`/`gated` e `evidenceDigest` por achado; texto de achado que cita o código tem formatos de credencial reconhecidos ocultados. `schemas/audit-report.v1.schema.json` declara as adições; atualize cópias fixadas.
- Novo `conclave audit --semantic` (desligado por padrão): um modelo configurado lê regiões limitadas do repositório e propõe defeitos comportamentais que nenhuma regra descreve, sem depender de uma correspondência de regra. As hipóteses precisam citar uma linha existente, são verificadas por um modelo independente (`--deep` usa os cinco papéis de raciocínio) e entram no registro de achados como `ai-hypothesis`: nunca contam para `--fail-on`, nunca são resolvidas pelo silêncio de um modelo, nunca são confirmadas ou publicadas sem uma pessoa. O relatório ganha `semantic` (provider, modelo, orçamento, uso, cobertura de IA, hipóteses descartadas); orçamentos por `--max-calls`, `--max-input-tokens`, `--max-output-tokens`, `--max-minutes`, `--max-regions`, `--investigate`, `--verifier-model`; custo apenas a partir de `--price-input`/`--price-output`. Uma auditoria limitada continua a partir de `.conclave/audits/semantic-cache.json`. Veja `docs/semantic-discovery.md`.
- Papéis de raciocínio: uma resposta de modelo que repete o formato de resposta como um `"type":"json_object"` solto no nível superior, ao lado de um resultado válido, agora é aceita em vez de derrubar o papel após uma chamada de reparo desperdiçada. Qualquer outro campo desconhecido continua rejeitado.
- A descoberta semântica mantém uma hipótese cujo gatilho exige entrada inválida e marca a sua alcançabilidade: `call-site-cited` quando ela cita um ponto de chamada existente, `unproven` quando não cita. A hipótese não provada é registrada com essa limitação e contada em `hypotheses.reachabilityUnproven`; ela não é descartada, porque chamadores fora do código mostrado ao modelo não estão excluídos. Uma hipótese cuja verificação falha é registrada como `inconclusive`.
- Cockpit: novas telas de repositório ao lado de Review, Ask e Investigate. **Overview** (cobertura das regras e cobertura da IA mostradas separadamente), **Repository audits** (Static, Smart e Deep, iniciadas como tarefa em segundo plano), **Findings inbox** (achados de regra e hipóteses da IA em uma tabela, com o que está e o que não está estabelecido em cada um), **Issue proposals** (editar, enviar, aprovar uma revisão exata, rejeitar, atualizar quando obsoleta) e **Architecture**. Um repositório aberto pelo caminho agora cai em Overview. Veja o [guia do cockpit](docs/guides/cockpit.pt-BR.md).
- Auditorias no cockpit: uma auditoria Smart ou Deep mostra o host do provider, os modelos, o orçamento e que a sanitização é baseada em padrões antes de qualquer envio, e só inicia após uma confirmação explícita; o servidor recusa a requisição sem ela (`acknowledgement_required`). Novas rotas de loopback `/api/audit/preflight`, `/api/audit/start`, `/api/audit/status`, `/api/audit/latest` e `/api/architecture`, sob as mesmas verificações de host, origem e tipo de conteúdo das demais rotas. Nada é publicado e nenhuma rota aprova sem a revisão lida.
- Correções no cockpit: a tela escolhida enquanto o repositório ainda abre não é mais trocada por Overview ao terminar; em janelas estreitas a navegação quebra em linhas sob seus grupos em vez de cortar, e o painel de detalhe abre em largura total abaixo da tabela; os painéis de detalhe ganham **Close**; um repositório que falha ao abrir agora mostra o motivo com **Try again** em vez de ficar em "Opening repository…"; o modo de auditoria responde às setas do teclado; campos de texto, seletores e áreas de texto em todo o cockpit ganham um contorno com contraste de pelo menos 3:1 contra o fundo nos dois temas (novo token `--border-control`).

## [0.19.0] — 2026-10-06

- Superfície mais limpa: o help principal lista nove comandos do dia a dia e agrupa o resto em `conclave tools` (nomes antigos continuam); `check` pergunta o que a mudança deve entregar no terminal (pré-preenchido pelo último commit) e lê `CONCLAVE_OBJECTIVE`; o skill de agente passa o prompt do próprio usuário como objetivo; nova API de biblioteca `check`, `ask`, `handoff` como entrada do pacote.

## [0.18.0] — 2026-10-05

- O cockpit identifica avaliações do modelo e mostra, por afirmação, as buscas no código e os julgamentos semânticos, com orientação para os recibos de execução comportamental.
- O teste de instalação global no Windows informa a versão do pacote simulado, mantendo a validação independente da disponibilidade da nova versão no npm.

## [0.17.0] — 2026-10-05

- Separa observações de busca das decisões semânticas; checks de texto e grafo inconclusivos passam por verificação de modelo. Inclui testes de regressão e avaliação documentada de 60 reviews reais, com limitações e custo de latência.

## [0.16.5] — 2026-09-26

- Revisão 7: a skill de agente ignora um Conclave instalado mais antigo que a versão para a qual foi feita (uma instalação global antiga podia responder sem o comando `check`) e usa o pacote npx fixado; o comando avulso do README usa `conclave-ai@latest` pelo mesmo motivo; Ctrl+C durante uma comparação de branches remove o snapshot temporário; gravações do histórico de reviews são serializadas entre processos; a dica da navegação Settings atinge o contraste WCAG AA.

## [0.16.4] — 2026-09-26

- Correções de Windows e CI: o runner da skill de agente e o `conclave update` não falham mais no Windows, onde npm, npx e um `conclave` global são shims `.cmd` (agora rodam pelos entry points JavaScript); `conclave config edit` abre editores `.cmd`; o cockpit abre Options sozinho quando há critérios salvos; um publish de tag que falhou pode ser repetido com `npm run release:tag`.

## [0.16.3] — 2026-09-26

- Quarta conferência: o servidor local do cockpit agora recusa requisições cujo Host não seja loopback, fechando a leitura de histórico, grafo e runtime por DNS rebinding; `graph`, `path`, `symbol`, `search` e `text` explicam resultados vazios ou ambíguos em vez de imprimir objetos crus ou nada; `criteria` valida o tipo de evidência, usa menus, não salva quando nada mudou e se explica sem terminal; menos falsos positivos para comentários `conclave-ignored`, Scanner sobre System.in e Popen com wait.

## [0.16.2] — 2026-09-26

- Revisão de robustez em todas as superfícies: `compare` funciona em scripts e CI com objetivo inferido; prompts nunca escolhem uma opção sozinhos sem terminal e perguntam de novo após um erro de digitação; trocar de provider com `conclave config set provider` também troca o mode e limpa endpoint e modelos por papel antigos; `config unset` não diz mais que removeu chaves inexistentes; `conclave open` usa a próxima porta livre; `update --check` mostra a versão instalada; o cockpit começa com o mesmo objetivo inferido da CLI; a skill de agente e o GitHub Action não exigem mais objetivo; o MCP informa a versão real; linha de comparação traduzida.

## [0.16.1] — 2026-09-26

- Primeira execução mais amigável: bases relativas como `--base HEAD~3` funcionam; repositório sem commits, base inexistente, comando desconhecido (com sugestão "você quis dizer") e Ask sem provider explicam o próximo passo; "Nothing to review" sugere o que tentar; e `.conclave/` se ignora sozinho, então nunca aparece como arquivo não rastreado.

## [0.16.0] — 2026-09-26

- Menos ruído, mais linguagens: `conclave check` agora mostra um resumo curto (veredito, até três riscos com arquivo e linha, próxima ação) e `--verbose` mantém o relatório completo; comentários `conclave-ignore` transformam um aviso intencional numa nota auditável; "exported behavior changed without a test change" vira nota em repositórios sem testes; Python e Java ganham as regras de handler vazio e recurso sem liberação.

## [0.15.4] — 2026-09-26

- Documentação completa: README com índice, saída real de exemplo, receitas, tabela de privacidade, comparação, perguntas frequentes e solução de problemas; o guia da CLI agora traz todas as opções do check, modelos locais, modelos por papel, todas as variáveis de ambiente e os arquivos que o Conclave grava. `conclave <comando> --help` agora mostra a ajuda do comando.

## [0.15.3] — 2026-09-26

- Documentação reorganizada por produto: README curto com início em 30 segundos e guias separados de CLI, cockpit, skill de agente, GitHub Actions e funcionamento, em inglês e português.

## [0.15.2] — 2026-09-26

- Skill de agente mais segura: o runner só executa um dist/cli.js que pertence ao conclave-ai, usa um conclave global no PATH antes do npx, permite 300 s por padrão (CONCLAVE_TIMEOUT_MS) e a skill começa por veredito, achado principal, próxima ação e limites. A referência de schema agora cobre v2 a v5.

## [0.15.1] — 2026-09-26

- Ações do cockpit em até três cliques: trocar de Conclave aplica na hora quando a chave salva é do mesmo provider, as opções de review ficam num único painel Opções com resumo ao vivo, o handoff do agente é copiado direto do resumo, itens do histórico continuam uma série de review, erros de provider levam a Configurações e ⌘/Ctrl+Enter executa.

## [0.15.0] — 2026-09-26

- Configurações editáveis para instalação global: `conclave config set|get|unset|edit|path` com segredos mascarados, configurações por usuário em ~/.config/conclave/credentials.env, `conclave init` em três passos que mantém a chave salva, OpenCode Go no wizard e um menu guiado mais curto com submenus Mais e Configurações.

## [0.14.1] — 2026-09-26

- Mix de modelos por papel com modelo de fallback, provider judge SystemOne opcional, OpenCode Go como padrão recomendado de baixo custo e um product lab reproduzível para medir custo e qualidade das reviews.

## [0.14.0] — 2026-09-21

- Cockpit mais calmo para escolher configurações de review salvas: presets objetivos, favoritos, padrão e troca rápida. A pessoa pode salvar uma cópia local da configuração sem expor ou reter credenciais do provedor no preset.

## [0.13.0] — 2026-09-10

- Validação do pacote instalado com execução real, rechecagem de critério e rejeição de evidência desatualizada, em matriz de seis combinações de sistema/runtime. Avaliação versionada mantém falhas e ruído conhecidos. Roteiro de piloto registra limites medidos e o requisito externo da 0.14; nenhum uso real de piloto é declarado.

## [0.12.0] — 2026-09-09

- Cenários explícitos no navegador para apps locais: preencher, clicar, recarregar e conferir persistência. Contextos novos, rede restrita à origem e execução limitada. Feedback local vinculado ao relatório e achado, sem alterar verdicts. Fixtures no Chromium cobrem persistência correta, perdida e falha; fluxo real do cockpit validado no celular.

## [0.11.0] — 2026-09-09

- Action reutilizável com resumo de decisão, comparação e comentário opcional. Coleta explícita com limites e verificação de assinatura do GitHub vinculada a repositório, workflow e commit. Schema v5 distingue recibos relatados de procedência verificada.

## [0.10.0] — 2026-09-08

- Editor de critérios e CLI guiada, contratos persistidos com detecção de conflito, vínculo explícito das evidências, comparação por critério e schema v4. Decisão humana permanece separada; suporte relatado não comprova procedência.

## [0.9.0] — 2026-09-08

### Adicionado

- Cockpit com próxima ação, achados que exigem atenção, verificação pendente, progresso das correções e acesso ao diff e handoff.
- Schema v3 com escopo, aplicabilidade, arquivos e perguntas abertas por regra. CLI e handoff preservam as mesmas lacunas de evidência.
- Plano incremental da 0.9 e suíte reproduzível `eval:precision`.

### Alterado

- O contador inclui verificações sem achados; o cabeçalho adapta caminhos longos à tela pequena.

- Checks de código usam a árvore sintática, ignoram comentários e strings e reconhecem chamadas multilinha. Candidatos de limpeza precisam corresponder ao listener, intervalo ou assinatura no mesmo arquivo; isso não prova execução do teardown.
- Observações de chaves distinguem os armazenamentos. Catch vazio considera mudanças em seu corpo.
- PASS e claims estruturais deixam de sugerir entrega comportamental comprovada na interface.
- Relatórios novos usam schema v3 com cobertura parcial/não examinada. Schema v2, histórico e rechecagem por digest continuam aceitos, com limitações explícitas. Consumidores restritos a v2 precisam aceitar v3.

### Escopo

- Editor de critérios, attestations verificadas do CI, coleta de runtime e colaboração hospedada continuam planejados para minors posteriores. O motor de review não chama modelos nem executa scripts do repositório.

## [0.8.0] — 2026-08-18

A primeira versão da linha de companion de PR a chegar ao npm. A versão publicada anteriormente é a `0.2.8`.

### Adicionado

- Checagens determinísticas de defeito que não custam nenhuma chamada de modelo: recurso que o projeto nunca libera (listener, intervalo, inscrição), erro descartado por um `catch` vazio e armazenamento endereçado por literal onde o mesmo arquivo usa uma constante nomeada. Cada uma aponta a linha alterada exata.
- `escalation` no relatório: quais dimensões de risco a camada determinística conseguiu evidenciar, quais checou e liberou, e quais não tem checagem alguma. A decisão de gastar uma chamada de modelo passa a ser ela mesma determinística.
- Setup guiado para `opencode-go`, com perfis de modelo escolhidos por custo e confiabilidade medidos, não por ordem de fornecedor.
- Os agentes de raciocínio recebem as próprias linhas alteradas, então a revisão enxerga o que a mudança faz e não apenas onde ela caiu.

- Linhagem de review no schema v2 com digests de objetivo, contrato, diff, artefato, relatório anterior e relatório atual.
- Gates contra mudança silenciosa do contrato, séries explícitas de rebaseline, fingerprints estáveis e acompanhamento de progresso/estagnação no ciclo de correção.
- Recibos de evidência externa vinculados ao artefato revisado e planos determinísticos de desafios selecionados pelo risco.
- Suporte a `--previous-report`, `--receipt` repetível, `--series` e `--new-series` na CLI e na skill portável.
- `conclave check`, a passagem recomendada para PRs. Detecta a provável base e inclui commits da branch, arquivos staged, unstaged e untracked.
- `conclave compare`, com seletor interativo de branches locais e remotas sem trocar o checkout.
- Catálogo completo em `conclave help`, organizado por objetivo, além de guias como `conclave help check` e `conclave help symbol`.
- Preferência global de idioma da CLI com inglês como padrão, português do Brasil (`pt-BR`) e espanhol europeu (`es-ES`).
- `conclave config --language <idioma>` e seletor de idioma no menu guiado.
- Cockpit local de review com resumo, achados, código alterado, diff exato, histórico e handoff copiável para o coding agent.
- Histórico local de reviews e `conclave handoff` para o ciclo corrigir e conferir novamente.
- `conclave setup` guiado e skills portáveis para Codex, Claude Code, GitHub Actions e outros agents.
- Workflow de pull request no GitHub Actions com resumo do job, annotations, um comentário atualizado no PR e artefato JSON.
- Parsing estrutural e evidências de grafo para Python e Java, além de TypeScript e JavaScript.
- `conclave doctor` para diagnosticar a integração do repositório.

### Alterado

- Os planos de desafio orçam sondas de defeito e sinais de processo em faixas separadas. Um achado de falta de teste não expulsa mais uma sonda de ciclo de vida do plano.
- O schema v2 do relatório declara `escalation` e permite até seis desafios.

- Conclave foi reposicionado como companheiro de PR read-only: fornece contexto, evidências e próximos passos, enquanto a autoridade do merge continua humana.
- Task Mode autônomo e toda mutação pública do repositório foram removidos. Conclave aponta o problema; o desenvolvedor ou seu coding agent realiza a correção.
- O review agora cria um snapshot novo e não depende de `.conclave/code-index-v2.json`; o índice persistente é apenas um cache opcional para search, graph, Ask e Investigate.
- Comparações sem mudança retornam “Nothing to review” informativo em vez de um blocker falso.
- O README ficou mais curto, bilíngue, orientado a tarefas e explícito sobre review determinístico versus reasoning opcional por provider.
- As chaves do JSON continuam estáveis em inglês independentemente do idioma da interface humana.

### Corrigido

- O Conclave não revisa mais o próprio diretório `.conclave/` como parte de uma mudança. O relatório guardado por uma execução entrava no conjunto de mudanças da execução seguinte e contaminava seus sinais de risco.
- Os cabeçalhos de diff do próprio Git deixaram de contar como sinal de risco. A palavra `index` dentro de `index <hash>..<hash> <modo>` fazia a dimensão de performance disparar em quase todo arquivo modificado.
- Um índice em cache que descreve outro caminho de repositório é reconstruído em vez de derrubar todos os comandos, que é o que acontece depois de mover ou renomear o repositório.
- O Modo Local recusa um papel de raciocínio hospedado no momento da configuração e nomeia as variáveis a mudar, em vez de falhar no meio do pipeline com um erro de provider não registrado.
- O `conclave config` avisa quando o arquivo de ambiente define a mesma chave mais de uma vez, caso em que a última definição vence silenciosamente.
- A repetição de requisição ao provider classifica a falha de transporte pela causa, não pelo texto de erro do runtime, que muda entre versões do Node.

### Segurança

- Toda rota local que altera estado verifica a origem da requisição e o tipo de conteúdo JSON, não apenas as rotas de configuração de runtime. Um post cross-site conseguia antes alcançar as rotas de projeto, revisão e raciocínio.

- Claims de confiança dos recibos são tratados conservadoramente como autorrelatados; o Conclave nunca diz que executou um comando reportado externamente.
- Recibos de worktree mutável precisam do digest do artefato ou do diff e não podem depender apenas do `HEAD`.
- A preferência de idioma fica fora do repositório e usa permissão de arquivo somente para o dono.
- O `.env` do repositório não pode redirecionar nem substituir silenciosamente as preferências globais da CLI.
- O review de PR continua local e determinístico: não usa chave de API, não chama modelo e não executa scripts do repositório.

## [0.2.8] — 2026-08-12

### Adicionado

- Resumos legíveis de PR com comparação, riscos, arquivos alterados, veredito e próximos passos.
- Fluxo guiado de PR baseado em comparações Git explícitas.
- Navegação guiada na CLI para o fluxo principal de PR.

### Corrigido

- Documentação e comportamento de comparação de branches foram esclarecidos para evitar o review do diff errado.

## [0.2.6] — 2026-08-12

### Adicionado

- `conclave update --check`, `--local` e `--global`.

### Corrigido

- Uma instalação já atualizada agora recebe uma explicação clara em vez de erro `ENOENT`.

## [0.2.5] — 2026-08-12

### Adicionado

- Navegação guiada na CLI para os fluxos comuns do Conclave.
- Suporte estrutural e documentação de review para Python e Java.

### Alterado

- Validação determinística passou a ser apresentada como uma etapa de evidências no fluxo do PR, não como julgamento automático do código.

## [0.2.4] — 2026-08-12

### Adicionado

- READMEs separados em inglês e português do Brasil.
- Diagramas hospedados no repositório para o fluxo do PR e pipeline determinístico.

### Alterado

- A explicação do produto foi simplificada em torno do caminho entre a mudança de código e o merge aprovado por uma pessoa.

## [0.2.3] — 2026-08-12

### Alterado

- Foram esclarecidos o fluxo de review entre branches, os limites determinísticos e o significado das unidades de código antes chamadas de símbolos.

## [0.2.2] — 2026-08-11

### Adicionado

- Setup guiado e moderno de providers para Ask e Investigate opcionais.
- Gates de validação da skill portável e do fluxo web.

### Corrigido

- A autovalidação do CI passou a comparar com a base do evento em vez de bloquear em um diff vazio.
- Os nomes do pacote e do repositório foram alinhados em `conclave-ai`.

## [0.2.1] — 2026-08-11

### Alterado

- Melhorias no onboarding de provider e nos metadados iniciais do pacote npm.

## [0.2.0] — 2026-08-11

### Adicionado

- Primeira versão pública no npm como `conclave-ai`.
- Contratos de validação determinística, coleta de mudanças, análise estrutural de impacto e vereditos com evidências.
- Configuração opcional de API e uma skill de validação portável.

[Não publicado]: https://github.com/carvalhobfr/conclave-ai/compare/b6c5418...HEAD
[0.2.8]: https://www.npmjs.com/package/conclave-ai/v/0.2.8
[0.2.6]: https://www.npmjs.com/package/conclave-ai/v/0.2.6
[0.2.5]: https://www.npmjs.com/package/conclave-ai/v/0.2.5
[0.2.4]: https://www.npmjs.com/package/conclave-ai/v/0.2.4
[0.2.3]: https://www.npmjs.com/package/conclave-ai/v/0.2.3
[0.2.2]: https://www.npmjs.com/package/conclave-ai/v/0.2.2
[0.2.1]: https://www.npmjs.com/package/conclave-ai/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/conclave-ai/v/0.2.0
