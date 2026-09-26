import type { InterfaceLanguage } from "./config/user-preferences.js";
import type { PullRequestSummary } from "./domain/pr-summary.js";
import type { ValidationReport } from "./domain/validation.js";

const MAX_FINDINGS = 3;

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  red: "\u001B[31m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  magenta: "\u001B[35m",
} as const;

const COPY = {
  en: {
    changed: (files: number, affected: number) =>
      `${String(files)} ${files === 1 ? "file" : "files"} changed · ${String(affected)} affected`,
    risks: (count: number) => `${String(count)} ${count === 1 ? "risk" : "risks"}`,
    noRisks: "no deterministic risk found",
    more: (count: number) => `+${String(count)} more`,
    next: "Next",
    unverified: (count: number) => `${String(count)} ${count === 1 ? "item still needs" : "items still need"} verification`,
    commands: "Agent prompt: conclave handoff .  ·  Details: --verbose  ·  Browser: conclave open .",
    nothing: "Nothing to review: Git found no changed files in this comparison.",
  },
  "pt-BR": {
    changed: (files: number, affected: number) =>
      `${String(files)} ${files === 1 ? "arquivo alterado" : "arquivos alterados"} · ${String(affected)} afetado${affected === 1 ? "" : "s"}`,
    risks: (count: number) => `${String(count)} ${count === 1 ? "risco" : "riscos"}`,
    noRisks: "nenhum risco determinístico encontrado",
    more: (count: number) => `+${String(count)} outros`,
    next: "Próximo passo",
    unverified: (count: number) => `${String(count)} ${count === 1 ? "item ainda precisa" : "itens ainda precisam"} de verificação`,
    commands: "Prompt para o agente: conclave handoff .  ·  Detalhes: --verbose  ·  Navegador: conclave open .",
    nothing: "Nada para revisar: o Git não encontrou arquivos alterados nesta comparação.",
  },
  "es-ES": {
    changed: (files: number, affected: number) =>
      `${String(files)} ${files === 1 ? "archivo cambiado" : "archivos cambiados"} · ${String(affected)} afectado${affected === 1 ? "" : "s"}`,
    risks: (count: number) => `${String(count)} ${count === 1 ? "riesgo" : "riesgos"}`,
    noRisks: "ningún riesgo determinista encontrado",
    more: (count: number) => `+${String(count)} más`,
    next: "Siguiente paso",
    unverified: (count: number) => `${String(count)} ${count === 1 ? "elemento aún necesita" : "elementos aún necesitan"} verificación`,
    commands: "Prompt para el agente: conclave handoff .  ·  Detalles: --verbose  ·  Navegador: conclave open .",
    nothing: "Nada que revisar: Git no encontró archivos cambiados en esta comparación.",
  },
} as const;

function paint(color: boolean, code: string, text: string): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

function verdictColor(verdict: ValidationReport["verdict"]): string {
  if (verdict === "pass") return ANSI.green;
  if (verdict === "warn") return ANSI.yellow;
  if (verdict === "block") return ANSI.red;
  return ANSI.magenta;
}

function location(finding: ValidationReport["findings"][number]): string {
  const evidence = finding.evidence[0];
  if (evidence === undefined) return "";
  return evidence.startLine === undefined ? evidence.path : `${evidence.path}:${String(evidence.startLine)}`;
}

/**
 * The default `check` output: verdict, the few findings that matter, and one next action.
 * Everything else stays one flag or one command away so a first run is readable at a glance.
 */
export function renderCompactReview(
  report: ValidationReport,
  summary: PullRequestSummary,
  language: InterfaceLanguage,
  color: boolean,
): string {
  const copy = COPY[language];
  if (report.changeSet.files.length === 0) return `\n${copy.nothing}`;
  const severityRank = { blocking: 0, warning: 1, info: 2 } as const;
  const findings = report.findings
    .filter((finding) => finding.severity !== "info")
    .sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);
  const lines: string[] = [""];
  lines.push(paint(color, ANSI.dim, `${summary.comparison} · ${copy.changed(report.metrics.filesChanged, report.metrics.impactedFiles)}`));
  const badge = paint(color, `${ANSI.bold}${verdictColor(report.verdict)}`, report.verdict.toUpperCase());
  lines.push(`${badge}  ${findings.length === 0 ? copy.noRisks : copy.risks(findings.length)}`);
  if (findings.length > 0) {
    lines.push("");
    const shown = findings.slice(0, MAX_FINDINGS);
    const width = Math.min(40, Math.max(...shown.map((finding) => location(finding).length)));
    for (const finding of shown) {
      const mark = finding.severity === "blocking" ? paint(color, ANSI.red, "✖") : paint(color, ANSI.yellow, "⚠");
      lines.push(`  ${mark} ${location(finding).padEnd(width)}  ${finding.title}`);
      lines.push(paint(color, ANSI.dim, `    → ${finding.remediation}`));
    }
    if (findings.length > shown.length) lines.push(paint(color, ANSI.dim, `  ${copy.more(findings.length - shown.length)}`));
  }
  lines.push("");
  lines.push(`${paint(color, ANSI.bold, copy.next)}: ${summary.nextSteps[0] ?? ""}`);
  const gaps = summary.verificationGaps?.length ?? 0;
  if (gaps > 0) lines.push(paint(color, ANSI.dim, copy.unverified(gaps)));
  lines.push(paint(color, ANSI.dim, copy.commands));
  return lines.join("\n");
}
