import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Generate small, real (decodable) media files with ffmpeg and return their
 * base64 so a spec can drop them onto the vault filesystem via
 * `filesystem_write_file`.
 *
 * ffmpeg ships in the e2e container (docker/Dockerfile.base — it's there for
 * screen recording), so generation works inside `exec vault-a pnpm test`.
 * `isFfmpegAvailable()` lets a suite skip cleanly where it isn't (e.g. a bare
 * local run), mirroring the MinIO-reachability skip in streaming-s3.spec.ts.
 *
 * Real media (not random bytes) matters: the assertion is that WebKitGTK's
 * GStreamer pipeline actually loads the stream served over the local range
 * server — that only happens for a container it can demux.
 */

export function isFfmpegAvailable(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface GeneratedMedia {
  /** base64 of a ~2s H.264/AAC MP4 (faststart: moov atom up front for seeking). */
  videoBase64: string;
  /** base64 of a ~2s MP3 sine tone. */
  audioBase64: string;
}

/**
 * Produce a tiny MP4 and MP3 with ffmpeg and return them base64-encoded.
 * Throws if ffmpeg is missing — gate with `isFfmpegAvailable()` first.
 */
export function generateMediaFixtures(): GeneratedMedia {
  const dir = mkdtempSync(join(tmpdir(), "haex-media-fixtures-"));
  try {
    const videoPath = join(dir, "clip.mp4");
    const audioPath = join(dir, "tone.mp3");

    // testsrc → a real, demuxable H.264 stream; +faststart puts the moov atom
    // at the front so the player can seek without reading the whole file.
    execSync(
      `ffmpeg -y -f lavfi -i testsrc=size=160x120:rate=15:duration=2 ` +
        `-pix_fmt yuv420p -movflags +faststart "${videoPath}"`,
      { stdio: "ignore" },
    );
    // A 440 Hz sine → a real MP3 the audio element can decode.
    execSync(
      `ffmpeg -y -f lavfi -i sine=frequency=440:duration=2 -q:a 9 "${audioPath}"`,
      { stdio: "ignore" },
    );

    return {
      videoBase64: readFileSync(videoPath).toString("base64"),
      audioBase64: readFileSync(audioPath).toString("base64"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
