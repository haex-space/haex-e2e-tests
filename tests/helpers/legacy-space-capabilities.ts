/**
 * Capability strings accepted by the deployed sync-server membership API.
 *
 * These are deliberately separate from UCAN `SpaceCaps`: UCANs now carry
 * canonical CapabilitySets (`read`, `write`, …), while this API has not yet
 * migrated its persisted membership column from the historical `space/*`
 * values.
 */
import { spaceCapabilitySet, type SpaceCapabilitySet } from "@haex-space/ucan";

export const LegacySpaceCapabilities = {
  READ: "space/read",
  WRITE: "space/write",
  INVITE: "space/invite",
  ADMIN: "space/admin",
} as const;

export type LegacySpaceCapability =
  (typeof LegacySpaceCapabilities)[keyof typeof LegacySpaceCapabilities];

/**
 * The CapabilitySet the sync-server grants a member added at a legacy tier.
 *
 * Mirrors `presetForLegacyTier` in
 * haex-sync-server/src/middleware/capabilities.ts. A test that delegates a
 * different set than the server would have granted that member is not
 * exercising the server's authorization model, so this table has to track
 * that one. (`@haex-space/ucan` 0.2.0 does not export the role-preset table
 * yet — once it does, replace this with `spaceRolePreset`.)
 *
 * Builder footgun: the boolean is `delegatable`, and calling the method at all
 * GRANTS the cap — `.write(false)` grants write non-delegatably. A cap is
 * withheld by omitting the call, never by passing `false`.
 *
 * `read` is deliberately non-delegatable on the read/write tiers and
 * delegatable on the invite/admin tiers: `enforceDelegatable` reports the
 * first offender in SPACE_CAP_ORDER, so an inviter whose own `read` were
 * terminal would trip on `read` and never reach `invite`, making the invite
 * capability inert.
 */
export function presetForLegacyCapability(
  tier: LegacySpaceCapability,
): SpaceCapabilitySet {
  switch (tier) {
    case "space/read":
      return spaceCapabilitySet().read(false).build();
    case "space/write":
      return spaceCapabilitySet().read(false).write(false).build();
    case "space/invite":
      return spaceCapabilitySet().read(true).invite(true).build();
    case "space/admin":
      return spaceCapabilitySet().read(true).write(true).invite(true).admin(false).build();
  }
}
