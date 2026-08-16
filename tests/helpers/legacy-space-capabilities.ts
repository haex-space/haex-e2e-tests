/**
 * Capability strings accepted by the deployed sync-server membership API.
 *
 * These are deliberately separate from UCAN `SpaceCaps`: UCANs now carry
 * canonical CapabilitySets (`read`, `write`, …), while this API has not yet
 * migrated its persisted membership column from the historical `space/*`
 * values.
 */
export const LegacySpaceCapabilities = {
  READ: "space/read",
  WRITE: "space/write",
  INVITE: "space/invite",
  ADMIN: "space/admin",
} as const;
