import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { table } from "./cli-audit.js";
import type { AuditSeverity } from "./domain/audit.js";
import { FINDING_DISPOSITIONS, FINDING_LIFECYCLE_STATES, type FindingDisposition, type FindingLifecycleState } from "./domain/finding-ledger.js";
import { PROPOSAL_STATUSES, type IssueProposal, type ProposalStatus } from "./domain/issue-proposal.js";
import { cliActor, TriageService, type FindingView, type ProposalDetail } from "./workflow/triage-service.js";

/**
 * `conclave findings` and `conclave issues`: the local workflow over audit results. Everything
 * here reads and writes `.conclave` in one repository. Nothing is sent anywhere, and there is
 * no `issues publish`.
 */

export const FINDINGS_USAGE = "conclave findings list|show|classify|runs [ID] [--repo PATH] [--json]";
export const ISSUES_USAGE = "conclave issues propose|list|show|edit|submit|approve|reject|ready|refresh [ID] [--repo PATH] [--json]";

const MAX_BODY_FILE_BYTES = 64_000;
const MIN_REVISION_PREFIX = 12;

interface Options {
  readonly positional: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, readonly string[]>;
}

/** Options are declared per subcommand, so a mistyped one is an error and never silently ignored. */
function parse(args: readonly string[], declared: { readonly flags?: readonly string[]; readonly values?: readonly string[] }, usage: string): Options {
  const flagNames = ["json", ...(declared.flags ?? [])];
  const valueNames = ["repo", ...(declared.values ?? [])];
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (flagNames.includes(name) && equals === -1) flags.add(name);
    else if (valueNames.includes(name)) {
      const value = equals === -1 ? args[index += 1] : argument.slice(equals + 1);
      if (value === undefined || (equals === -1 && value.startsWith("--"))) throw new Error(`--${name} requires a value. Usage: ${usage}`);
      values.set(name, [...(values.get(name) ?? []), value]);
    } else throw new Error(`Unknown option: ${argument}. Usage: ${usage}`);
  }
  return { positional, flags, values };
}

function one(options: Options, name: string): string | undefined {
  const all = options.values.get(name);
  if (all !== undefined && all.length > 1) throw new Error(`--${name} was given more than once`);
  return all?.[0];
}

function list<T extends string>(options: Options, name: string, allowed: readonly T[]): readonly T[] | undefined {
  const given = options.values.get(name)?.flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value !== "");
  if (given === undefined) return undefined;
  for (const value of given) if (!(allowed as readonly string[]).includes(value)) throw new Error(`--${name} must be one of: ${allowed.join(", ")}`);
  return given as T[];
}

function reference(options: Options, kind: string, usage: string): string {
  const [value, extra] = options.positional;
  if (value === undefined || extra !== undefined) throw new Error(`Expected one ${kind} id. Usage: ${usage}`);
  return value;
}

async function service(options: Options): Promise<TriageService> {
  return TriageService.open(one(options, "repo") ?? ".");
}

function print(options: Options, value: unknown, text: () => string): void {
  console.log(options.flags.has("json") ? JSON.stringify(value, undefined, 2) : text());
}

/** The hexadecimal part of an id, shortened. Any unique leading part is accepted back as a reference. */
function short(id: string): string {
  return id.slice(id.lastIndexOf("_") + 1, id.lastIndexOf("_") + 11);
}

function where(finding: { readonly location: { readonly path: string; readonly startLine?: number } }): string {
  return `${finding.location.path}${finding.location.startLine === undefined ? "" : `:${String(finding.location.startLine)}`}`;
}

function marks(finding: FindingView): string {
  const notes = [
    ...(finding.suppressed ? ["suppressed"] : []),
    ...(finding.baselined ? ["baseline"] : []),
    ...(finding.applicability === undefined ? [] : [finding.applicability.role]),
    ...finding.proposals.filter((proposal) => proposal.status !== "rejected").map((proposal) => `proposal ${proposal.status}`),
  ];
  return notes.length === 0 ? "" : ` [${notes.join(", ")}]`;
}

