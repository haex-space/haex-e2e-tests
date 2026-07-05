import { test, expect, VaultAutomation } from "../fixtures";
import { createSqlHelpers, SqlHelpers } from "../helpers/sql-helpers";

/**
 * E2E coverage for the S3-bucket-sharing feature (haex-vault PR #615):
 * `share_storage_backend` + `revoke_storage_share` Tauri commands plus the
 * `haex_s3_backends` cascade-FK migration.
 *
 * What this suite covers:
 *   - the full argument-validation contract of `share_storage_backend`
 *     (zero flags, IAM wildcards in prefix, object scope, unknown backend)
 *   - the IAM-admin-credential flow: `IamAdminCredMissing` drives the
 *     frontend recovery modal; a MinIO hint is rejected *before* the cred
 *     is persisted (v1 limitation); a syntactically-valid AWS hint is
 *     persisted but a failed provision must not leave a share row behind
 *   - the `revoke_storage_share` contract: unknown id, owned (non-share)
 *     rows, and the IAM-first ordering guarantee — when the IAM step cannot
 *     run, the DB rows survive so the user can retry
 *   - `ON DELETE CASCADE` on `haex_s3_backends.parent_backend_id`
 *     (manual_0002 table-rebuild migration): deleting an owned parent
 *     removes its shared child rows at the SQLite level
 *
 * What this suite intentionally does NOT cover (and why):
 *   - The provisioning happy path (share → member sees backend → revoke →
 *     403 at the provider). The IAM adapter only speaks to the hardcoded
 *     AWS/Wasabi IAM endpoints and rejects MinIO (its admin API is not
 *     AWS-IAM-compatible), so a real cloud account would be required.
 *     Run the manual E2E checklist in haex-vault PR #615 for that flow.
 *
 * Skipped automatically when the vault build predates the sharing feature
 * (probed in beforeAll) — MinIO-dependent tests also skip when MinIO is
 * unreachable, mirroring `remote-s3-backend.spec.ts`.
 */

interface AddBackendResponse {
  id: string;
}

const S3_BACKENDS_TABLE = "haex_s3_backends";
const PASSWORD_DETAILS_TABLE = "haex_passwords_item_details";
const PASSWORD_KEY_VALUES_TABLE = "haex_passwords_item_key_values";

const MINIO_BUCKET = "e2e-test-bucket";

const MINIO_BACKEND = {
  name: `e2e-share-backend-${Date.now()}`,
  type: "s3" as const,
  config: {
    endpoint: "http://minio:9000",
    region: "us-east-1",
    bucket: MINIO_BUCKET,
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
    pathStyle: true,
  },
};

/** Space id used for share attempts. Validation and provisioning errors all
 *  fire before the space is ever resolved (the share flow tolerates unknown
 *  spaces by design — `load_space_name` falls back to the raw id), so no
 *  real space row is needed for the error-path contract. */
const FAKE_SPACE_ID = "e2e-share-fake-space";

function shareArgs(overrides: Record<string, unknown>) {
  return {
    args: {
      storageId: "e2e-share-nonexistent-backend",
      spaceId: FAKE_SPACE_ID,
      accessFlags: 3, // LIST | GET
      ...overrides,
    },
  };
}

