# MLS Phase-3 committer-capability attack specs

Adversarial e2e coverage for haex-vault's Phase-3 MLS gate
(`authorization::authorize_committer_capability`, PR #781) and the §5.8
UCAN-on-commit path (PR #782). Full design/rationale:
`docs/plans/2026-08-14-mls-phase3-e2e-attack-specs-implementation.md`
in haex-vault.

## Attack model

Two vaults, both real Playwright/tauri-driver instances (`vault-a` /
`vault-b`), joined via the real P2P invite flow so B holds a genuine MLS
leaf in A's group. From there:

- **Sending a hostile commit is impossible on the wire.** A non-leader
  peer has no commit-send path (`local_delivery_broadcast_commit`
  requires leader mode). Instead, `mls::e2e_hooks` (haex-vault,
  `e2e-hooks` feature) lets B produce a cryptographically valid Remove
  commit **locally**, bypassing only its own local capability gate
  (`test_mls_remove_member_unchecked`), and lets a spec feed that commit
  bytes-for-bytes into A's **real** receive path
  (`test_mls_process_commit_report` → `MlsManager::decrypt`, same gates,
  same order as production) without ever touching the network.
- **UCAN proofs are minted directly in TS** (`mls-attack-helpers.ts`,
  `@haex-space/ucan`'s `createUcan`), not seeded into `haex_ucan_tokens` —
  the receive gate verifies the JWT string carried on the wire, not any DB
  row.
- **Every space is single-use.** A commit A's receive path rejects still
  merges into B's own local group (B's `remove_member_unchecked` always
  merges, mirroring production `remove_member`), and a rejected commit on
  A's side wedges A's normal sync loop for that space forever
  (`sync_loop/mls.rs` never advances the cursor past a rejection). Reusing
  a space across specs would let one attack's side effects contaminate
  the next.
- **Every attack spec seeds an explicit convergence precondition**
  (the removal target's own `haex_space_members` row on the *receiver's*
  db) before firing. Without it, `authorization.rs`'s
  `all_targets_already_gone` exemption can't distinguish "the member
  left" from "this receiver hasn't applied the Add yet" and silently
  accepts a proof-less commit — a false-green, not a passing test.

## Specs

| File | Tests |
|---|---|
| `happy-path.spec.ts` | A legitimate Remove, over the real wire, with the real `mls_remove_member` + `local_delivery_broadcast_commit` commands — the only spec that proves `committerUcan`/`committerCommitBindSig` actually survive the wire. |
| `no-capability-rejected.spec.ts` | B (capability-less) removes A locally via the hook; A's receive path rejects with no proof presented. |
| `forged-ucan-rejected.spec.ts` | Four sub-cases — wrong signer, broken chain, expired, wrong audience — each a differently-malformed UCAN presented alongside a real bind signature. |
| `commit-bind-replay-rejected.spec.ts` | A UCAN that validates fine, paired with a bind signature captured from a *different* commit — the replay defence. |
| `local-gate-rejected.spec.ts` | The local send-side gate (`authorize_local_removal`) rejects a raw `mls_remove_member` call from a capability-less member — no hooks, no MLS group even required. |

## Running locally

**Prerequisite:** requires a haex-vault build that includes the `mls::e2e_hooks`
Tauri commands (`test_mls_remove_member_unchecked` +
`test_mls_process_commit_report`) — introduced in haex-vault PR
[#783](https://github.com/haex-space/haex-vault/pull/783) and gated behind its
`e2e-hooks` Cargo feature. Docker's default `haex-vault:latest` image is built
with `--features e2e-hooks`, so no extra setup is needed for the flow below;
against an older image or a hand-built binary without the feature, every spec
here fails at the first `invokeTauriCommand("test_mls_…")` with an
"unknown command" error.

```bash
pnpm docker:up
pnpm docker:test -- tests/spaces/mls-committer-capability
```
