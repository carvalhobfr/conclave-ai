import type { InterfaceLanguage } from "../config/user-preferences.js";

type LocalizedText = Readonly<Record<InterfaceLanguage, string>>;
type CommandGroup = "workflow" | "intelligence" | "setup" | "advanced";

interface CommandHelp {
  readonly id: string;
  readonly usage: string;
  readonly group: CommandGroup;
  readonly description: LocalizedText;
  readonly details: LocalizedText;
  readonly examples: readonly string[];
}

function localized(en: string, ptBR: string, esES: string): LocalizedText {
  return { en, "pt-BR": ptBR, "es-ES": esES };
}

const GROUPS: Readonly<Record<CommandGroup, LocalizedText>> = {
  workflow: localized("PR workflow", "Fluxo de PR", "Flujo de PR"),
  intelligence: localized("Code intelligence", "Inteligência de código", "Inteligencia de código"),
  setup: localized("Setup and integrations", "Configuração e integrações", "Configuración e integraciones"),
  advanced: localized("Automation and advanced tools", "Automação e ferramentas avançadas", "Automatización y herramientas avanzadas"),
};

const COMMANDS: readonly CommandHelp[] = [
  { id: "criteria", usage: "conclave criteria [path] [--json]", group: "workflow", description: localized("Edit saved acceptance criteria.", "Edita critérios de aceitação.", "Edita criterios de aceptación."), details: localized("Confirm expected results and verification plans.", "Confirme resultados e planos de verificação.", "Confirma resultados y planes de verificación."), examples: ["conclave criteria ."] },
  { id: "collect", usage: "conclave collect REPOSITORY REPORT.json PLAN.json OUTPUT.json", group: "advanced", description: localized("Execute an explicit bounded command plan.", "Executa um plano explícito de comandos.", "Ejecuta un plan explícito de comandos."), details: localized("Opt-in execution; review never runs this automatically.", "Execução explícita; review não inicia esse comando.", "Ejecución explícita; review nunca inicia este comando."), examples: [] },
  { id: "smoke", usage: "conclave smoke REPOSITORY REPORT.json PLAN.json OUTPUT.json", group: "advanced", description: localized("Exercise a declared local browser scenario.", "Testa um cenário declarado no navegador local.", "Prueba un escenario declarado en el navegador local."), details: localized("Requires optional Playwright and Chromium.", "Requer Playwright e Chromium opcionais.", "Requiere Playwright y Chromium opcionales."), examples: [] },

  {
    id: "check",
    usage: "conclave check [path] [--base <ref>] [--objective <goal>] [--previous-report <file>] [--receipt <file>] [--json]",
    group: "workflow",
    description: localized("Review the current branch and all local changes in one pass.", "Revisa a branch atual e todas as mudanças locais em uma passagem.", "Revisa la rama actual y todos los cambios locales en una pasada."),
    details: localized("Recommended day-to-day command. It detects the repository, comparison base, committed branch changes, staged, unstaged, and untracked files.", "Comando recomendado no dia a dia. Detecta o repositório, a base de comparação, commits da branch e arquivos staged, unstaged e untracked.", "Comando recomendado para el día a día. Detecta el repositorio, la base de comparación, los commits de la rama y los archivos staged, unstaged y untracked."),
    examples: ["conclave check .", "conclave check . --base origin/main --objective \"Protect the login flow\""],
  },
  {
    id: "compare",
    usage: "conclave compare [path] [--base <ref> --head <ref>] [--objective <goal>]",
    group: "workflow",
    description: localized("Choose or provide two Git refs and run a readable PR comparison.", "Escolhe ou recebe duas refs Git e executa uma comparação de PR legível.", "Elige o recibe dos refs de Git y ejecuta una comparación de PR legible."),
    details: localized("In an interactive terminal, branches are shown as a selectable list. The command never changes your checkout.", "Em um terminal interativo, as branches aparecem em uma lista selecionável. O comando nunca troca seu checkout.", "En un terminal interactivo, las ramas aparecen en una lista seleccionable. El comando nunca cambia tu checkout."),
    examples: ["conclave compare .", "conclave compare . --base origin/main --head feature/auth"],
  },
  {
    id: "pr",
    usage: "conclave pr <path> --objective <goal> [change source] [--json]",
    group: "workflow",
    description: localized("Create the human-readable PR summary and save it to local history.", "Cria o resumo legível do PR e salva no histórico local.", "Crea el resumen legible del PR y lo guarda en el historial local."),
    details: localized("Use it when you want an explicit branch, commit, staged, or working-tree source. It includes risks, affected code, next steps, and an agent handoff.", "Use quando quiser informar explicitamente uma branch, commit, staged ou working tree. Inclui riscos, código afetado, próximos passos e handoff para o agente.", "Úsalo cuando quieras indicar explícitamente una rama, commit, staged o working tree. Incluye riesgos, código afectado, siguientes pasos y handoff para el agente."),
    examples: ["conclave pr . --base origin/main --head HEAD --objective \"Add checkout retries\""],
  },
  {
    id: "review",
    usage: "conclave review <path> --objective <goal> [change source] [--contract <file>] [--previous-report <file>] [--receipt <file>] [--series <id>|--new-series] [--json]",
    group: "workflow",
    description: localized("Produce the low-level deterministic evidence report for scripts and CI.", "Produz o relatório determinístico de evidências para scripts e CI.", "Genera el informe determinista de evidencias para scripts y CI."),
    details: localized("This is the evidence engine behind the PR summary. It tracks contract and finding lineage across explicit previous reports, imports artifact-bound receipts without running their commands, and never calls an LLM. `validate` is an explicit alias.", "Este é o motor de evidências por trás do resumo de PR. Acompanha contrato e findings por relatórios anteriores explícitos, importa receipts ligados ao artefato sem executar seus comandos e nunca chama LLM. `validate` é um alias explícito.", "Este es el motor de evidencias tras el resumen de PR. Sigue el contrato y los hallazgos mediante informes anteriores explícitos, importa recibos ligados al artefacto sin ejecutar sus comandos y nunca llama a un LLM. `validate` es un alias explícito."),
    examples: ["conclave review . --working --objective \"Keep session restore compatible\" --json"],
  },
  {
    id: "validate",
    usage: "conclave validate <path> --objective <goal> [change source] [--json]",
    group: "workflow",
    description: localized("Explicit alias for `review`.", "Alias explícito de `review`.", "Alias explícito de `review`."),
    details: localized("Kept for validation-oriented agents and automation. Its behavior and output are the same as `review`.", "Mantido para agents e automações orientados a validação. O comportamento e a saída são os mesmos de `review`.", "Se mantiene para agentes y automatizaciones orientados a validación. Su comportamiento y salida son iguales a `review`."),
    examples: ["conclave validate . --commit HEAD --objective \"Verify the fix\" --json"],
  },
  {
    id: "history",
    usage: "conclave history [path] [--json]",
    group: "workflow",
    description: localized("List PR reviews previously saved for this repository.", "Lista reviews de PR salvos anteriormente para o repositório.", "Lista revisiones de PR guardadas anteriormente para el repositorio."),
    details: localized("History stays local under `.conclave` and lets the CLI and cockpit reopen earlier results.", "O histórico fica local em `.conclave` e permite reabrir resultados anteriores na CLI e no cockpit.", "El historial permanece local en `.conclave` y permite reabrir resultados anteriores en la CLI y el cockpit."),
    examples: ["conclave history ."],
  },
  {
    id: "handoff",
    usage: "conclave handoff [path] [--json]",
    group: "workflow",
    description: localized("Print a correction request for a coding agent from the latest review.", "Mostra um pedido de correção para um coding agent com base no último review.", "Muestra una solicitud de corrección para un agente de código a partir de la última revisión."),
    details: localized("It points to the evidence and asks the agent to correct and recheck. Conclave itself does not edit the repository.", "Aponta as evidências e pede ao agente para corrigir e validar novamente. O Conclave não edita o repositório.", "Señala las evidencias y pide al agente que corrija y vuelva a validar. Conclave no edita el repositorio."),
    examples: ["conclave handoff ."],
  },
  {
    id: "open",
    usage: "conclave open [path] [--port N] [--no-browser]",
    group: "workflow",
    description: localized("Open the read-only local review cockpit in a browser.", "Abre o cockpit local e read-only de review no navegador.", "Abre el cockpit local y de solo lectura de revisión en el navegador."),
    details: localized("Shows summaries, findings, affected code, exact diff, history, and agent handoff. Stop the local server with Ctrl+C.", "Mostra resumos, achados, código afetado, diff exato, histórico e handoff do agente. Encerre o servidor local com Ctrl+C.", "Muestra resúmenes, hallazgos, código afectado, diff exacto, historial y handoff del agente. Detén el servidor local con Ctrl+C."),
    examples: ["conclave open .", "conclave open . --port 4400"],
  },
  {
    id: "scan",
    usage: "conclave scan [path] [--json]",
    group: "intelligence",
    description: localized("Inspect repository files, languages, size, and safety exclusions.", "Inspeciona arquivos, linguagens, tamanho e exclusões de segurança.", "Inspecciona archivos, lenguajes, tamaño y exclusiones de seguridad."),
    details: localized("Read-only repository inventory. It does not create a persistent index.", "Inventário read-only do repositório. Não cria índice persistente.", "Inventario de solo lectura del repositorio. No crea un índice persistente."),
    examples: ["conclave scan ."],
  },
  {
    id: "index",
    usage: "conclave index [path] [--json]",
    group: "intelligence",
    description: localized("Build the optional local index used by search, graph, Ask, and Investigate.", "Cria o índice local opcional usado por search, graph, Ask e Investigate.", "Crea el índice local opcional usado por search, graph, Ask e Investigate."),
    details: localized("Saves `.conclave/code-index-v2.json`. PR review builds its own current snapshot, so indexing is not a prerequisite for `check`.", "Salva `.conclave/code-index-v2.json`. O review de PR cria seu próprio snapshot atual, então indexar não é pré-requisito para `check`.", "Guarda `.conclave/code-index-v2.json`. La revisión de PR crea su propio snapshot actual, por lo que indexar no es requisito para `check`."),
    examples: ["conclave index ."],
  },
  {
    id: "search",
    usage: "conclave search <path> <query> [--strategy hybrid|lexical|semantic] [--limit N] [--json]",
    group: "intelligence",
    description: localized("Find the most relevant repository evidence for a query.", "Encontra as evidências mais relevantes do repositório para uma busca.", "Encuentra las evidencias más relevantes del repositorio para una consulta."),
    details: localized("Returns source excerpts and ranking signals without generating an answer.", "Retorna trechos de código e sinais de ranking sem gerar uma resposta.", "Devuelve fragmentos de código y señales de ranking sin generar una respuesta."),
    examples: ["conclave search . \"session restore\" --limit 8"],
  },
  {
    id: "retrieve",
    usage: "conclave retrieve <path> <query> [--depth N] [--limit N] [--tokens N] [--json]",
    group: "intelligence",
    description: localized("Plan and pack bounded repository context for an agent or tool.", "Planeja e empacota contexto limitado do repositório para um agente ou ferramenta.", "Planifica y empaqueta contexto limitado del repositorio para un agente o herramienta."),
    details: localized("Combines search and graph expansion under explicit source and token budgets. It still does not generate an answer.", "Combina busca e expansão do grafo com limites explícitos de fonte e tokens. Ainda assim, não gera uma resposta.", "Combina búsqueda y expansión del grafo con límites explícitos de fuente y tokens. Aun así, no genera una respuesta."),
    examples: ["conclave retrieve . \"authentication lifecycle\" --depth 2 --limit 10"],
  },
  {
    id: "symbol",
    usage: "conclave symbol <path> <symbol> [--json]",
    group: "intelligence",
    description: localized("Find indexed declarations with an exact symbol name.", "Encontra declarações indexadas com o nome exato de uma unidade de código.", "Encuentra declaraciones indexadas con el nombre exacto de una unidad de código."),
    details: localized("A symbol means a named code unit such as a function, class, method, interface, or variable—not an arbitrary word.", "Símbolo significa uma unidade de código nomeada, como função, classe, método, interface ou variável — não uma palavra solta.", "Símbolo significa una unidad de código con nombre, como función, clase, método, interfaz o variable; no una palabra suelta."),
    examples: ["conclave symbol . SuperValidator"],
  },
  {
    id: "text",
    usage: "conclave text <path> <exact text> [--json]",
    group: "intelligence",
    description: localized("Find exact text in the safe indexed source set.", "Encontra texto exato no conjunto seguro de código indexado.", "Encuentra texto exacto en el conjunto seguro de código indexado."),
    details: localized("Useful for deterministic completion claims and exact UI or API strings.", "Útil para claims determinísticos de conclusão e strings exatas de UI ou API.", "Útil para afirmaciones deterministas de finalización y cadenas exactas de UI o API."),
    examples: ["conclave text . \"Validation verdict:\""],
  },
  {
    id: "graph",
    usage: "conclave graph <path> <symbol-or-file> [--operation <kind>] [--depth N] [--limit N] [--json]",
    group: "intelligence",
    description: localized("Inspect callers, imports, references, and related code.", "Inspeciona callers, imports, referências e código relacionado.", "Inspecciona callers, imports, referencias y código relacionado."),
    details: localized("Operations: neighbors, callers, callees, imports, exports, references, containing, contained, and related.", "Operações: neighbors, callers, callees, imports, exports, references, containing, contained e related.", "Operaciones: neighbors, callers, callees, imports, exports, references, containing, contained y related."),
    examples: ["conclave graph . SuperValidator --operation callers --depth 2"],
  },
  {
    id: "path",
    usage: "conclave path <path> <from-symbol> <to-symbol> [--depth N] [--limit N] [--json]",
    group: "intelligence",
    description: localized("Find a relationship path between two named code units.", "Encontra um caminho de relações entre duas unidades de código nomeadas.", "Encuentra una ruta de relaciones entre dos unidades de código con nombre."),
    details: localized("Useful for explaining how one area may reach or affect another through the local code graph.", "Útil para explicar como uma área pode alcançar ou afetar outra pelo grafo local de código.", "Útil para explicar cómo un área puede alcanzar o afectar a otra mediante el grafo local de código."),
    examples: ["conclave path . login restoreSession"],
  },
  {
    id: "ask",
    usage: "conclave ask <path> <question> [--json] [--debug]",
    group: "intelligence",
    description: localized("Answer a repository question with optional provider-backed reasoning.", "Responde uma pergunta sobre o repositório com reasoning opcional via provider.", "Responde una pregunta sobre el repositorio con razonamiento opcional mediante proveedor."),
    details: localized("Requires `conclave init`. The provider sees only bounded retrieved evidence, not unrestricted repository access.", "Requer `conclave init`. O provider recebe somente evidências recuperadas e limitadas, não acesso irrestrito ao repositório.", "Requiere `conclave init`. El proveedor recibe solo evidencias recuperadas y limitadas, no acceso irrestricto al repositorio."),
    examples: ["conclave ask . \"Where is the session restored?\""],
  },
  {
    id: "investigate",
    usage: "conclave investigate <path> <question> [--json] [--debug]",
    group: "intelligence",
    description: localized("Challenge a suspected behavior with the full read-only reasoning route.", "Questiona um comportamento suspeito com o fluxo completo e read-only de reasoning.", "Cuestiona un comportamiento sospechoso con el flujo completo y de solo lectura de razonamiento."),
    details: localized("Requires `conclave init`. It retrieves evidence, tests hypotheses, verifies citations, and returns a judged answer without editing code.", "Requer `conclave init`. Recupera evidências, testa hipóteses, verifica citações e retorna uma resposta julgada sem editar código.", "Requiere `conclave init`. Recupera evidencias, prueba hipótesis, verifica citas y devuelve una respuesta evaluada sin editar código."),
    examples: ["conclave investigate . \"Can auth disappear after refresh?\""],
  },
  {
    id: "start",
    usage: "conclave start [path]",
    group: "setup",
    description: localized("Open the guided terminal menu.", "Abre o menu guiado no terminal.", "Abre el menú guiado en el terminal."),
    details: localized("This is also what plain `conclave` opens in an interactive terminal. Choose workflows without memorizing flags.", "É o mesmo menu aberto por `conclave` em um terminal interativo. Permite escolher fluxos sem memorizar flags.", "Es el mismo menú que abre `conclave` en un terminal interactivo. Permite elegir flujos sin memorizar flags."),
    examples: ["conclave", "conclave start ."],
  },
  {
    id: "setup",
    usage: "conclave setup [path] [--agents codex|claude|both|none] [--github-actions] [--force]",
    group: "setup",
    description: localized("Install agent skills and the optional GitHub Actions reviewer.", "Instala skills de agents e o reviewer opcional do GitHub Actions.", "Instala skills de agentes y el revisor opcional de GitHub Actions."),
    details: localized("Interactive by default. It does not configure or require an API provider.", "Interativo por padrão. Não configura nem exige um provider de API.", "Interactivo por defecto. No configura ni requiere un proveedor de API."),
    examples: ["conclave setup .", "conclave setup . --agents both --github-actions"],
  },
  {
    id: "skill",
    usage: "conclave skill install --target <target> [--scope project|user] [--project <path>] [--force]",
    group: "setup",
    description: localized("Install the small Conclave adapter for Codex, Claude, GitHub, or another agent.", "Instala o pequeno adapter do Conclave para Codex, Claude, GitHub ou outro agent.", "Instala el pequeño adaptador de Conclave para Codex, Claude, GitHub u otro agente."),
    details: localized("Targets: codex, claude, both, github-actions, and portable. The skill calls the CLI and returns a human summary plus exact evidence.", "Targets: codex, claude, both, github-actions e portable. A skill chama a CLI e retorna um resumo humano com evidências exatas.", "Targets: codex, claude, both, github-actions y portable. La skill llama a la CLI y devuelve un resumen humano con evidencias exactas."),
    examples: ["conclave skill install --target both --scope project --project ."],
  },
  {
    id: "init",
    usage: "conclave init [--provider opencode-go|openai|openrouter|anthropic] [--profile <id>|--model <id>] [--reasoning full|fast] [--project]",
    group: "setup",
    description: localized("Configure an optional model provider for Ask and Investigate.", "Configura um provider opcional para Ask e Investigate.", "Configura un proveedor opcional para Ask e Investigate."),
    details: localized("Three steps: provider, model, API key. Settings are saved per user (~/.config/conclave/credentials.env) so they work in every repository; --project writes ./.env instead. Deterministic PR review never uses this key.", "Três passos: provider, modelo, chave de API. As configurações ficam salvas por usuário (~/.config/conclave/credentials.env) e valem em todo repositório; --project grava em ./.env. O review determinístico de PR nunca usa essa chave.", "Tres pasos: proveedor, modelo, clave de API. Los ajustes se guardan por usuario (~/.config/conclave/credentials.env) y sirven en cualquier repositorio; --project escribe ./.env. La revisión determinista de PR nunca usa esta clave."),
    examples: ["conclave init", "conclave init --provider opencode-go", "echo $KEY | conclave init --provider openrouter --profile free --api-key-stdin"],
  },
  {
    id: "config",
    usage: "conclave config [set|get|unset <key> [value]] [edit|path] [--project] [--language en|pt-BR|es-ES] [--json]",
    group: "setup",
    description: localized("Show or edit settings: API key, provider, model, endpoint, language.", "Mostra ou edita configurações: chave de API, provider, modelo, endpoint, idioma.", "Muestra o edita ajustes: clave de API, proveedor, modelo, endpoint, idioma."),
    details: localized("Keys: provider, model, api-key, base-url, reasoning, mode, fallback-model, or any CONCLAVE_* name. Secrets are masked and asked hidden when the value is omitted. Precedence: shell environment > project .env > user settings (~/.config/conclave/credentials.env). Use --project to write ./.env. JSON field names remain stable in English.", "Chaves: provider, model, api-key, base-url, reasoning, mode, fallback-model ou qualquer nome CONCLAVE_*. Segredos são mascarados e pedidos de forma oculta quando o valor é omitido. Precedência: ambiente do shell > .env do projeto > configurações do usuário (~/.config/conclave/credentials.env). Use --project para gravar em ./.env. Os campos JSON continuam em inglês.", "Claves: provider, model, api-key, base-url, reasoning, mode, fallback-model o cualquier nombre CONCLAVE_*. Los secretos se enmascaran y se piden ocultos si se omite el valor. Precedencia: entorno del shell > .env del proyecto > ajustes de usuario (~/.config/conclave/credentials.env). Usa --project para escribir ./.env. Los campos JSON permanecen en inglés."),
    examples: ["conclave config", "conclave config set api-key", "conclave config set model deepseek-v4.1-flash", "conclave config unset base-url", "conclave config edit", "conclave config --language pt-BR"],
  },
  {
    id: "models",
    usage: "conclave models [--provider openai|openrouter|anthropic] [--json]",
    group: "setup",
    description: localized("List maintained model profiles available to guided setup.", "Lista os perfis de modelos mantidos para o setup guiado.", "Lista los perfiles de modelos mantenidos para la configuración guiada."),
    details: localized("Profiles are starting points. `conclave init --model` accepts an exact provider model ID.", "Os perfis são pontos de partida. `conclave init --model` aceita um ID exato do provider.", "Los perfiles son puntos de partida. `conclave init --model` acepta un ID exacto del proveedor."),
    examples: ["conclave models --provider openrouter"],
  },
  {
    id: "provider-check",
    usage: "conclave provider-check",
    group: "setup",
    description: localized("Test the configured optional reasoning provider.", "Testa o provider opcional de reasoning configurado.", "Prueba el proveedor opcional de razonamiento configurado."),
    details: localized("Runs one bounded diagnostic call and prints safe availability information without exposing the key.", "Executa uma chamada de diagnóstico limitada e mostra informações seguras sem expor a chave.", "Ejecuta una llamada de diagnóstico limitada y muestra información segura sin exponer la clave."),
    examples: ["conclave provider-check"],
  },
  {
    id: "doctor",
    usage: "conclave doctor [path] [--json]",
    group: "setup",
    description: localized("Diagnose whether a repository is ready for Conclave.", "Diagnostica se um repositório está pronto para o Conclave.", "Diagnostica si un repositorio está preparado para Conclave."),
    details: localized("Checks Git, Node.js, language support, agent skills, and GitHub integration.", "Verifica Git, Node.js, suporte de linguagens, skills de agents e integração com GitHub.", "Comprueba Git, Node.js, compatibilidad de lenguajes, skills de agentes e integración con GitHub."),
    examples: ["conclave doctor ."],
  },
  {
    id: "update",
    usage: "conclave update [--local|--global|--check]",
    group: "setup",
    description: localized("Check for or install the latest npm release.", "Verifica ou instala a versão mais recente do npm.", "Comprueba o instala la versión más reciente de npm."),
    details: localized("`--local` updates a project dependency, `--global` updates a global install, and `--check` only prints the registry version.", "`--local` atualiza a dependência do projeto, `--global` atualiza a instalação global e `--check` apenas mostra a versão do registry.", "`--local` actualiza la dependencia del proyecto, `--global` actualiza la instalación global y `--check` solo muestra la versión del registro."),
    examples: ["conclave update --check", "conclave update --global"],
  },
  {
    id: "help",
    usage: "conclave help [command]",
    group: "setup",
    description: localized("Show every command or open the detailed guide for one command.", "Mostra todos os comandos ou abre o guia detalhado de um comando.", "Muestra todos los comandos o abre la guía detallada de un comando."),
    details: localized("The full catalog groups commands by purpose. Detailed help explains syntax, behavior, boundaries, and practical examples.", "O catálogo completo agrupa comandos por objetivo. A ajuda detalhada explica sintaxe, comportamento, limites e exemplos práticos.", "El catálogo completo agrupa comandos por objetivo. La ayuda detallada explica sintaxis, comportamiento, límites y ejemplos prácticos."),
    examples: ["conclave help", "conclave help check", "conclave help config"],
  },
  {
    id: "mcp",
    usage: "conclave mcp <path>",
    group: "advanced",
    description: localized("Expose read-only repository tools over stdio MCP.", "Expõe ferramentas read-only do repositório via MCP stdio.", "Expone herramientas de solo lectura del repositorio mediante MCP stdio."),
    details: localized("The server is locked to one repository root and exposes search, graph, evidence, Ask, and Investigate tools.", "O servidor fica preso a uma raiz de repositório e expõe ferramentas de search, graph, evidence, Ask e Investigate.", "El servidor queda limitado a una raíz de repositorio y expone herramientas de search, graph, evidence, Ask e Investigate."),
    examples: ["conclave mcp /path/to/repository"],
  },
  {
    id: "eval",
    usage: "conclave eval <path> <cases.json> [--json]",
    group: "advanced",
    description: localized("Run deterministic retrieval evaluation cases.", "Executa casos determinísticos de avaliação de retrieval.", "Ejecuta casos deterministas de evaluación de retrieval."),
    details: localized("Developer command for measuring whether repository evidence retrieval finds expected code.", "Comando de desenvolvimento para medir se o retrieval encontra o código esperado.", "Comando de desarrollo para medir si la recuperación encuentra el código esperado."),
    examples: ["conclave eval ./fixture ./cases.json --json"],
  },
  {
    id: "eval-graph",
    usage: "conclave eval-graph <path> <cases.json...> [--json]",
    group: "advanced",
    description: localized("Run retrieval evaluation with graph-aware cases.", "Executa avaliação de retrieval com casos baseados em grafo.", "Ejecuta evaluación de recuperación con casos basados en grafo."),
    details: localized("Developer command used by release verification for relationship and path coverage.", "Comando de desenvolvimento usado na verificação de release para cobertura de relações e caminhos.", "Comando de desarrollo usado en la verificación de versión para cobertura de relaciones y rutas."),
    examples: ["conclave eval-graph ./fixture ./cases.json --json"],
  },
  {
    id: "eval-reasoning",
    usage: "conclave eval-reasoning <path> <cases.json> [--json]",
    group: "advanced",
    description: localized("Run configured-provider reasoning evaluation cases.", "Executa casos de avaliação de reasoning com o provider configurado.", "Ejecuta casos de evaluación de razonamiento con el proveedor configurado."),
    details: localized("Opt-in developer evaluation; it may make provider calls according to your configuration.", "Avaliação de desenvolvimento opt-in; pode fazer chamadas ao provider conforme sua configuração.", "Evaluación de desarrollo opt-in; puede hacer llamadas al proveedor según tu configuración."),
    examples: ["conclave eval-reasoning ./fixture ./reasoning-cases.json --json"],
  },
  {
    id: "demo",
    usage: "conclave demo",
    group: "advanced",
    description: localized("Run the bundled deterministic product demo.", "Executa a demo determinística incluída no pacote.", "Ejecuta la demo determinista incluida en el paquete."),
    details: localized("Useful for a quick smoke test of the local product service and reasoning fixture.", "Útil para um smoke test rápido do serviço local e do fixture de reasoning.", "Útil para una prueba rápida del servicio local y del fixture de razonamiento."),
    examples: ["conclave demo"],
  },
];