function renderFindings(findings: readonly FindingView[], total: number): string {
  if (findings.length === 0) return total === 0 ? "No findings recorded. Run `conclave audit` first." : `No finding matches (${String(total)} recorded). Use --all to include resolved findings.`;
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.state, (counts.get(finding.state) ?? 0) + 1);
  return [
    ...table([
      ["ID", "STATE", "DISPOSITION", "SEVERITY", "RULE", "LOCATION", "FINDING"],
      ...findings.map((finding) => [short(finding.id), finding.state, finding.disposition.classification, finding.severity, finding.ruleId, where(finding), finding.title + marks(finding)]),
    ]),
    "",
    `${String(findings.length)} of ${String(total)} recorded finding(s): ${FINDING_LIFECYCLE_STATES.filter((state) => counts.has(state)).map((state) => `${String(counts.get(state))} ${state}`).join(", ")}.`,
    "A finding is a rule match with source evidence. It is a confirmed problem only when a person classified it so.",
  ].join("\n");
}

async function findingsList(args: readonly string[]): Promise<void> {
  const options = parse(args, { flags: ["all", "suppressed", "baselined", "not-baselined"], values: ["state", "disposition", "rule", "severity", "path"] }, FINDINGS_USAGE);
  if (options.positional.length > 0) throw new Error(`findings list takes no id. Usage: ${FINDINGS_USAGE}`);
  const severity = list<AuditSeverity>(options, "severity", ["high", "medium", "low"]);
  if (severity !== undefined && severity.length !== 1) throw new Error("--severity takes one value");
  const states = list<FindingLifecycleState>(options, "state", FINDING_LIFECYCLE_STATES)
    // Resolved findings are history; they are listed on request.
    ?? (options.flags.has("all") ? undefined : FINDING_LIFECYCLE_STATES.filter((state) => state !== "resolved"));
  const dispositions = list<FindingDisposition>(options, "disposition", FINDING_DISPOSITIONS);
  const rule = one(options, "rule");
  const path = one(options, "path");
  const triage = await service(options);
  const findings = await triage.listFindings({
    ...(states === undefined ? {} : { states }),
    ...(dispositions === undefined ? {} : { dispositions }),
    ...(rule === undefined ? {} : { ruleId: rule }),
    ...(severity?.[0] === undefined ? {} : { severity: severity[0] }),
    ...(path === undefined ? {} : { path }),
    suppressed: options.flags.has("suppressed") || options.flags.has("all"),
    ...(options.flags.has("baselined") ? { baselined: true } : options.flags.has("not-baselined") ? { baselined: false } : {}),
  });
  const total = options.flags.has("json") ? 0 : (await triage.listFindings({ suppressed: true })).length;
  print(options, findings, () => renderFindings(findings, total));
}

