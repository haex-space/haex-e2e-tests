/**
 * Shared types for the QUIC invite-flow e2e helpers.
 */

export interface PeerStorageStatus {
  running: boolean;
  nodeId: string;
}

export type JsonValue = string | number | boolean | null;
