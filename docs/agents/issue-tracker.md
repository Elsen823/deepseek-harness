# Issue tracker: Local Markdown

English | [中文](issue-tracker.zh.md)

Engineering specs and tickets for this repository live under `.scratch/`.

## Conventions

- Give each feature one `.scratch/<feature-slug>/` directory.
- Store an optional feature spec as `spec.md` and each implementation ticket as a separate numbered file under `issues/`.
- Number tickets from `01` in dependency order, with blockers before the tickets they gate.
- Record workflow state in a `Status:` line and dependency edges in a `Blocked by:` line.
- Append later discussion under `## Comments` instead of rewriting the accepted ticket.

## Skill operations

- Publishing creates one new ticket file; it does not rewrite unrelated tickets.
- Fetching reads the referenced ticket file in full.
- Claiming changes `Status: ready-for-agent` to `Status: claimed` before implementation begins.
- Resolving checks every acceptance criterion, records the result, and changes the status to `resolved`.
