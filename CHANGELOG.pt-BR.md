# Changelog

Todas as mudanças relevantes do Conclave são documentadas aqui. O projeto segue [Versionamento Semântico](https://semver.org/lang/pt-BR/) e a estrutura do [Keep a Changelog](https://keepachangelog.com/pt-BR/).

[English](CHANGELOG.md) · [Português (Brasil)](CHANGELOG.pt-BR.md)

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
