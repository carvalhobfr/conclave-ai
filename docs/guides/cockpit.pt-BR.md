# Cockpit do Conclave

[English](cockpit.md) · [Português (Brasil)](cockpit.pt-BR.md) · [← README](../../README.pt-BR.md)

O cockpit é uma visão local no navegador do mesmo motor da [CLI](cli.pt-BR.md). Use quando preferir ler um review a rolar o terminal.

## Abrir

```bash
conclave open .
```

O Conclave inicia um servidor em `127.0.0.1:4317`, abre o navegador e carrega o repositório. Opções: `--port <n>` e `--no-browser`. Encerre com `Ctrl+C`.

O servidor só escuta em loopback e só abre repositórios dentro da pasta onde foi iniciado. Ele não altera o seu código nem aplica correções.

## Tudo em até três cliques

| Quero… | Cliques |
| --- | --- |
| Ver o que se sabe do repositório | Abre em **Overview** (0) |
| Auditar o repositório inteiro só com regras | **Repository audits** → **Start Static audit** (2) |
| Triar um achado | **Findings inbox** → linha → classificação (3) |
| Revisar a mudança atual | **Review** → **Review change** (2) |
| Copiar o prompt de correção para o agente | **Review** → **Review change** → **Copy handoff prompt** (3) |
| Ver achados, diff ou relatório bruto | **Review** → **Review change** → aba (3) |
| Perguntar algo sobre o código | **Ask** → digitar → **Run ask** (2), ou ⌘/Ctrl + Enter |
| Trocar para outro Conclave salvo | Seletor da barra superior (1) |
| Continuar uma série de review anterior | **History** → **Continue this review** (2) |
| Adicionar ou trocar a chave de API | **Settings** → colar chave → **Save and test** (2) |

## Onde abre

Um repositório aberto pelo caminho (`conclave open .`, ou **Open** na barra lateral) cai em **Overview**. O demo determinístico cai em **Review**. Se você escolher uma tela enquanto o repositório ainda está abrindo, continua nela. Se o repositório não puder ser aberto, a página diz o motivo e oferece **Try again**.

A barra lateral tem três grupos:

| Grupo | Telas |
| --- | --- |
| Repository | **Overview**, **Repository audits**, **Findings inbox**, **Issue proposals**, **Architecture** |
| Changes | **Review**, **Ask**, **Investigate**, **History** |
| Configuration | **Settings** |

As telas de Repository precisam de um repositório local; o demo não tem estado de auditoria. Elas leem e gravam os mesmos arquivos em `.conclave` que `conclave audit`, `conclave findings` e `conclave issues`.

## Overview

O que se sabe do repositório na última auditoria: cobertura das regras e cobertura da IA em cards separados, achados por ciclo de vida, achados estáticos por severidade, hipóteses da IA por resultado da verificação e propostas de issue aguardando uma pessoa. A tela nunca chama o repositório de verificado: um arquivo sem achado não foi mostrado como correto.

## Repository audits: Static, Smart e Deep

| Modo | O que roda | Provider | Sai da máquina |
| --- | --- | --- | --- |
| **Static** | As regras determinísticas | Nenhum | Nada. Sem chamada de modelo, sem requisição de rede |
| **Smart** | Regras, depois um modelo lê regiões limitadas e um verificador checa cada hipótese | O configurado | Código sanitizado das regiões lidas, quando o provider é remoto |
| **Deep** | Regras, depois descoberta e os cinco papéis de raciocínio em cada hipótese | O configurado | O mesmo que Smart, com várias vezes mais chamadas |

**Static.** Escolha **Static** → **Start Static audit**. Não há etapa de consentimento porque nada é chamado.

**Smart e Deep.**

1. Escolha o modo. Aparecem os campos de orçamento: **Max model calls** (padrão 40), **Max regions read** (30), **Hypotheses verified** (10), **Max minutes** (15) e os nomes opcionais **Discovery model** e **Verifier model** (o campo do verificador vale para Smart). Campos vazios usam os padrões. Os limites de tokens são os padrões da CLI (200.000 de entrada, 40.000 de saída).
2. Leia o aviso. Ele informa o host do provider quando o código sai da máquina, os modelos de descoberta e de verificação (e avisa quando o verificador é o mesmo modelo, o que torna a verificação uma segunda leitura e não uma checagem independente), o orçamento, que a remoção de credenciais é baseada em padrões, que o provider pode cobrar e o Conclave não sabe dizer o custo, e quantos resultados de região estão em cache.
3. Marque **I understand that this audit calls a model…**. O botão de início fica desabilitado até isso. Mudar o modo, um campo de orçamento ou um nome de modelo desmarca a caixa, e iniciar uma auditoria também.
4. **Start Smart audit** / **Start Deep audit**. As linhas de progresso aparecem durante a execução. Roda uma auditoria por repositório de cada vez.

Sem provider configurado, a página avisa e o modo não inicia; o provider é adicionado em **Settings**. Uma auditoria interrompida por um limite informa cobertura incompleta e qual limite a encerrou; rodar a mesma auditoria de novo continua pelas regiões não alcançadas, e regiões sem mudança não custam chamada.

Abaixo dos controles: cobertura das regras, cobertura da IA, uso de modelo frente ao orçamento, o que a última auditoria não estabelece e o histórico de auditorias.

## Findings inbox

Uma tabela para achados de regra e hipóteses de modelo, diferenciados por um selo com texto (**Static finding**, sólido; **AI hypothesis**, tracejado). Filtre por texto, origem, resultado da verificação, ciclo de vida, classificação e severidade; ordene por atenção, severidade, localização ou última observação.

Selecionar uma linha abre o detalhe:

