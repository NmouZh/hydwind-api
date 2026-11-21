# Domain Docs（多仓库 / 多上下文）

How the engineering skills should consume this workspace's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the workspace root: it points at one `GLOSSARY.md` per subrepo context. Read the one for the repo you're working in.
- **`GLOSSARY.md`** at the current subrepo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
  - `hydwind-workspace/docs/adr/` — cross-repo decisions.
  - `<subrepo>/docs/adr/` — repo-specific decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
hydwind-workspace/              ← workspace root, Git repo for cross-repo docs
├── CLAUDE.md
├── GLOSSARY-MAP.md             ← context → glossary index
├── docs/
│   ├── agents/
│   └── adr/                    ← cross-repo decisions
├── hydwind-web/
│   ├── GLOSSARY.md             ← this repo's vocabulary
│   └── docs/adr/               ← repo-specific decisions
├── hydwind-gate/
└── hydwind_launcher/
```

When a new subrepo is added, add its row to `GLOSSARY-MAP.md`; keep each repo's glossary and ADRs inside that repo.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the current subrepo's `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