const UI = {
  en: {
    tagline: "Your PR companion: context, evidence, and a safer path from code change to merge.",
    usage: "Usage",
    examples: "Examples",
    allCommands: "All commands",
    commandNotFound: "No help entry exists for",
    helpHint: "Use `conclave help <command>` for details and examples.",
    languageHint: "Interface language: English. Change it with `conclave config --language pt-BR` or `--language es-ES`.",
  },
  "pt-BR": {
    tagline: "Seu companheiro de PR: contexto, evidências e um caminho mais seguro da mudança ao merge.",
    usage: "Uso",
    examples: "Exemplos",
    allCommands: "Todos os comandos",
    commandNotFound: "Não existe ajuda para",
    helpHint: "Use `conclave help <comando>` para ver detalhes e exemplos.",
    languageHint: "Idioma da interface: português (Brasil). Mude com `conclave config --language en` ou `--language es-ES`.",
  },
  "es-ES": {
    tagline: "Tu compañero de PR: contexto, evidencias y un camino más seguro desde el cambio hasta el merge.",
    usage: "Uso",
    examples: "Ejemplos",
    allCommands: "Todos los comandos",
    commandNotFound: "No existe ayuda para",
    helpHint: "Usa `conclave help <comando>` para ver detalles y ejemplos.",
    languageHint: "Idioma de la interfaz: español (España). Cámbialo con `conclave config --language en` o `--language pt-BR`.",
  },
} as const;