async function findingsShow(args: readonly string[]): Promise<void> {
  const options = parse(args, { flags: ["source"] }, FINDINGS_USAGE);
  const triage = await service(options);
  const id = reference(options, "finding", "conclave findings show <id> [--source] [--json]");
  const detail = await triage.getFinding(id);
  const excerpts = options.flags.has("source") ? await triage.readFindingEvidence(id) : undefined;
  print(options, excerpts === undefined ? detail : { ...detail, source: excerpts }, () => {
    const { finding } = detail;
    const disposition = finding.disposition;
    const lines = [
      finding.title,
      `Finding ${finding.id} · ${finding.severity} · ${finding.ruleId} · ${finding.category}`,
      `Location ${where(finding)}${finding.location.symbol === undefined ? "" : ` in ${finding.location.symbol}`}`,
      "",
      finding.explanation,
      "",
      "What is established",
      ...(finding.origin === "ai-hypothesis"
        ? [
            "  rule matched            no",
            `  model hypothesis        yes (${finding.hypothesis?.providerId ?? "unknown provider"} · ${finding.hypothesis?.modelId ?? "unknown model"} · confidence ${finding.hypothesis?.confidence ?? "unknown"}, the model's own)`,
            `  model review            ${finding.hypothesis?.review.status ?? "not-reviewed"}${finding.hypothesis?.review.detail === undefined ? "" : ` (${finding.hypothesis.review.detail})`}`,
            "  source evidence         the quoted line exists in the file",
          ]
        : ["  rule matched            yes (deterministic)", "  source evidence         attached"]),
      "  reproduced              no, not attempted",
      `  human disposition       ${disposition.classification}${disposition.classifiedAt === undefined ? "" : ` (${disposition.classifiedAt}${disposition.classifiedBy?.name === undefined ? "" : `, ${disposition.classifiedBy.name}`})`}`,
      ...(disposition.note === undefined ? [] : [`  note                    ${disposition.note}`]),
      `  issue proposal          ${finding.proposals.length === 0 ? "none" : finding.proposals.map((proposal) => `${short(proposal.id)} ${proposal.status}`).join(", ")}`,
      "",
      `Lifecycle ${finding.state}${finding.notEvaluatedReason === undefined ? "" : ` (${finding.notEvaluatedReason})`}`,
      `  first seen ${finding.firstSeen.at} · snapshot ${finding.firstSeen.snapshot}`,
      `  last seen  ${finding.lastSeen.at} · snapshot ${finding.lastSeen.snapshot} · observed in ${String(finding.timesSeen)} audit(s)`,
      ...(finding.resolvedAt === undefined ? [] : [`  resolved   ${finding.resolvedAt.at}${finding.state === "resolved" ? "" : " (seen again since)"}`]),
      ...(finding.suppressed ? ["  suppressed by an inline conclave-ignore directive"] : []),
      ...(finding.baselined ? ["  listed in the repository baseline: visible, not counted by --fail-on"] : []),
      ...(finding.applicability === undefined ? [] : [`  declared ${finding.applicability.role} (${finding.applicability.source}): ${finding.applicability.reason}`]),
      "",
      "Evidence",
      ...finding.evidence.map((item) => `  ${item.path}${item.startLine === undefined ? "" : `:${String(item.startLine)}`} — ${item.reason}`),
    ];
    for (const excerpt of excerpts ?? []) {
      lines.push("", `  ${excerpt.path}${excerpt.withheld === undefined ? "" : ` — not shown: ${excerpt.withheld}`}`);
      for (const line of excerpt.lines ?? []) lines.push(`  ${String(line.number).padStart(5)} │ ${line.text}`);
    }
    lines.push("", "Does not establish");
    for (const limitation of finding.limitations) lines.push(`  - ${limitation}`);
    lines.push("", finding.issueEligibility.eligible
      ? `Next: conclave findings classify ${short(finding.id)} --as confirmed|false-positive|accepted-risk|needs-investigation · conclave issues propose ${short(finding.id)}`
      : `No issue proposal: ${finding.issueEligibility.reason ?? ""}`);
    return lines.join("\n");
  });
}

async function findingsClassify(args: readonly string[]): Promise<void> {
  const usage = "conclave findings classify <id> --as confirmed|false-positive|accepted-risk|needs-investigation|unreviewed [--note TEXT] [--json]";
  const options = parse(args, { values: ["as", "note"] }, usage);
  const classification = list<FindingDisposition>(options, "as", FINDING_DISPOSITIONS);
  if (classification?.length !== 1 || classification[0] === undefined) throw new Error(`--as takes one disposition. Usage: ${usage}`);
  const note = one(options, "note");
  const finding = await (await service(options)).classifyFinding(reference(options, "finding", usage), { classification: classification[0], ...(note === undefined ? {} : { note }), actor: cliActor() });
  print(options, finding, () => [
    `Finding ${short(finding.id)} classified as ${finding.disposition.classification}.`,
    "This records a person's judgement. It does not change the evidence, and it approves no issue proposal.",
    ...finding.proposals.filter((proposal) => proposal.status === "stale").map((proposal) => `Proposal ${short(proposal.id)} is now stale and needs review: conclave issues refresh ${short(proposal.id)}`),
  ].join("\n"));
}

