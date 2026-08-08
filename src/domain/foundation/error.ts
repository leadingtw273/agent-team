export const domainErrorDefinitions = {
  invalid_identifier: {
    category: "validation",
    message: "The identifier is invalid.",
    retryable: false,
  },
  invalid_instant: {
    category: "validation",
    message: "The timestamp is invalid.",
    retryable: false,
  },
  not_found: {
    category: "state",
    message: "The requested resource was not found.",
    retryable: false,
  },
  conflict: {
    category: "state",
    message: "The requested change conflicts with current state.",
    retryable: false,
  },
  invariant_violation: {
    category: "internal",
    message: "A domain invariant was violated.",
    retryable: false,
  },
  permission_denied: {
    category: "authority",
    message: "The operation is not permitted.",
    retryable: false,
  },
  rate_limited: {
    category: "capacity",
    message: "The provider rate limit was reached.",
    retryable: true,
  },
  quota_unknown: {
    category: "capacity",
    message: "The provider quota cannot be confirmed.",
    retryable: true,
  },
  unavailable: {
    category: "external",
    message: "The external capability is unavailable.",
    retryable: true,
  },
  timeout: {
    category: "external",
    message: "The operation timed out.",
    retryable: true,
  },
  external_failure: {
    category: "external",
    message: "The external operation failed.",
    retryable: false,
  },
  interrupted: {
    category: "control",
    message: "The operation was interrupted.",
    retryable: true,
  },
  /** E102-3: distinct from the pre-existing `conflict` -- this is specifically what a reviewer
   * pipeline's *second* (post-provider-run) evidence integrity check reports when evidence that
   * verified cleanly *before* a reviewer provider ran no longer does (content, hash, or manifest
   * binding changed while the provider had the worktree). Never used for the *first*
   * (pre-provider-run) check, which still reports the pre-existing `conflict` -- that check has no
   * "before" state to have changed relative to. See `ReviewerPipeline.run`'s own post-review
   * evidence re-verification (reviewer.ts) for the one call site that produces this. */
  evidence_changed: {
    category: "state",
    message: "Review evidence changed after being verified.",
    retryable: false,
  },
} as const;

export type DomainErrorCode = keyof typeof domainErrorDefinitions;
export type DomainErrorCategory = (typeof domainErrorDefinitions)[DomainErrorCode]["category"];

export interface DomainError<Code extends DomainErrorCode = DomainErrorCode> {
  readonly kind: "domain_error";
  readonly code: Code;
  readonly category: (typeof domainErrorDefinitions)[Code]["category"];
  readonly message: (typeof domainErrorDefinitions)[Code]["message"];
  readonly retryable: (typeof domainErrorDefinitions)[Code]["retryable"];
}

export function domainError<Code extends DomainErrorCode>(code: Code): DomainError<Code> {
  const definition = domainErrorDefinitions[code];

  return Object.freeze({
    kind: "domain_error",
    code,
    category: definition.category,
    message: definition.message,
    retryable: definition.retryable,
  });
}

export function serializeDomainError(error: DomainError): string {
  return JSON.stringify({
    kind: error.kind,
    code: error.code,
    category: error.category,
    message: error.message,
    retryable: error.retryable,
  });
}