export function cliHelp(language: InterfaceLanguage, requestedCommand?: string): string {
  const ui = UI[language];
  const requested = requestedCommand === "skill install" ? "skill" : requestedCommand;
  if (requested !== undefined && requested !== "") {
    const command = COMMANDS.find((item) => item.id === requested);
    if (command === undefined) return `${ui.commandNotFound} \`${requested}\`.\n\n${cliHelp(language)}`;
    return [
      `Conclave · ${command.id}`,
      command.description[language],
      "",
      `${ui.usage}:`,
      `  ${command.usage}`,
      "",
      command.details[language],
      "",
      `${ui.examples}:`,
      ...command.examples.map((example) => `  ${example}`),
      "",
      ui.helpHint,
    ].join("\n");
  }
  const lines = [
    "CONCLAVE",
    ui.tagline,
    "",
    `${ui.usage}: conclave <command> [options]`,
    "       conclave                  # guided menu",
    "       conclave help <command>   # command details",
    "",
    ui.allCommands,
  ];
  for (const group of ["workflow", "intelligence", "setup", "advanced"] as const) {
    lines.push("", GROUPS[group][language]);
    for (const command of COMMANDS.filter((item) => item.group === group)) {
      lines.push(`  ${command.id.padEnd(16)} ${command.description[language]}`);
    }
  }
  lines.push("", "  --version        " + localized("Print the installed version.", "Mostra a versão instalada.", "Muestra la versión instalada.")[language]);
  lines.push("", ui.helpHint, ui.languageHint);
  return lines.join("\n");
}

