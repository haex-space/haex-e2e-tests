import { test, expect, VaultAutomation } from "../fixtures";

/**
 * E2E coverage for the `haex-stream://` custom protocol against an S3
 * backend.
 *
 * Skipped automatically when no MinIO is reachable from the test container.
 *
 * Flow:
 *   1. Add an S3 backend pointed at MinIO.
 *   2. Upload a deterministic 1 KiB blob via `remote_storage_upload`.
 *   3. Issue `fetch()` calls inside the WebView against
 *      `haex-stream://localhost/s3/<backendId>/<key>` with various
 *      `Range:` headers and assert that:
 *        - status / Content-Range / Content-Length match the spec
 *        - the returned bytes equal the expected slice of the source blob.
 *
 * The fetch hits the same `register_asynchronous_uri_scheme_protocol`
 * handler the file browser will use for video preview, so passing here
 * implies end-to-end Range correctness for S3.
 */

interface AddBackendResponse {
  id: string;
}

// 1 KiB of repeating bytes — byte at offset `i` equals `i & 0xff`. Lets us
// verify range slices by reconstructing the expected window analytically.
const SOURCE_SIZE = 1024;
function buildSourceBytes(): Uint8Array {
  const buf = new Uint8Array(SOURCE_SIZE);
  for (let i = 0; i < SOURCE_SIZE; i++) buf[i] = i & 0xff;
  return buf;
}
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, "binary").toString("base64");
}

const MINIO_BUCKET = "e2e-test-bucket";
const STREAM_OBJECT_KEY = `streaming/sample-${Date.now()}.bin`;

