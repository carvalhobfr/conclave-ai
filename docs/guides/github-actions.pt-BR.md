# Conclave no GitHub Actions

[English](github-actions.md) · [Português (Brasil)](github-actions.pt-BR.md) · [← README](../../README.pt-BR.md)

Revise cada pull request automaticamente com o mesmo motor da [CLI](cli.pt-BR.md).

## Adicionar o workflow

```bash
conclave setup . --agents none --github-actions
```

Isso cria `.github/workflows/conclave-review.yml`. Faça commit e abra um pull request.

## O que cada execução faz

- faz checkout do pull request e compara as refs reais de base e head;
- roda uma versão fixada do Conclave, sem `npm ci` nem build do projeto, então funciona em qualquer linguagem;
- escreve o resumo do job e annotations nos arquivos;
- mantém um único comentário atualizado no pull request;
- envia o relatório JSON como artefato; e
- falha só em `BLOCK` ou `INCONCLUSIVE`.

Pull requests de fork ainda recebem resumo e artefato quando o GitHub remove a permissão de comentário.

## Indo além

- [Evidências de CI](../ci-evidence.md): anexe resultados de teste e build como recibos verificados.
- [Aceite](../acceptance.md): confira cada execução contra critérios salvos.
- Action composta: [`action.yml`](../../action.yml).
