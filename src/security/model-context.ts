import type { ProviderMessage } from "../domain/provider.js";
import { assessRepositoryContent } from "./content-safety.js";

/**
 * The single boundary every piece of repository-controlled text crosses before it is sent to
 * a model provider.
 *
 * Recognized secrets are replaced by a marker that names only their category. Text that still
 * matches a detector after redaction is withheld whole. Detection is pattern based: it finds
 * the credential formats listed here and nothing else, so it reduces exposure and does not
 * prove that outgoing context is free of secrets.
 */

export type RedactionKind = "credential" | "private-key";

interface Redactor {
  readonly kind: RedactionKind;
  /** Global. A capture group named `secret` limits the replacement to that part of the match. */
  readonly expression: RegExp;
}

// Quotes may arrive JSON-escaped (`\"`), because prompts are serialized records.
const QUOTE_CHARACTERS = "\"'`";
const QUOTE = String.raw`\\?[${QUOTE_CHARACTERS}]`;

const REDACTORS: readonly Redactor[] = [
  { kind: "private-key", expression: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu },
  { kind: "credential", expression: /\bAKIA[0-9A-Z]{16}\b/gu },
  { kind: "credential", expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu },
  { kind: "credential", expression: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu },
  { kind: "credential", expression: /\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{20,}\b/gu },
  { kind: "credential", expression: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/gu },
  { kind: "credential", expression: /\bAIza[0-9A-Za-z_-]{30,}\b/gu },
  { kind: "credential", expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu },
  { kind: "credential", expression: /\b(?:Bearer|Basic)\s+(?<secret>[A-Za-z0-9._~+/=-]{20,})/gu },
  { kind: "credential", expression: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'\\]+:(?<secret>(?!\[REDACTED:)[^\s/@"'\\]{3,})@/giu },
  {
    kind: "credential",
    expression: new RegExp(
      String.raw`(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|password|passwd)[A-Za-z0-9_]*(?:${QUOTE})?\s*[:=]\s*(?:${QUOTE}(?<secret>(?!\[REDACTED:)[^${QUOTE_CHARACTERS}\\\s]{8,})${QUOTE}|(?<bare>[A-Za-z0-9_+/=-]{20,}))`,
      "giu",
    ),
  },
];

// A key header with no matching footer cannot be redacted safely: its body has no boundary.
const UNTERMINATED_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;

export interface RedactionResult {
  readonly text: string;
  readonly redactions: Readonly<Partial<Record<RedactionKind, number>>>;
  /** True when a detector still matches after redaction, so the text must not be sent. */
  readonly residual: boolean;
}

function marker(kind: RedactionKind): string {
  return `[REDACTED:${kind}]`;
}

/** Replaces recognized secrets. Markers carry the category only, never part of the value. */
export function redactSecrets(text: string): RedactionResult {
  const redactions: Partial<Record<RedactionKind, number>> = {};
  let current = text;
  for (const redactor of REDACTORS) {
    current = current.replace(redactor.expression, (match: string, ...rest: unknown[]) => {
      const groups = rest.at(-1);
      const named = typeof groups === "object" && groups !== null ? groups as Record<string, string | undefined> : {};
      const secret = named["secret"] ?? named["bare"];
      redactions[redactor.kind] = (redactions[redactor.kind] ?? 0) + 1;
      return secret === undefined ? marker(redactor.kind) : match.replace(secret, marker(redactor.kind));
    });
  }
  const residual = UNTERMINATED_PRIVATE_KEY.test(current) ||
    REDACTORS.some((redactor) => new RegExp(redactor.expression.source, redactor.expression.flags.replace("g", "")).test(current)) ||
    !assessRepositoryContent(current).externalTransmissionAllowed;
  return { text: current, redactions, residual };
}

export interface ContextRedaction {
  /** Repository path, or `outgoing-message` for a match found only in the assembled request. */
  readonly source: string;
  readonly kind: RedactionKind;
  readonly count: number;
}

