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
| Revisar a mudança atual | **Review change** (1) |
| Copiar o prompt de correção para o agente | **Review change** → **Copy handoff prompt** (2) |
| Ver achados, diff ou relatório bruto | **Review change** → aba (2) |
| Perguntar algo sobre o código | **Ask** → digitar → **Run ask** (2), ou ⌘/Ctrl + Enter |
| Trocar para outro Conclave salvo | Seletor da barra superior (1) |
| Continuar uma série de review anterior | **History** → **Continue this review** (2) |
| Adicionar ou trocar a chave de API | **Settings** → colar chave → **Save and test** (2) |

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
