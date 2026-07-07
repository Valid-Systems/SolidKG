# Upstream Governance Triage

Audience: maintainers sorting upstream issues that don't contain enough technical detail for code work.

Scope: this artifact resolves #423, #392, and #120 as maintainer-facing triage records. It doesn't create code work, funding acceptance, GUI work, or product scope. If an issue later receives concrete reproduction steps or a clear implementation request, open a new technical task from that new evidence.

## Triage Rule

Use this rule before changing code:

1. Confirm the issue has a concrete technical request, reproduction, or contract change.
2. If it doesn't, answer or close it through maintainer process, not implementation work.
3. Keep non-code outcomes explicit so later planning can point to the artifact instead of dropping the issue.

## #423 Funding Opportunity Solicitation

Named artifact: funding opportunity evaluation checklist.

Owner-facing next action: maintainer reviews the solicitation for legitimacy and chooses one of three responses, decline, request details privately, or close as not actionable for the repository.

Evaluation checklist:

1. Verify whether the sender is known to the project or has a public identity tied to the stated offer.
2. Keep any financial, wallet, tax, or legal discussion outside the issue tracker.
3. Don't accept conditions that affect project direction, release timing, issue priority, or maintainer independence through a public issue comment.
4. If the offer is not actionable, close with a short note such as: "Thanks for reaching out. We don't handle funding offers through GitHub issues. Closing this as non-technical project triage."
5. If the maintainer wants to continue the conversation, ask for a private contact path and leave the issue closed or marked non-technical.

Resolution for this task: no code change. No public claim about money status, feature priority, or delivery timing is made from #423.

## #392 Sparse Korean Coding Map Request

Named artifact: sparse multilingual product request triage.

Owner-facing next action: maintainer asks for clarification once, then closes if no actionable detail is provided.

Clarification checklist:

1. Treat the title `코딩지도` as roughly "coding map" unless the requester clarifies a different meaning.
2. Don't infer a Studio, browser visualization, graph UI, or mapping feature from the title alone.
3. Ask for the concrete workflow, expected input, expected output, and whether the request is about CLI, MCP, API, docs, or another surface.
4. If the requester doesn't reply with actionable detail, close as needs more information.
5. If a detailed reply arrives, open a fresh product or technical issue from that detail and link back to #392.

Suggested reply:

```text
Thanks for the request. Could you share more detail about what you mean by "코딩지도" / "coding map"? Please include the workflow you want, the input, the expected output, and whether this should be CLI, MCP, API, or documentation. Without that detail, we can't turn this into implementation work.
```

Resolution for this task: no code change. The request stays a clarification item until the maintainer receives concrete scope.

## #120 Merge Order For PR Backlog

Named artifact: protected backlog merge-order checklist.

Owner-facing next action: maintainer turns the proposed order into a checked integration queue before merging any upstream or fork work.

Backlog planning checklist:

1. Inventory each candidate PR or branch with issue link, owner, last rebase point, touched subsystems, and validation status.
2. Classify each item as foundation refactor, bug fix, feature, docs, packaging, or optional experiment.
3. Merge foundations before work that depends on them, but don't merge broad refactors only because they appear early in the list.
4. For this fork, protect hyperedges, SCIP, trace/explore sufficiency, snapshots, architecture rollups, provider-neutral guidance, installer safety, and release rules before accepting upstream changes.
5. Never perform a blind upstream merge that overwrites fork-specific graph, MCP, retrieval, or release behavior.
6. Use a staging branch for grouped backlog work, then run the protected validation gates before promoting it.
7. Keep optional or unclear items out of the queue until the maintainer records a concrete acceptance reason.

Minimum protected gates before promoting a backlog batch:

1. TypeScript check or build for touched code paths.
2. Targeted tests for each touched subsystem.
3. Protected graph retrieval tests when trace, explore, hyperedge, SCIP, snapshot, architecture, or MCP behavior is touched.
4. Installer contract tests when agent config or instructions are touched.
5. Release guidance review when versioning, package, or workflow files are touched.

Resolution for this task: no code change. #120 becomes backlog coordination guidance, not blanket approval for every listed PR or branch.

## Tracking Summary

* #423: maintainer evaluates or closes a funding solicitation outside code work.
* #392: maintainer requests clarification for a sparse multilingual product request, then closes or opens a new scoped issue.
* #120: maintainer uses a protected merge queue checklist before accepting backlog work.
