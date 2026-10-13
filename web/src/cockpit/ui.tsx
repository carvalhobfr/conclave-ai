import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import type { AuditFindingOrigin, HypothesisReviewStatus } from "../../../src/domain/audit.js";
import type { FindingDisposition, FindingLifecycleState } from "../../../src/domain/finding-ledger.js";
import type { ProposalStatus } from "../../../src/domain/issue-proposal.js";
import type { FindingView } from "../../../src/workflow/triage-service.js";

/**
 * Words for every state the cockpit shows. Each label says what happened and nothing more: a
 * model's support is never called confirmation, and a model's rejection is never called a fix.
 */
export const REVIEW_LABEL: Readonly<Record<HypothesisReviewStatus, string>> = {
  "model-supported": "Model-supported",
  "model-disputed": "Model-disputed",
  inconclusive: "Inconclusive",
  "not-reviewed": "Not reviewed",
};

export const REVIEW_MEANING: Readonly<Record<HypothesisReviewStatus, string>> = {
  "model-supported": "A second model reading agreed with the hypothesis. That is a model judgement, not a confirmation and not a reproduction.",
  "model-disputed": "A model reading rejected the hypothesis. It is kept: that judgement varies between runs and has rejected true hypotheses.",
  inconclusive: "Verification could not decide, or the verification call failed. Nothing is established either way.",
  "not-reviewed": "No verification was run on this hypothesis.",
};

export const DISPOSITION_LABEL: Readonly<Record<FindingDisposition, string>> = {
  unreviewed: "Unreviewed",
  confirmed: "Confirmed by a person",
  "false-positive": "False positive",
  "accepted-risk": "Accepted risk",
  "needs-investigation": "Needs investigation",
};

export const LIFECYCLE_LABEL: Readonly<Record<FindingLifecycleState, string>> = {
  new: "New",
  persistent: "Persistent",
  reappeared: "Reappeared",
  "not-evaluated": "Not evaluated",
  resolved: "Resolved",
};

export const PROPOSAL_LABEL: Readonly<Record<ProposalStatus, string>> = {
  draft: "Draft",
  "pending-review": "Pending review",
  approved: "Approved",
  "ready-for-publication": "Ready for publication",
  stale: "Stale",
  rejected: "Rejected",
};

export function originOf(finding: Pick<FindingView, "origin">): AuditFindingOrigin {
  return finding.origin ?? "deterministic-rule";
}

export function reviewOf(finding: Pick<FindingView, "hypothesis">): HypothesisReviewStatus {
  return finding.hypothesis?.review.status ?? "not-reviewed";
}

export function locationOf(finding: Pick<FindingView, "location">): string {
  return `${finding.location.path}${finding.location.startLine === undefined ? "" : `:${String(finding.location.startLine)}`}`;
}

export function shortId(id: string): string {
  return id.slice(id.lastIndexOf("_") + 1).slice(0, 8);
}

export function when(value: string | undefined): string {
  if (value === undefined) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function duration(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${String(Math.floor(ms / 60_000))} min ${String(Math.round((ms % 60_000) / 1_000))} s`;
}

export function percent(part: number, whole: number): string {
  return whole === 0 ? "none" : `${String(Math.round((part / whole) * 100))}%`;
}

type Tone = "neutral" | "strong" | "ok" | "warn" | "danger";

export function Badge({ children, tone = "neutral", className = "", title }: { readonly children: ReactNode; readonly tone?: Tone; readonly className?: string; readonly title?: string }) {
  return <span className={`ck-badge ${tone === "neutral" ? "" : tone} ${className}`.trim()} title={title}>{children}</span>;
}

/** The two origins are told apart by shape and words, not by colour alone. */
export function OriginBadge({ origin }: { readonly origin: AuditFindingOrigin }) {
  return origin === "ai-hypothesis"
    ? <Badge className="origin-ai plain" title="Proposed by a language model. Not a confirmed defect.">AI hypothesis</Badge>
    : <Badge className="origin-static plain" title="A deterministic rule matched this source.">Static finding</Badge>;
}

const REVIEW_TONE: Readonly<Record<HypothesisReviewStatus, Tone>> = { "model-supported": "strong", "model-disputed": "warn", inconclusive: "neutral", "not-reviewed": "neutral" };

export function ReviewBadge({ status }: { readonly status: HypothesisReviewStatus }) {
  return <Badge tone={REVIEW_TONE[status]} title={REVIEW_MEANING[status]}>{REVIEW_LABEL[status]}</Badge>;
}

export function SeverityBadge({ severity, modelAssigned }: { readonly severity: "high" | "medium" | "low"; readonly modelAssigned: boolean }) {
  return <Badge tone={severity === "high" && !modelAssigned ? "danger" : "neutral"} className="plain" title={modelAssigned ? "Severity as the model stated it; not calibrated." : "Severity of the rule."}>{severity}{modelAssigned ? " · model" : ""}</Badge>;
}

export function Stat({ value, label, hint }: { readonly value: ReactNode; readonly label: string; readonly hint?: string }) {
  return <div className="ck-stat"><strong>{value}</strong><span>{label}</span>{hint === undefined ? null : <div className="ck-faint">{hint}</div>}</div>;
}

export function Card({ title, aside, children, label }: { readonly title: string; readonly aside?: ReactNode; readonly children: ReactNode; readonly label?: string }) {
  return <section className="ck-card" aria-label={label ?? title}><header><h2>{title}</h2>{aside === undefined ? null : <small>{aside}</small>}</header>{children}</section>;
}

export function Meter({ part, whole, label }: { readonly part: number; readonly whole: number; readonly label: string }) {
  const share = whole === 0 ? 0 : Math.min(100, Math.round((part / whole) * 100));
  return <div className="ck-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}><span style={{ width: `${String(share)}%` }} /></div>;
}

export function EmptyState({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className="ck-empty"><h2>{title}</h2><div>{children}</div></section>;
}

export function ErrorNote({ message }: { readonly message: string }) {
  return message === "" ? null : <div className="ck-note danger" role="alert">{message}</div>;
}

export function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <label className="ck-field"><span>{label}</span>{children}</label>;
}

/** Closes a detail panel and gives the list its full width back. */
export function CloseDetail({ onClose }: { readonly onClose: () => void }) {
  return <button type="button" className="ck-btn ghost ck-close" onClick={onClose}>Close</button>;
}

/**
 * Below the split breakpoint the detail panel sits under the list, where opening one would
 * change nothing on screen. This brings the panel into view; side by side it does nothing.
 */
export function useRevealWhenStacked(selected: string | undefined): RefObject<HTMLElement | null> {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected === undefined || typeof window.matchMedia !== "function" || !window.matchMedia("(max-width:1100px)").matches) return;
    panel.current?.scrollIntoView({ block: "start" });
  }, [selected]);
  return panel;
}

/** Closing removes the focused control, so focus returns to the row the panel was opened from. */
export function focusRow(table: HTMLElement | null, id: string): void {
  [...(table?.querySelectorAll<HTMLButtonElement>("button.row-link") ?? [])].find((button) => button.dataset["row"] === id)?.focus();
}

/** A stored reason is a clause; shown before another sentence it needs its full stop. */
export function sentence(text: string): string {
  return /[.!?]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

export function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