export function languageDisplayName(language: InterfaceLanguage, displayLanguage: InterfaceLanguage): string {
  const names: Readonly<Record<InterfaceLanguage, LocalizedText>> = {
    en: localized("English", "Inglês", "Inglés"),
    "pt-BR": localized("Portuguese (Brazil)", "Português (Brasil)", "Portugués (Brasil)"),
    "es-ES": localized("Spanish (Spain)", "Espanhol (Espanha)", "Español (España)"),
  };
  return names[language][displayLanguage];
}

export function interfaceCopy(language: InterfaceLanguage) {
  return {
    errorPrefix: localized("Conclave error", "Erro do Conclave", "Error de Conclave")[language],
    unknownError: localized("Unknown error", "Erro desconhecido", "Error desconocido")[language],
    unknownCommand: localized("Unknown command", "Comando desconhecido", "Comando desconocido")[language],
    choose: localized("Choose", "Escolha", "Elige")[language],
    repository: localized("Repository", "Repositório", "Repositorio")[language],
    guidedTitle: localized("Conclave — your PR companion", "Conclave — seu companheiro de PR", "Conclave — tu compañero de PR")[language],
    guidedQuestion: localized("What do you want to do?", "O que você quer fazer?", "¿Qué quieres hacer?")[language],
    configTitle: localized("Conclave configuration", "Configuração do Conclave", "Configuración de Conclave")[language],
    interfaceLanguage: localized("Interface language", "Idioma da interface", "Idioma de la interfaz")[language],
    preferencesFile: localized("Preferences file", "Arquivo de preferências", "Archivo de preferencias")[language],
    providerConfig: localized("Optional reasoning provider", "Provider opcional de reasoning", "Proveedor opcional de razonamiento")[language],
    languageSaved: localized("Interface language saved", "Idioma da interface salvo", "Idioma de la interfaz guardado")[language],
    jsonStable: localized("JSON field names stay in English for automation compatibility.", "Os campos JSON continuam em inglês para manter compatibilidade com automações.", "Los campos JSON permanecen en inglés para mantener la compatibilidad con automatizaciones.")[language],
    collecting: localized("Collecting", "Coletando", "Recopilando")[language],
    indexing: localized("Indexing", "Indexando", "Indexando")[language],
    validating: localized("Validating", "Validando", "Validando")[language],
    gitChange: localized("Git change", "mudança do Git", "cambio de Git")[language],
    localContext: localized("local repository context", "contexto local do repositório", "contexto local del repositorio")[language],
    objectiveImpactClaims: localized("objective, impact, and claims", "objetivo, impacto e claims", "objetivo, impacto y afirmaciones")[language],
    included: localized("Included", "Incluído", "Incluido")[language],
    untrackedFiles: localized("untracked file(s)", "arquivo(s) untracked", "archivo(s) untracked")[language],
    selectedSource: localized("selected source", "fonte selecionada", "origen seleccionado")[language],
    validationVerdict: localized("Validation verdict", "Veredito da validação", "Veredicto de la validación")[language],
    objective: localized("Objective", "Objetivo", "Objetivo")[language],
    comparison: localized("Comparison", "Comparação", "Comparación")[language],
    baseBranch: localized("base branch", "branch base", "rama base")[language],
    changed: localized("Changed", "Alterado", "Cambiado")[language],
    impact: localized("Impact", "Impacto", "Impacto")[language],
    files: localized("files", "arquivos", "archivos")[language],
    codeUnits: localized("code units", "unidades de código", "unidades de código")[language],
    changedFiles: localized("Changed files", "Arquivos alterados", "Archivos modificados")[language],
    noHunks: localized("no hunks", "sem hunks", "sin hunks")[language],
    hunk: localized("hunk", "hunk", "hunk")[language],
    from: localized("from", "de", "de")[language],
    next: localized("Next", "Próximo passo", "Siguiente paso")[language],
    claim: localized("CLAIM", "CLAIM", "AFIRMACIÓN")[language],
    prSummary: localized("PR summary", "Resumo do PR", "Resumen del PR")[language],
    verdict: localized("Verdict", "Veredito", "Veredicto")[language],
    verificationGaps: localized("Still needs verification", "Ainda precisa de verificação", "Pendiente de verificación")[language],
    reviewProgress: localized("Correction progress", "Progresso da correção", "Progreso de la corrección")[language],
    risks: localized("Risks", "Riscos", "Riesgos")[language],
    nextSteps: localized("Next steps", "Próximos passos", "Siguientes pasos")[language],
    nextForAgent: localized("Next for your coding agent", "Próximo passo para o seu coding agent", "Siguiente paso para tu agente de código")[language],
    fullEvidence: localized("Full evidence: run the same command with --json. Reopen this result with `conclave history`.", "Evidência completa: execute o mesmo comando com --json. Reabra este resultado com `conclave history`.", "Evidencia completa: ejecuta el mismo comando con --json. Vuelve a abrir este resultado con `conclave history`.")[language],
    reviewHistory: localized("Review history", "Histórico de reviews", "Historial de revisiones")[language],
    noHistory: localized("No Conclave PR reviews have been recorded for this repository yet.", "Ainda não há reviews de PR do Conclave neste repositório.", "Todavía no hay revisiones de PR de Conclave en este repositorio.")[language],
    ready: localized("Ready", "Pronto", "Preparado")[language],
    setupCompleteHint: localized("Run `conclave check .` yourself, or ask your coding agent to validate the current change.", "Execute `conclave check .` ou peça ao seu coding agent para validar a mudança atual.", "Ejecuta `conclave check .` o pide a tu agente de código que valide el cambio actual.")[language],
    providerOptional: localized("Provider setup is optional and separate: `conclave init` enables Ask and Investigate.", "A configuração de provider é opcional e separada: `conclave init` habilita Ask e Investigate.", "La configuración del proveedor es opcional e independiente: `conclave init` habilita Ask e Investigate.")[language],
    readOnlyServer: localized("Read-only local server. Press Ctrl+C to stop.", "Servidor local e somente leitura. Pressione Ctrl+C para encerrar.", "Servidor local y de solo lectura. Pulsa Ctrl+C para detenerlo.")[language],
    updateComplete: localized("Conclave updated. Run `conclave --version` or `npm list conclave-ai` to confirm.", "Conclave atualizado. Execute `conclave --version` ou `npm list conclave-ai` para confirmar.", "Conclave actualizado. Ejecuta `conclave --version` o `npm list conclave-ai` para confirmarlo.")[language],
    updatingGlobal: localized("Updating Conclave globally...", "Atualizando o Conclave globalmente...", "Actualizando Conclave globalmente...")[language],
    updatingProject: localized("Updating Conclave in this project...", "Atualizando o Conclave neste projeto...", "Actualizando Conclave en este proyecto...")[language],
    evidence: localized("Evidence", "Evidências", "Evidencias")[language],
    agentsExecuted: localized("Agents executed", "Agents executados", "Agentes ejecutados")[language],
    agentSkipped: localized("Agent skipped", "Agent ignorado", "Agente omitido")[language],
    trace: localized("Trace", "Trace", "Traza")[language],
    plan: localized("Plan", "Plano", "Plan")[language],
    context: localized("Context", "Contexto", "Contexto")[language],
    languages: localized("Languages", "Linguagens", "Lenguajes")[language],
  } as const;
}