test.describe("storage: S3 bucket sharing via spaces", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let sql: SqlHelpers;
  let sharingAvailable = false;
  let minioReady = false;
  let backendId: string | null = null;

  // Ids of rows this suite inserts directly via SQL — removed in afterAll.
  const syntheticRowIds: string[] = [];

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
    sql = createSqlHelpers(vault);

    // Probe feature availability: accessFlags=0 is guaranteed to fail with
    // InvalidArgs when the command exists, and with "command ... not found"
    // when the vault build predates the sharing feature.
    try {
      await vault.invokeTauriCommand(
        "share_storage_backend",
        shareArgs({ accessFlags: 0 }),
      );
      // A success here would mean the validation contract regressed — the
      // dedicated test below will catch it; treat the feature as present.
      sharingAvailable = true;
    } catch (e) {
      sharingAvailable = String(e).includes("InvalidArgs");
    }
    if (!sharingAvailable) {
      console.log(
        "[bucket-sharing] share_storage_backend not available in this vault build — skipping suite",
      );
      return;
    }

    // MinIO-backed owned backend for the tests that need a real row.
    try {
      const added = await vault.invokeTauriCommand<AddBackendResponse>(
        "remote_storage_add_backend",
        { request: MINIO_BACKEND },
      );
      backendId = added.id;
      minioReady = true;
    } catch (e) {
      console.log(`[bucket-sharing] MinIO unreachable, backend tests skip: ${e}`);
      minioReady = false;
    }
  });

  test.afterAll(async () => {
    // Synthetic child rows first (silent delete — no sync traffic), then the
    // real backend via the production command, then any IAM-admin cred rows
    // the AWS-hint test persisted.
    for (const id of syntheticRowIds) {
      try {
        await sql.hardDelete(S3_BACKENDS_TABLE, "id = ?", [id]);
      } catch {
        // best effort
      }
    }
    if (backendId) {
      try {
        await vault.invokeTauriCommand("remote_storage_remove_backend", {
          backendId,
        });
      } catch {
        // best effort
      }
      await cleanupIamAdminCred(backendId);
    }
  });

  async function cleanupIamAdminCred(storageId: string): Promise<void> {
    try {
      const title = `iam-admin:${storageId}`;
      const rows = await sql.rawSelect(
        `SELECT id FROM ${PASSWORD_DETAILS_TABLE} WHERE title = ?`,
        [title],
      );
      for (const row of rows) {
        const itemId = row[0] as string;
        await sql.rawExecute(
          `DELETE FROM ${PASSWORD_KEY_VALUES_TABLE} WHERE item_id = ?`,
          [itemId],
        );
      }
      await sql.rawExecute(
        `DELETE FROM ${PASSWORD_DETAILS_TABLE} WHERE title = ?`,
        [title],
      );
    } catch {
      // best effort
    }
  }

  async function iamAdminCredCount(storageId: string): Promise<number> {
    const rows = await sql.rawSelect(
      `SELECT COUNT(*) FROM ${PASSWORD_DETAILS_TABLE} WHERE title = ?`,
      [`iam-admin:${storageId}`],
    );
    return (rows[0]?.[0] as number) ?? 0;
  }

  /** Insert a synthetic `shared_from_space` row the way the share command's
   *  `persist_shared_backend` would, pointing at `parentId`. */
  async function insertSyntheticShareRow(parentId: string): Promise<string> {
    const id = `e2e-share-child-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const config = JSON.stringify({
      endpoint: "http://minio:9000",
      region: "us-east-1",
      bucket: MINIO_BUCKET,
      pathStyle: true,
      accessKeyId: "SCOPEDKEYFAKE",
      secretAccessKey: "scoped-secret-fake",
      iamUserName: "haex-share-e2efake0000",
    });
    await sql.rawWithCrdt(
      `INSERT INTO ${S3_BACKENDS_TABLE} \
       (id, type, name, config, enabled, parent_backend_id, origin_type, \
        share_prefix, share_access_flags) \
       VALUES (?, 's3', ?, ?, 1, ?, 'shared_from_space', NULL, 3)`,
      [id, `${id}-name`, config, parentId],
    );
    syntheticRowIds.push(id);
    return id;
  }

  // ---------------------------------------------------------------------
  // Argument-validation contract (no backend row required — validation
  // runs before any DB or provider access)
  // ---------------------------------------------------------------------

  test("share with accessFlags=0 is rejected with InvalidArgs", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");

    await expect(
      vault.invokeTauriCommand("share_storage_backend", shareArgs({ accessFlags: 0 })),
    ).rejects.toThrow(/InvalidArgs/);
  });

  test("share with IAM wildcard characters in prefix is rejected", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");

    // `*` and `?` are wildcards in IAM Resource ARNs and StringLike
    // conditions — a folder literally named `logs*` must not widen the
    // policy scope, so the backend rejects rather than escapes.
    for (const prefix of ["logs*", "foo?bar", "media/*"]) {
      await expect(
        vault.invokeTauriCommand("share_storage_backend", shareArgs({ prefix })),
      ).rejects.toThrow(/InvalidArgs/);
    }
  });

  test("share with objectKey is rejected as ObjectScopeNotYetSupported (v1)", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");

    await expect(
      vault.invokeTauriCommand(
        "share_storage_backend",
        shareArgs({ objectKey: "media/track.mp3" }),
      ),
    ).rejects.toThrow(/ObjectScopeNotYetSupported/);
  });

  test("share of an unknown backend id fails with StorageNotFound", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");

    await expect(
      vault.invokeTauriCommand("share_storage_backend", shareArgs({})),
    ).rejects.toThrow(/StorageNotFound/);
  });

  // ---------------------------------------------------------------------
  // IAM-admin-credential flow (requires the MinIO-backed owned backend)
  // ---------------------------------------------------------------------

  test("share without a stored IAM-admin cred surfaces IamAdminCredMissing", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");
    test.skip(!minioReady, "MinIO is not available in this environment");

    // This is the error variant the share drawer's recovery modal keys on —
    // the frontend prompts for admin credentials and retries with a hint.
    await expect(
      vault.invokeTauriCommand(
        "share_storage_backend",
        shareArgs({ storageId: backendId }),
      ),
    ).rejects.toThrow(/IamAdminCredMissing/);
  });

  test("MinIO cred hint is rejected as UnsupportedProvider without persisting the cred", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");
    test.skip(!minioReady, "MinIO is not available in this environment");

    // v1 limitation: MinIO's admin API is not AWS-IAM-compatible, so the
    // share flow refuses the provider *before* writing the hint to the
    // password manager — a retry with a supported provider must not find
    // a stale MinIO pairing.
    await expect(
      vault.invokeTauriCommand(
        "share_storage_backend",
        shareArgs({
          storageId: backendId,
          iamAdminCredHint: {
            accessKeyId: "minioadmin",
            secretAccessKey: "minioadmin",
            providerType: "minio",
          },
        }),
      ),
    ).rejects.toThrow(/UnsupportedProvider/);

    expect(await iamAdminCredCount(backendId!)).toBe(0);
  });

  test("failed provisioning with an AWS hint stores the cred but no share row", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");
    test.skip(!minioReady, "MinIO is not available in this environment");

    // A syntactically-valid AWS hint passes provider validation and is
    // persisted, but the capability probe against the real AWS IAM endpoint
    // fails (bogus credentials → IamAdminInsufficient; no network →
    // IamOperationFailed). Either way the invariant under test is the same:
    // provisioning never got far enough to write a shared-backend row.
    await expect(
      vault.invokeTauriCommand(
        "share_storage_backend",
        shareArgs({
          storageId: backendId,
          iamAdminCredHint: {
            accessKeyId: "AKIAE2EBOGUSBOGUS00",
            secretAccessKey: "e2e-bogus-secret-that-cannot-sign",
            providerType: "aws",
          },
        }),
      ),
    ).rejects.toThrow(/IamAdminInsufficient|IamOperationFailed/);

    // Cred was stored (enables retry without re-typing)…
    expect(await iamAdminCredCount(backendId!)).toBe(1);

    // …but no share row was persisted.
    const childCount = await sql.count(
      S3_BACKENDS_TABLE,
      "parent_backend_id = ?",
      [backendId!],
    );
    expect(childCount).toBe(0);

    // Remove the bogus cred so later suites see a clean slate.
    await cleanupIamAdminCred(backendId!);
  });

  // ---------------------------------------------------------------------
  // Revoke contract
  // ---------------------------------------------------------------------

  test("revoke of an unknown id fails with StorageNotFound", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");

    await expect(
      vault.invokeTauriCommand("revoke_storage_share", {
        sharedBackendId: "e2e-revoke-nonexistent",
      }),
    ).rejects.toThrow(/StorageNotFound/);
  });

  test("revoke of an owned (non-share) row fails with NotAShareRow", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");
    test.skip(!minioReady, "MinIO is not available in this environment");

    await expect(
      vault.invokeTauriCommand("revoke_storage_share", {
        sharedBackendId: backendId,
      }),
    ).rejects.toThrow(/NotAShareRow/);
  });

  test("revoke keeps DB rows intact when the IAM step cannot run (IAM-first ordering)", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");
    test.skip(!minioReady, "MinIO is not available in this environment");

    // Revoke deliberately tears down the provider-side IAM user BEFORE
    // deleting DB rows: if IAM teardown can't run, the rows must survive so
    // the user can retry — deleting them first would orphan a live
    // credential with no vault record of how to revoke it.
    const childId = await insertSyntheticShareRow(backendId!);

    await expect(
      vault.invokeTauriCommand("revoke_storage_share", {
        sharedBackendId: childId,
      }),
    ).rejects.toThrow(/IamAdminCredMissing/);

    const survivors = await sql.count(S3_BACKENDS_TABLE, "id = ?", [childId]);
    expect(survivors).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Cascade FK (manual_0002 table-rebuild migration)
  // ---------------------------------------------------------------------

  test("deleting an owned parent cascades to its shared child rows", async () => {
    test.skip(!sharingAvailable, "sharing feature not in this vault build");
    test.skip(!minioReady, "MinIO is not available in this environment");

    // Dedicated parent so the shared MinIO backend stays available for the
    // suites that run after this one.
    const parent = await vault.invokeTauriCommand<AddBackendResponse>(
      "remote_storage_add_backend",
      {
        request: {
          ...MINIO_BACKEND,
          name: `e2e-share-cascade-parent-${Date.now()}`,
        },
      },
    );
    const childId = await insertSyntheticShareRow(parent.id);

    await vault.invokeTauriCommand("remote_storage_remove_backend", {
      backendId: parent.id,
    });

    // manual_0002 rebuilt haex_s3_backends so parent_backend_id carries an
    // enforced ON DELETE CASCADE — the child row must be gone without any
    // application-level cleanup.
    const orphanCount = await sql.count(S3_BACKENDS_TABLE, "id = ?", [childId]);
    expect(orphanCount).toBe(0);
  });
});
