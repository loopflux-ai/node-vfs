## Summary

<!-- What does this PR do? One or two sentences. -->

## Changes

<!-- List the concrete changes; link files/lines when relevant. -->

## Checklist

- [ ] Tests added/updated and passing (`pnpm test`)
- [ ] `pnpm lint` and `pnpm typecheck` pass
- [ ] **Error contract untouched**: no `code` strings in `errors.ts` renamed, removed, or renumbered
- [ ] If an op's behavior changed, the CQRS classification in `handlers/kinds.ts` and cache handling in `cache.ts` are still consistent
- [ ] If a new tool was added, `ALL_TOOLS` in `toolkit`, adapter tests (`test/adapters/`), and toolkit tests (`test/toolkit/`) are all updated
- [ ] Every new error/warning message carries LLM-actionable `suggestions`
- [ ] No sandbox boundary bypass: `validatePath`, policy deny, or backend `assertInsideRoot`/symlink checks are not circumvented

## Related issues

<!-- #123 -->