const MINIO_CONFIG = {
  name: `e2e-streaming-backend-${Date.now()}`,
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

interface FetchResult {
  status: number;
  contentRange: string | null;
  contentLength: string | null;
  contentType: string | null;
  acceptRanges: string | null;
  bodyHex: string;
  bodyLen: number;
}

/**
 * Issue a `fetch()` from inside the WebView against the streaming URL and
 * report back the headers + body as a hex string (so we can do byte-level
 * comparisons without dealing with binary transport quirks over WebDriver).
 */
async function fetchStream(
  vault: VaultAutomation,
  url: string,
  rangeHeader: string | null,
): Promise<FetchResult> {
  const script = `
    const url = ${JSON.stringify(url)};
    const range = ${JSON.stringify(rangeHeader)};
    const init = range == null ? {} : { headers: { Range: range } };
    const res = await fetch(url, init);
    const buf = new Uint8Array(await res.arrayBuffer());
    let hex = "";
    for (let i = 0; i < buf.length; i++) {
      hex += buf[i].toString(16).padStart(2, "0");
    }
    return {
      status: res.status,
      contentRange: res.headers.get("content-range"),
      contentLength: res.headers.get("content-length"),
      contentType: res.headers.get("content-type"),
      acceptRanges: res.headers.get("accept-ranges"),
      bodyHex: hex,
      bodyLen: buf.length,
    };
  `;
  return vault.executeScript<FetchResult>(script);
}

function hexOf(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

test.describe("storage: haex-stream:// S3 streaming protocol", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let backendId: string | null = null;
  let minioReady = false;
  const sourceBytes = buildSourceBytes();
  const sourceHex = hexOf(sourceBytes);
  const streamUrl = () =>
    `haex-stream://localhost/s3/${backendId}/${STREAM_OBJECT_KEY}`;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Add backend — succeeds only if MinIO is reachable (test_connection
    // is run server-side as part of `remote_storage_add_backend`). Any
    // failure here flips the suite into skip mode.
    try {
      const added = await vault.invokeTauriCommand<AddBackendResponse>(
        "remote_storage_add_backend",
        { request: MINIO_CONFIG },
      );
      backendId = added.id;

      // Upload the deterministic source blob.
      await vault.invokeTauriCommand("remote_storage_upload", {
        request: {
          backendId,
          key: STREAM_OBJECT_KEY,
          data: toBase64(sourceBytes),
        },
      });

      minioReady = true;
    } catch (e) {
      console.log(`[streaming-s3] skipping suite (MinIO unreachable): ${e}`);
      minioReady = false;
    }
  });

  test.afterAll(async () => {
    if (backendId) {
      try {
        await vault.invokeTauriCommand("remote_storage_delete", {
          request: { backendId, key: STREAM_OBJECT_KEY },
        });
      } catch {
        // best effort
      }
      try {
        await vault.invokeTauriCommand("remote_storage_remove_backend", {
          backendId,
        });
      } catch {
        // best effort
      }
    }
    // Match the cleanup pattern used by remote-s3-backend.spec.ts so the
    // shared per-process Tauri session is released for the next suite.
    try {
      await vault.invokeTauriCommand("close_database", {});
    } catch {
      // best effort
    }
  });

  test("full file fetch (no Range) returns 200 and the complete body", async () => {
    test.skip(!minioReady, "MinIO not available");
    const result = await fetchStream(vault, streamUrl(), null);

    expect(result.status).toBe(200);
    expect(result.acceptRanges).toBe("bytes");
    expect(result.bodyLen).toBe(SOURCE_SIZE);
    expect(result.contentLength).toBe(String(SOURCE_SIZE));
    expect(result.bodyHex).toBe(sourceHex);
    // No Content-Range on a non-partial response.
    expect(result.contentRange).toBeNull();
  });

  test("closed range bytes=0-99 returns 206 with first 100 bytes", async () => {
    test.skip(!minioReady, "MinIO not available");
    const result = await fetchStream(vault, streamUrl(), "bytes=0-99");

    expect(result.status).toBe(206);
    expect(result.acceptRanges).toBe("bytes");
    expect(result.contentRange).toBe(`bytes 0-99/${SOURCE_SIZE}`);
    expect(result.contentLength).toBe("100");
    expect(result.bodyLen).toBe(100);
    expect(result.bodyHex).toBe(hexOf(sourceBytes.slice(0, 100)));
  });

  test("middle range bytes=500-599 returns 206 with correct slice", async () => {
    test.skip(!minioReady, "MinIO not available");
    const result = await fetchStream(vault, streamUrl(), "bytes=500-599");

    expect(result.status).toBe(206);
    expect(result.contentRange).toBe(`bytes 500-599/${SOURCE_SIZE}`);
    expect(result.contentLength).toBe("100");
    expect(result.bodyLen).toBe(100);
    expect(result.bodyHex).toBe(hexOf(sourceBytes.slice(500, 600)));
  });

  test("open-ended range bytes=900- returns 206 with tail of file", async () => {
    test.skip(!minioReady, "MinIO not available");
    const result = await fetchStream(vault, streamUrl(), "bytes=900-");

    expect(result.status).toBe(206);
    expect(result.contentRange).toBe(
      `bytes 900-${SOURCE_SIZE - 1}/${SOURCE_SIZE}`,
    );
    expect(result.contentLength).toBe(String(SOURCE_SIZE - 900));
    expect(result.bodyLen).toBe(SOURCE_SIZE - 900);
    expect(result.bodyHex).toBe(hexOf(sourceBytes.slice(900)));
  });

  test("single-byte range bytes=0-0 returns 206 with one byte", async () => {
    test.skip(!minioReady, "MinIO not available");
    const result = await fetchStream(vault, streamUrl(), "bytes=0-0");

    expect(result.status).toBe(206);
    expect(result.contentRange).toBe(`bytes 0-0/${SOURCE_SIZE}`);
    expect(result.contentLength).toBe("1");
    expect(result.bodyLen).toBe(1);
    expect(result.bodyHex).toBe("00");
  });

  test("range past end of file returns 416", async () => {
    test.skip(!minioReady, "MinIO not available");
    const result = await fetchStream(vault, streamUrl(), "bytes=0-9999");

    expect(result.status).toBe(416);
    // RFC 7233: server SHOULD include a Content-Range header on 416
    // responses, of the form `bytes */<total>`. We do that in the handler.
    expect(result.contentRange).toBe(`bytes */${SOURCE_SIZE}`);
  });

  test("missing object returns 404", async () => {
    test.skip(!minioReady, "MinIO not available");
    const missingUrl = `haex-stream://localhost/s3/${backendId}/does/not/exist.bin`;
    const result = await fetchStream(vault, missingUrl, null);

    // The size() probe issues a HEAD which 404s on missing keys → NotFound.
    expect(result.status).toBe(404);
  });

  test("malformed URL (missing key) returns 400", async () => {
    test.skip(!minioReady, "MinIO not available");
    const result = await fetchStream(
      vault,
      `haex-stream://localhost/s3/${backendId}`,
      null,
    );

    expect(result.status).toBe(400);
  });

  test("unknown backend id returns 404", async () => {
    test.skip(!minioReady, "MinIO not available");
    const result = await fetchStream(
      vault,
      `haex-stream://localhost/s3/00000000-0000-0000-0000-000000000000/foo.bin`,
      null,
    );

    expect(result.status).toBe(404);
  });
});
