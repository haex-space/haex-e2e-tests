import type { VaultAutomation } from "../../../fixtures";

/**
 * Mutable shared state passed across the QUIC invite-flow test phases.
 *
 * The serial test suite shares state across many sequential `test()` blocks
 * (vaults, identities, space IDs, share IDs, …). Splitting those blocks into
 * multiple files would normally drop that shared closure — so each phase
 * accepts a single `QuicTestState` instance instead and mutates the fields
 * as the flow progresses. Fields start undefined and get populated by the
 * earliest test that produces them; later tests assume the value is present
 * and use the non-null assertion (`state.vaultA!`) at the call site.
 */
export interface QuicTestState {
  vaultA?: VaultAutomation;
  vaultB?: VaultAutomation;
  nodeIdA?: string;
  nodeIdB?: string;
  identityA?: { id: string; did: string };
  identityB?: { id: string; did: string };
  personalSpaceId?: string;
  spaceId?: string;
  shareId?: string;
}

/** Constant values used across phases — kept here so they have one source of truth. */
export const QUIC_CONSTANTS = {
  spaceName: "QUIC Invite Test",
  contactLabel: "Vault B Contact",
  shareName: "QUIC Shared Folder",
  // Use an arbitrary path string; the content isn't accessed by the test,
  // only the row metadata that syncs via CRDT is checked.
  shareLocalPath: "/tmp/haex-e2e-quic-shared-folder",
} as const;