export type GuidedMenu = "main" | "more" | "settings";

type ChoiceRow = readonly [string, string, string];

const GUIDED_MENUS: Readonly<Record<GuidedMenu, Readonly<Record<InterfaceLanguage, readonly ChoiceRow[]>>>> = {
  main: {
    en: [
      ["check", "Check the current change", "Branch commits and every local file, automatically (recommended)"],
      ["compare", "Compare branches", "Pick base and target from a list, without changing checkout"],
      ["open", "Open the visual cockpit", "Browser interface for reviews, history, and settings"],
      ["ask", "Ask about the code", "Answer a repository question with your AI provider"],
      ["investigate", "Investigate a behavior", "Challenge hypotheses with the full read-only reasoning route"],
      ["more", "More tools…", "Advanced review, acceptance criteria, index, history"],
      ["settings", "Settings…", "AI provider, API key, model, language, agents, updates"],
      ["help", "Show all commands", "Print the complete command catalog"],
    ],
    "pt-BR": [
      ["check", "Revisar a mudança atual", "Commits da branch e todos os arquivos locais, automaticamente (recomendado)"],
      ["compare", "Comparar branches", "Escolha base e destino numa lista, sem trocar o checkout"],
      ["open", "Abrir o cockpit visual", "Interface no navegador para reviews, histórico e configurações"],
      ["ask", "Perguntar sobre o código", "Responde perguntas do repositório com seu provider de IA"],
      ["investigate", "Investigar um comportamento", "Questiona hipóteses com o fluxo completo e read-only"],
      ["more", "Mais ferramentas…", "Review avançada, critérios de aceite, índice, histórico"],
      ["settings", "Configurações…", "Provider de IA, chave de API, modelo, idioma, agents, atualizações"],
      ["help", "Ver todos os comandos", "Mostra o catálogo completo de comandos"],
    ],
    "es-ES": [
      ["check", "Revisar el cambio actual", "Commits de la rama y todos los archivos locales, automáticamente (recomendado)"],
      ["compare", "Comparar ramas", "Elige base y destino de una lista, sin cambiar el checkout"],
      ["open", "Abrir el cockpit visual", "Interfaz en el navegador para revisiones, historial y ajustes"],
      ["ask", "Preguntar sobre el código", "Responde preguntas del repositorio con tu proveedor de IA"],
      ["investigate", "Investigar un comportamiento", "Cuestiona hipótesis con el flujo completo de solo lectura"],
      ["more", "Más herramientas…", "Revisión avanzada, criterios de aceptación, índice, historial"],
      ["settings", "Ajustes…", "Proveedor de IA, clave de API, modelo, idioma, agentes, actualizaciones"],
      ["help", "Ver todos los comandos", "Muestra el catálogo completo de comandos"],
    ],
  },
  more: {
    en: [
      ["review", "Review evidence (advanced)", "Low-level report for a branch, working tree, staged change, or commit"],
      ["criteria", "Edit acceptance criteria", "Objective and criteria that check and review must satisfy"],
      ["understand", "Understand this repository", "Build a local index of files, code units, and relationships"],
      ["history", "Show review history", "Previous local review passes for this repository"],
      ["back", "← Back", "Return to the main menu"],
    ],
    "pt-BR": [
      ["review", "Revisar evidências (avançado)", "Relatório de baixo nível para branch, working tree, staged ou commit"],
      ["criteria", "Editar critérios de aceite", "Objetivo e critérios que check e review devem cumprir"],
      ["understand", "Entender este repositório", "Cria um índice local de arquivos, unidades de código e relações"],
      ["history", "Ver histórico de reviews", "Reviews locais anteriores deste repositório"],
      ["back", "← Voltar", "Volta ao menu principal"],
    ],
    "es-ES": [
      ["review", "Revisar evidencias (avanzado)", "Informe de bajo nivel para rama, working tree, staged o commit"],
      ["criteria", "Editar criterios de aceptación", "Objetivo y criterios que check y review deben cumplir"],
      ["understand", "Entender este repositorio", "Crea un índice local de archivos, unidades de código y relaciones"],
      ["history", "Ver historial de revisiones", "Revisiones locales anteriores de este repositorio"],
      ["back", "← Volver", "Vuelve al menú principal"],
    ],
  },
  settings: {
    en: [
      ["provider", "Set up AI provider", "Provider, model, and API key in three steps"],
      ["api-key", "Change API key", "Replace the saved key (input hidden)"],
      ["model", "Change model", "Type a model ID for the current provider"],
      ["config", "Show current settings", "Every value and where it comes from (secrets masked)"],
      ["edit-config", "Edit settings file", "Open the settings file in your $EDITOR"],
      ["language", "Change interface language", "English, Portuguese (Brazil), or Spanish (Spain)"],
      ["setup", "Set up agents and GitHub", "Install the agent skill and optional pull-request workflow"],
      ["doctor", "Check installation", "Diagnose Git, languages, skills, and GitHub integration"],
      ["update", "Update Conclave", "Install the latest CLI version"],
      ["back", "← Back", "Return to the main menu"],
    ],
    "pt-BR": [
      ["provider", "Configurar provider de IA", "Provider, modelo e chave de API em três passos"],
      ["api-key", "Trocar chave de API", "Substitui a chave salva (entrada oculta)"],
      ["model", "Trocar modelo", "Digite o ID de modelo do provider atual"],
      ["config", "Ver configurações atuais", "Todos os valores e de onde vêm (segredos mascarados)"],
      ["edit-config", "Editar arquivo de configuração", "Abre o arquivo no seu $EDITOR"],
      ["language", "Mudar idioma da interface", "Inglês, português (Brasil) ou espanhol (Espanha)"],
      ["setup", "Configurar agents e GitHub", "Instala a skill e o workflow opcional de pull request"],
      ["doctor", "Verificar a instalação", "Diagnostica Git, linguagens, skills e integração com GitHub"],
      ["update", "Atualizar o Conclave", "Instala a versão mais recente da CLI"],
      ["back", "← Voltar", "Volta ao menu principal"],
    ],
    "es-ES": [
      ["provider", "Configurar proveedor de IA", "Proveedor, modelo y clave de API en tres pasos"],
      ["api-key", "Cambiar clave de API", "Sustituye la clave guardada (entrada oculta)"],
      ["model", "Cambiar modelo", "Escribe el ID de modelo del proveedor actual"],
      ["config", "Ver ajustes actuales", "Todos los valores y su origen (secretos enmascarados)"],
      ["edit-config", "Editar archivo de ajustes", "Abre el archivo en tu $EDITOR"],
      ["language", "Cambiar idioma de la interfaz", "Inglés, portugués (Brasil) o español (España)"],
      ["setup", "Configurar agentes y GitHub", "Instala la skill y el workflow opcional de pull request"],
      ["doctor", "Comprobar la instalación", "Diagnostica Git, lenguajes, skills e integración con GitHub"],
      ["update", "Actualizar Conclave", "Instala la versión más reciente de la CLI"],
      ["back", "← Volver", "Vuelve al menú principal"],
    ],
  },
};

export function guidedChoices(
  language: InterfaceLanguage,
  menu: GuidedMenu = "main",
): readonly { readonly id: string; readonly label: string; readonly description: string }[] {
  return GUIDED_MENUS[menu][language].map(([id, label, description]) => ({ id, label, description }));
}