export interface ContextExclusionRecord {
  readonly source: string;
  readonly reason: "unsanitizable-secret";
}

/** What was changed or withheld before transmission. Categories and paths only. */
export interface ModelContextProtection {
  readonly redactions: readonly ContextRedaction[];
  readonly exclusions: readonly ContextExclusionRecord[];
}

export const EXCLUDED_CONTEXT_MARKER = "[EXCLUDED: this content matched a secret detector and could not be sanitized]";

/** Accumulates what the boundary did during one reasoning run, for the result and the trace. */
export class ModelContextLedger {
  readonly #redactions = new Map<string, ContextRedaction>();
  readonly #exclusions = new Map<string, ContextExclusionRecord>();
  readonly #seen = new Set<string>();

  /**
   * Sanitizes one unit of repository text (an excerpt, a diff hunk). Returns the text to send:
   * redacted when that is sufficient, otherwise a fixed marker in place of the whole unit.
   * The same unit is counted once however many prompts repeat it.
   */
  public protect(source: string, text: string): string {
    const result = redactSecrets(text);
    const first = !this.#seen.has(`${source}\0${text}`);
    this.#seen.add(`${source}\0${text}`);
    if (result.residual) {
      this.#exclusions.set(source, { source, reason: "unsanitizable-secret" });
      return EXCLUDED_CONTEXT_MARKER;
    }
    if (first) this.#count(source, result.redactions);
    return result.text;
  }

  /** Carries over what an earlier stage (diff collection) already redacted or withheld. */
  public merge(protection: ModelContextProtection | undefined): void {
    for (const item of protection?.redactions ?? []) this.#count(item.source, { [item.kind]: item.count });
    for (const item of protection?.exclusions ?? []) this.#exclusions.set(item.source, item);
  }

  /** Records matches that only the final request scan found. */
  public recordOutgoing(redactions: RedactionResult["redactions"]): void {
    this.#count("outgoing-message", redactions);
  }

  #count(source: string, redactions: RedactionResult["redactions"]): void {
    for (const [kind, count] of Object.entries(redactions) as [RedactionKind, number][]) {
      const key = `${source}\0${kind}`;
      this.#redactions.set(key, { source, kind, count: (this.#redactions.get(key)?.count ?? 0) + count });
    }
  }

  public summary(): ModelContextProtection {
    return {
      redactions: [...this.#redactions.values()].sort((left, right) => left.source.localeCompare(right.source) || left.kind.localeCompare(right.kind)),
      exclusions: [...this.#exclusions.values()].sort((left, right) => left.source.localeCompare(right.source)),
    };
  }
}

export class ModelContextBlockedError extends Error {
  public constructor() {
    super("Outgoing model context matched a secret detector and could not be sanitized; nothing was sent");
    this.name = "ModelContextBlockedError";
  }
}

export interface ProtectedMessages {
  readonly messages: readonly ProviderMessage[];
  readonly redactions: RedactionResult["redactions"];
}

/**
 * The last check before a provider call, applied to the complete request. Structured context
 * is sanitized earlier with path attribution; this catches whatever reaches the request by
 * another route (the question, model-authored claims, a future prompt field).
 *
 * @throws ModelContextBlockedError when a message cannot be sanitized. The caller must not send.
 */
export function protectOutgoingMessages(messages: readonly ProviderMessage[]): ProtectedMessages {
  const redactions: Partial<Record<RedactionKind, number>> = {};
  const protectedMessages = messages.map((message) => {
    const result = redactSecrets(message.content);
    if (result.residual) throw new ModelContextBlockedError();
    for (const [kind, count] of Object.entries(result.redactions) as [RedactionKind, number][]) {
      redactions[kind] = (redactions[kind] ?? 0) + count;
    }
    return result.text === message.content ? message : { ...message, content: result.text };
  });
  return { messages: protectedMessages, redactions };
}
