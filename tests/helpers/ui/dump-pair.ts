import type { VaultAutomation } from "../../fixtures";
import { sqlQuery } from "./utils";

const PREFIX = "[FLAKE-DUMP]";

function logResult(label: string, section: string, result: PromiseSettledResult<unknown>): void {
  if (result.status === "fulfilled") {
    let value: string;
    try {
      value = JSON.stringify(result.value);
    } catch {
      value = String(result.value);
    }
    console.log(`${PREFIX} ${label}.${section}: ${value}`);
  } else {
    console.log(`${PREFIX} ${label}.${section}: ERROR ${result.reason}`);
  }
}

export async function dumpVaultPair(
  a: VaultAutomation,
  b: VaultAutomation,
  label: string,
): Promise<void> {
  try {
    console.log(`${PREFIX} ${label}:`);

    const [
      aPeerStatus,
      aLocalDelivery,
      aPendingInvites,
      aIdentities,
      bPeerStatus,
      bPendingInvites,
      bIdentities,
    ] = await Promise.allSettled([
      a.invokeTauriCommand("peer_storage_status", {}),
      a.invokeTauriCommand("local_delivery_status", {}),
      sqlQuery(a, "SELECT id, status, space_id FROM haex_pending_invites"),
      sqlQuery(a, "SELECT did, name, source FROM haex_identities"),
      b.invokeTauriCommand("peer_storage_status", {}),
      sqlQuery(b, "SELECT id, status, space_id FROM haex_pending_invites"),
      sqlQuery(b, "SELECT did, name, source FROM haex_identities"),
    ]);

    logResult(label, "A.peer_storage_status", aPeerStatus);
    logResult(label, "A.local_delivery_status", aLocalDelivery);
    logResult(label, "A.haex_pending_invites", aPendingInvites);
    logResult(label, "A.haex_identities", aIdentities);
    logResult(label, "B.peer_storage_status", bPeerStatus);
    logResult(label, "B.haex_pending_invites", bPendingInvites);
    logResult(label, "B.haex_identities", bIdentities);

    console.log(`${PREFIX} --- end ${label} ---`);
  } catch (err) {
    console.log(`${PREFIX} ${label}: meta-failure: ${err}`);
  }
}