async function findingsRuns(args: readonly string[]): Promise<void> {
  const options = parse(args, {}, FINDINGS_USAGE);
  const runs = await (await service(options)).listAuditRuns();
  print(options, runs, () => runs.length === 0 ? "No audit run recorded. Run `conclave audit` first." : table([
    ["RUN", "AT", "COMMIT", "COVERAGE", "FILES", "OBSERVED", "NEW", "PERSISTENT", "REAPPEARED", "RESOLVED", "NOT EVALUATED"],
    ...runs.map((run) => [short(run.id), run.at, run.headCommit?.slice(0, 10) ?? "-", run.coverageStatus === "partial" ? "partial" : "supported source", `${String(run.filesAnalyzed)}/${String(run.filesDiscovered)}`, String(run.findingsObserved), String(run.byState.new), String(run.byState.persistent), String(run.byState.reappeared), String(run.byState.resolved), String(run.byState["not-evaluated"])]),
  ]).join("\n"));
}

export async function findingsCommand(args: readonly string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case undefined:
    case "list": await findingsList(rest); return;
    case "show": await findingsShow(rest); return;
    case "classify": await findingsClassify(rest); return;
    case "runs": await findingsRuns(rest); return;
    default: throw new Error(`Unknown findings subcommand: ${subcommand}. Usage: ${FINDINGS_USAGE}`);
  }
}

function proposalSummary(detail: ProposalDetail): readonly string[] {
  const { proposal, gate } = detail;
  const approval = proposal.approval;
  return [
    `Proposal ${proposal.id} · ${proposal.status} · attempt ${String(proposal.attempt)}`,
    `Revision ${proposal.revision}${proposal.revision === proposal.generatedRevision ? " (generated text)" : " (edited)"}`,
    `Finding  ${proposal.findings.map((link) => short(link.id)).join(", ")} · ${proposal.severity} · ${proposal.ruleId} · reproduction ${proposal.reproduction}`,
    `Human disposition when written: ${proposal.humanDisposition}${proposal.hypothesis ? " · presented as an unconfirmed hypothesis" : ""}`,
    approval === undefined ? "Approval none" : `Approval revision ${approval.revision} · ${approval.approvedAt} · ${approval.approvedBy.name ?? approval.approvedBy.kind} · ${approval.method}`,
    ...(proposal.stale === undefined ? [] : [`Stale    ${proposal.stale.reason}`]),
    ...(proposal.rejection === undefined ? [] : [`Rejected ${proposal.rejection.reason}`]),
    ...(proposal.supersedes === undefined ? [] : [`Supersedes ${short(proposal.supersedes.proposalId)}: ${proposal.supersedes.reason}`]),
    ...(gate.publishable ? ["Publication requirements: all met. Nothing is published by this release."] : ["Publication requirements not met:", ...gate.blockers.map((blocker) => `  - ${blocker}`)]),
  ];
}

function nextStep(proposal: IssueProposal): string {
  const id = short(proposal.id);
  switch (proposal.status) {
    case "draft": return `Next: review and edit, then conclave issues submit ${id}`;
    case "pending-review": return `Next: conclave issues approve ${id} --revision ${proposal.revision}   (or conclave issues reject ${id} --reason ...)`;
    case "approved": return `Next: conclave issues ready ${id}`;
    case "ready-for-publication": return "Ready. Publication is not part of this release; nothing was sent anywhere.";
    case "stale": return `Next: conclave issues refresh ${id}, then review it again`;
    case "rejected": return "Rejected. It will not be proposed again without a stated reason.";
  }
}

function renderProposal(detail: ProposalDetail, headline: string): string {
  return [headline, ...proposalSummary(detail), nextStep(detail.proposal)].join("\n");
}