- **What is established** lista sete fatos separados: correspondência de regra estática, hipótese da IA, apoio de modelo, contradição de modelo, defeito reproduzido, confirmação humana e aprovação humana de issue. A concordância de um modelo aparece como apoio de modelo, nunca como confirmação, e "reproduzido" é sempre não, porque nada é executado.
- Para uma hipótese: gatilho, consequência, sugestão e confiança declarada do modelo, modelos de descoberta e de verificação, o raciocínio do verificador, evidência a favor e contrária, suposições não verificadas e quais linhas o modelo de fato leu.
- Uma hipótese cujo gatilho exige entrada inválida é **mantida** quando nenhum ponto de chamada que a passe foi encontrado. O detalhe diz que a alcançabilidade não foi provada e que ela não foi mostrada como inalcançável. Hipóteses contestadas ou inconclusivas também são mantidas, com prioridade menor.
- **Source references** mostra as linhas do disco. Um caminho fora do repositório, um arquivo de credenciais ou um arquivo que bate com um detector de segredos é retido, com o motivo.
- **Your classification**: **Confirm**, **Mark false positive**, **Accept risk** (estes dois exigem uma nota), **Needs investigation**, **Clear classification**. A classificação é sua e fica registrada localmente; ela não aprova nada.
- **Create issue proposal** cria uma proposta local a partir do achado.

**Close** volta para a tabela completa.

## Issue proposals

Uma proposta é um rascunho local. Nada aqui publica no GitHub, e não existe rota que faça isso.

1. Edite **Title**, **Body** e **Labels** e depois **Save edits**. O corpo é o fonte Markdown mostrado como texto puro; nunca é renderizado. Salvar muda a revisão.
2. **Submit for review**.
3. Marque **I read the title, body and labels above at revision … and approve exactly that text** e depois **Approve this revision**. A aprovação vale só para aquela revisão.
4. Ou informe um motivo e use **Reject proposal**.

A aprovação perde a validade assim que o texto é editado, o achado é reclassificado ou o código por trás dele muda. A proposta passa a mostrar **Stale** com o motivo; **Refresh from the current finding** gera o texto de novo e a devolve a rascunho para uma nova revisão. **Publication** lista o que um futuro publicador ainda exigiria.

## Architecture

Arquivos, símbolos, módulos, dependências entre módulos e os arquivos mais conectados, lidos do índice construído quando o repositório foi aberto, além do que não está no índice e por quê. Nenhum modelo participa, e uma relação que o parser não resolveu fica ausente. **Symbol explorer** consulta um símbolo no grafo.

## Teclado e telas pequenas

- Todo controle é alcançável com Tab e mostra contorno de foco. O título de uma linha é o botão que a abre; **Close** devolve o foco a essa linha.
- O modo de auditoria é uma única parada de Tab; as setas alternam entre Static, Smart e Deep. Ir para Smart ou Deep continua exigindo a caixa marcada.
- O estado sempre vem escrito (**Model-supported**, **Stale**, **Persistent**); cor e formato do selo apenas repetem.
- Em janela estreita, a barra lateral vai para cima da página com os grupos quebrados em linhas, os filtros ficam em duas colunas, e o detalhe abre abaixo da tabela e rola até ficar visível. Tabelas largas rolam para o lado dentro da própria moldura.
- Claro e escuro seguem a configuração do sistema.

## Review

A tela de review abre com o objetivo e o botão **Review change**. O resto fica em **Options**, cujo resumo mostra o que será comparado:

- **Compare**: workspace atual, branch commitada, working tree, mudanças preparadas ou um commit;
- **Critérios de aceite**: objetivo e critérios salvos deste repositório;
- **Compare with saved review**: continua uma série, e o resultado mostra o progresso desde então;
- **Attach execution receipts**: um arquivo JSON com resultados de teste ou build;
- **Optional contract**: escopo e claims de conclusão no mesmo JSON aceito pela CLI.

O resultado começa por um resumo de decisão: veredito, próxima ação, o que precisa de atenção e o que ainda falta verificar. As abas mostram **Findings**, **Claims**, **Impact**, **Diff**, **Agent handoff** e **Raw report**.

## Ask e Investigate

Esses modos opcionais usam o seu provider configurado. **Ask** dá uma resposta com evidências; **Investigate** questiona hipóteses sobre um comportamento. Os resultados mostram claims verificados, a evidência de cada um, o grafo de código e por que cada contexto foi recuperado. Sem provider, a página mostra o botão **Set up a provider first**.

## Configurações e Conclaves

Um **Conclave** é uma configuração de review salva: provider, modelo e profundidade de raciocínio. Presets incluídos:

| Conclave | Custo | Uso |
| --- | --- | --- |
| Essential | Baixo (≈ US$ 0,0015 por review) | Padrão recomendado |
| Free trial | Grátis enquanto for oferecido | Experimentar o Conclave; o modelo pode ser retirado |

- Clique num card ou escolha na barra superior para trocar. Se a chave salva já é daquele provider, a troca vale na hora. Senão, abre Settings com o formulário preenchido e só falta a chave.
- ☆ marca favorito; **Make default** escolhe o que carrega primeiro; **Create your own** salva a configuração atual com um nome.
- Abaixo dos cards dá para definir provider, modelo (**Load available models** lista o que a sua chave pode usar), endpoint, profundidade de raciocínio e chave de API. **Save and test** salva e envia uma pequena requisição de teste.

A chave vai pela conexão loopback para o mesmo arquivo de configurações que a CLI usa (`conclave config` mostra). O navegador só recebe uma dica mascarada, como `op••••9x7z`.

## Histórico

Todo review feito no cockpit ou com `conclave check` aparece aqui, do mais novo ao mais antigo, e fica só na sua máquina. **Continue this review** inicia o próximo review na mesma série.
