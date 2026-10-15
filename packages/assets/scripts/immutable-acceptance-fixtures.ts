import { createHash } from "node:crypto";

import sharp from "sharp";

const width = 32;
const height = 24;
const decodedPixelLimit = width * height;

function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createPng(background: string) {
  return sharp({ create: { width, height, channels: 3, background } })
    .png({ compressionLevel: 0, adaptiveFiltering: false })
    .toBuffer();
}

async function assertDecodablePng(bytes: Uint8Array) {
  const decoded = await sharp(bytes, { limitInputPixels: decodedPixelLimit, failOn: "error" })
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    decoded.info.width !== width ||
    decoded.info.height !== height ||
    decoded.info.channels < 3 ||
    decoded.data.byteLength <= 0
  ) {
    throw new Error("FIXTURE_DECODE_MISMATCH");
  }
}

export async function createImmutableAcceptanceFixtures() {
  const [main, replay] = await Promise.all([
    createPng("#234567"),
    createPng("#abcdef"),
  ]);
  const mainChecksum = checksum(main);
  const replayChecksum = checksum(replay);
  if (main.byteLength !== replay.byteLength) throw new Error("FIXTURE_LENGTH_MISMATCH");
  if (mainChecksum === replayChecksum || main.equals(replay)) throw new Error("FIXTURE_CONTENT_COLLISION");
  await Promise.all([assertDecodablePng(main), assertDecodablePng(replay)]);
  return { main, replay, mainChecksum, replayChecksum };
}
