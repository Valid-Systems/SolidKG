import {
  getStemVariants,
  selectRetrievalSearchTerms,
  tokenizeCodeForSearch,
} from "./query-utils";

const GENERIC_FLOW_TERMS = new Set([
  "build",
  "builds",
  "built",
  "building",
  "create",
  "creates",
  "created",
  "creating",
  "creation",
  "construction",
  "execute",
  "executes",
  "executed",
  "executing",
  "flow",
  "flows",
  "handle",
  "handles",
  "handled",
  "handling",
  "process",
  "processes",
  "processed",
  "processing",
  "run",
  "runs",
  "running",
  "send",
  "sends",
  "sent",
  "sending",
  "through",
  "trace",
  "traces",
  "traced",
  "tracing",
  "validate",
  "validates",
  "validated",
  "validating",
]);

function isExplicitCodeTerm(query: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:[.$:]${escaped}\\b|\\b${escaped}\\s*\\()`, "i").test(
    query,
  );
}

export function selectRequiredRetrievalConcepts(
  query: string,
  maxTerms = 10,
): string[] {
  const contextualSubjects = new Set(
    tokenizeCodeForSearch(
      query.match(/\bhow\s+does\s+([^\s,;?]+)/i)?.[1] ?? "",
    ).map((term) => term.toLowerCase()),
  );
  const candidates = selectRetrievalSearchTerms(query, 100)
    .filter((term) => !contextualSubjects.has(term))
    .filter(
      (term) =>
        !GENERIC_FLOW_TERMS.has(term) || isExplicitCodeTerm(query, term),
    );
  const compoundTerms = candidates.filter((term) => /[.:/]/.test(term));
  const compoundParts = new Set(
    compoundTerms.flatMap((term) =>
      tokenizeCodeForSearch(term)
        .map((part) => part.toLowerCase())
        .filter((part) => part !== term),
    ),
  );
  return candidates
    .filter(
      (term) =>
        /[.:/]/.test(term) ||
        (!compoundParts.has(term) &&
          !compoundTerms.some((compound) =>
            compound.replace(/[.:/]/g, "").includes(term),
          )),
    )
    .slice(0, maxTerms);
}

export function isRetrievalConceptCovered(
  term: string,
  evidenceTokens: ReadonlySet<string>,
): boolean {
  const variants = [term, ...getStemVariants(term)];
  if (variants.some((variant) => evidenceTokens.has(variant))) return true;

  if (!/[.:/]/.test(term)) return false;
  const parts = tokenizeCodeForSearch(term)
    .map((part) => part.toLowerCase())
    .filter((part) => part !== term && !/[.:/]/.test(part));
  return (
    parts.length > 1 &&
    parts.every((part) =>
      [part, ...getStemVariants(part)].some((variant) =>
        evidenceTokens.has(variant),
      ),
    )
  );
}
