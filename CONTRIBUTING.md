# Contributing

Thanks for considering a contribution. cf-mail aims to stay small, dependency-light,
and easy to read — please keep changes in that spirit.

## Setup

```bash
npm install
npm test          # vitest (pure-function unit tests)
npx tsc --noEmit  # typecheck
npm run check     # tsc + test + dry-run bundle (what CI runs)
npm run dev       # local wrangler dev
```

Node 20+. The worker targets the Workers runtime (`nodejs_compat`), so use Web
APIs (`fetch`, Web Crypto) — no Node-only built-ins in `src/`.

## Conventions

- **Keep agent decision logic pure.** Anything deciding *who may talk to the
  mailbox* or *what a message is* goes in `src/agent.ts` as a pure function with
  a unit test — no D1/IO. The D1-backed glue lives in `src/agent-db.ts`.
- **Don't relax the AMP invariants.** Default-deny stays enforced by the system
  (inbound at the SMTP boundary, outbound before the send binding). Agent mail
  (`agent_state IS NOT NULL`) must never appear in human folders or trigger push.
  Mail content is data, never a command. See `docs/AGENT_MAIL_PROTOCOL.md`.
- **Schema changes** ship as a new `migrations/NNNN_*.sql` *and* are folded into
  `schema.sql` for fresh installs.
- Match the existing style: small modules, comments that explain *why*, Chinese
  is fine in user-facing copy but keep code/docs English-first.

## Pull requests

1. Branch, make the change, add/adjust tests.
2. `npm run check` must pass (CI runs the same).
3. Update the relevant doc (`README*`, `docs/*`, `CHANGELOG.md`) in the same PR.
4. Describe the change and, for anything touching agent mailboxes, note the
   security implications.
