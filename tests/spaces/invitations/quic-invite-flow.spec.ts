/**
 * QUIC Space Invitation E2E Tests — Full UI Flow
 *
 * Tests the REAL invitation flow between two vault instances over QUIC,
 * driving all user-facing actions through the actual UI:
 *
 *  - Vault creation/opening via the vault picker UI
 *  - P2P endpoint start via Settings → P2P Network
 *  - Space creation via Settings → Spaces → Create dialog
 *  - Invite sending via SpaceInviteDialog (contact mode)
 *  - Invite accept/decline via pending invite UI buttons
 *  - Policy enforcement via Spaces settings dropdown
 *
 * SQL/commands are used only for:
 *  - Contact registration (no UI for adding contacts by DID + endpoint)
 *  - Verification assertions (checking DB state matches UI actions)
 *  - Loading identities (infrastructure setup)
 *  - Self-invite edge case (impossible via UI — you can't select yourself)
 *
 * ---------------------------------------------------------------------------
 * Structure (each file <600 lines):
 *
 * - quic-helpers/        UI primitives, vault/space UI flows, SQL helper
 * - quic-phases/state.ts Shared mutable state passed across all phases
 * - quic-phases/01-setup.ts          Open vaults, P2P endpoints, identities, contact
 * - quic-phases/02-personal-space.ts Personal-space invite/decline/accept cycle
 * - quic-phases/03-local-space.ts    Create local space, attach share, send invite
 * - quic-phases/04-post-accept.ts    Inviter attribution + post-accept assertions
 * - quic-phases/05-ucan-regression.ts Subpath listing regression guard
 * - quic-phases/06-data-consistency.ts authored_by_did + relay_url + UCAN cleanup
 * - quic-phases/07-edge-cases.ts     Self-invite, policy, capability, default-collision
 *
 * Each phase exports a `registerXxxPhase(state)` function that mutates the
 * shared state object and registers `test()` blocks. They run in declaration
 * order because the describe block is `serial`. Don't reorder them lightly:
 * later phases assume earlier ones populated `state` (vaults open, spaceId
 * set, share attached, …).
 */

import { test } from "../../fixtures";
import type { QuicTestState } from "./quic-phases/state";
import { registerSetupPhase } from "./quic-phases/01-setup";
import { registerPersonalSpacePhase } from "./quic-phases/02-personal-space";
import { registerLocalSpacePhase } from "./quic-phases/03-local-space";
import { registerPostAcceptPhase } from "./quic-phases/04-post-accept";
import { registerUcanRegressionPhase } from "./quic-phases/05-ucan-regression";
import { registerDataConsistencyPhase } from "./quic-phases/06-data-consistency";
import { registerEdgeCasesPhase } from "./quic-phases/07-edge-cases";

test.describe("QUIC: real invite flow between two vaults (UI-driven)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  const state: QuicTestState = {};

  registerSetupPhase(state);
  registerPersonalSpacePhase(state);
  registerLocalSpacePhase(state);
  registerPostAcceptPhase(state);
  registerUcanRegressionPhase(state);
  registerDataConsistencyPhase(state);
  registerEdgeCasesPhase(state);
});