async function issuesPropose(args: readonly string[]): Promise<void> {
  const usage = "conclave issues propose <finding-id> [--reason TEXT] [--json]";
  const options = parse(args, { values: ["reason"] }, usage);
  const reason = one(options, "reason");
  const triage = await service(options);
  const created = await triage.createProposal(reference(options, "finding", usage), { actor: cliActor(), ...(reason === undefined ? {} : { reason }) });
  const detail = await triage.getProposal(created.proposal.id);
  print(options, { ...detail, created: created.created }, () => renderProposal(detail, created.created ? "Drafted an issue proposal. It is local and unapproved." : "This finding already has a proposal; no new one was created."));
}

async function issuesList(args: readonly string[]): Promise<void> {
  const options = parse(args, { values: ["status", "finding"] }, ISSUES_USAGE);
  const statuses = list<ProposalStatus>(options, "status", PROPOSAL_STATUSES);
  const finding = one(options, "finding");
  const proposals = await (await service(options)).listProposals({ ...(statuses === undefined ? {} : { statuses }), ...(finding === undefined ? {} : { findingId: finding }) });
  print(options, proposals, () => proposals.length === 0 ? "No issue proposal. Draft one with: conclave issues propose <finding-id>" : table([
    ["ID", "STATUS", "REVISION", "APPROVED", "FINDING", "TITLE"],
    ...proposals.map((proposal) => [short(proposal.id), proposal.status, proposal.revision.slice(0, MIN_REVISION_PREFIX), proposal.approval === undefined ? "no" : proposal.approval.revision === proposal.revision ? "this revision" : "another revision", proposal.findings.map((link) => short(link.id)).join(","), proposal.title]),
  ]).join("\n"));
}

async function issuesShow(args: readonly string[]): Promise<void> {
  const options = parse(args, {}, ISSUES_USAGE);
  const detail = await (await service(options)).getProposal(reference(options, "proposal", "conclave issues show <proposal-id> [--json]"));
  print(options, detail, () => [
    ...proposalSummary(detail),
    "",
    `Title:  ${detail.proposal.title}`,
    `Labels: ${detail.proposal.labels.join(", ")}`,
    "",
    "──────── body ────────",
    detail.proposal.body,
    "──────────────────────",
    nextStep(detail.proposal),
  ].join("\n"));
}

async function issuesEdit(args: readonly string[]): Promise<void> {
  const usage = "conclave issues edit <proposal-id> [--title TEXT] [--body-file FILE] [--label LABEL]... [--json]";
  const options = parse(args, { values: ["title", "body-file", "label"] }, usage);
  const title = one(options, "title");
  const bodyFile = one(options, "body-file");
  const labels = options.values.get("label");
  if (title === undefined && bodyFile === undefined && labels === undefined) throw new Error(`Nothing to change. Usage: ${usage}`);
  let body: string | undefined;
  if (bodyFile !== undefined) {
    // A path the person typed on this command line; read as text and nothing else.
    const details = await stat(bodyFile);
    if (!details.isFile() || details.size > MAX_BODY_FILE_BYTES) throw new Error(`--body-file must be a regular file of at most ${String(MAX_BODY_FILE_BYTES)} bytes`);
    body = await readFile(bodyFile, "utf8");
  }
  const triage = await service(options);
  const id = reference(options, "proposal", usage);
  const before = (await triage.getProposal(id)).proposal;
  const detail = await triage.editProposal(id, { ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), ...(labels === undefined ? {} : { labels }) }, cliActor());
  const headline = detail.proposal.revision === before.revision
    ? "No material change: the revision is the same."
    : before.approval === undefined ? `Edited. New revision ${detail.proposal.revision}.` : `Edited. New revision ${detail.proposal.revision}; the earlier approval covered ${before.approval.revision} and no longer applies.`;
  print(options, detail, () => renderProposal(detail, headline));
}

async function confirmInteractively(detail: ProposalDetail): Promise<boolean> {
  console.log([...proposalSummary(detail), "", `Title:  ${detail.proposal.title}`, `Labels: ${detail.proposal.labels.join(", ")}`, "", "Read the full text with `conclave issues show` before approving."].join("\n"));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(`Approve revision ${detail.proposal.revision} for future publication? Type "approve" to confirm: `)).trim() === "approve";
  } finally {
    prompt.close();
  }
}

/**
 * Approval is never implicit. It takes the revision the person reviewed, typed on the command
 * line, or a typed confirmation at an interactive terminal. A script without either is refused.
 */
async function issuesApprove(args: readonly string[]): Promise<void> {
  const usage = "conclave issues approve <proposal-id> --revision REVISION [--json]";
  const options = parse(args, { values: ["revision"] }, usage);
  const triage = await service(options);
  const id = reference(options, "proposal", usage);
  const given = one(options, "revision");
  const current = await triage.getProposal(id);
  let revision: string;
  let method: "cli-revision" | "cli-interactive";
  if (given !== undefined) {
    if (given.length < MIN_REVISION_PREFIX) throw new Error(`--revision needs at least ${String(MIN_REVISION_PREFIX)} characters of the revision shown by \`conclave issues show\``);
    // A leading part is completed only against the proposal it names, and a non-matching one is passed through to be refused.
    revision = current.proposal.revision.startsWith(given) ? current.proposal.revision : given;
    method = "cli-revision";
  } else if (process.stdin.isTTY && process.stdout.isTTY && !options.flags.has("json")) {
    if (!await confirmInteractively(current)) throw new Error("Not approved.");
    revision = current.proposal.revision;
    method = "cli-interactive";
  } else throw new Error(`Approval is an explicit action: pass --revision with the revision shown by \`conclave issues show ${short(current.proposal.id)}\`. Usage: ${usage}`);
  const detail = await triage.approveProposal(id, { revision, actor: cliActor(), method });
  print(options, detail, () => renderProposal(detail, `Approved revision ${detail.proposal.revision}. Any edit, or any change to the source evidence, voids this approval.`));
}

async function issuesReject(args: readonly string[]): Promise<void> {
  const usage = "conclave issues reject <proposal-id> --reason TEXT [--json]";
  const options = parse(args, { values: ["reason"] }, usage);
  const reason = one(options, "reason");
  if (reason === undefined) throw new Error(`Rejecting requires --reason. Usage: ${usage}`);
  const detail = await (await service(options)).rejectProposal(reference(options, "proposal", usage), { reason, actor: cliActor() });
  print(options, detail, () => renderProposal(detail, "Rejected."));
}

async function issuesTransition(args: readonly string[], action: "submit" | "ready" | "refresh"): Promise<void> {
  const usage = `conclave issues ${action} <proposal-id> [--json]`;
  const options = parse(args, {}, usage);
  const triage = await service(options);
  const id = reference(options, "proposal", usage);
  const detail = action === "submit" ? await triage.submitProposal(id, cliActor()) : action === "ready" ? await triage.markProposalReady(id, cliActor()) : await triage.refreshProposal(id, cliActor());
  const headline = action === "submit" ? "Submitted for review. It is not approved." : action === "ready" ? "Every publication requirement holds. Marked ready; nothing was published." : "Refreshed against the current finding and returned to draft.";
  print(options, detail, () => renderProposal(detail, headline));
}

export async function issuesCommand(args: readonly string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case undefined:
    case "list": await issuesList(rest); return;
    case "propose": await issuesPropose(rest); return;
    case "show": await issuesShow(rest); return;
    case "edit": await issuesEdit(rest); return;
    case "submit": await issuesTransition(rest, "submit"); return;
    case "approve": await issuesApprove(rest); return;
    case "reject": await issuesReject(rest); return;
    case "ready": await issuesTransition(rest, "ready"); return;
    case "refresh": await issuesTransition(rest, "refresh"); return;
    case "publish": throw new Error("Publishing is not implemented. Proposals stay local; no command in this release sends anything to GitHub.");
    default: throw new Error(`Unknown issues subcommand: ${subcommand}. Usage: ${ISSUES_USAGE}`);
  }
}
