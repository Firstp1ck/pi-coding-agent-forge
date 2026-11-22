import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResult } from "../../../src/backends/response.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");

function shot(png_base64) {
  return { captureId: "c1", target: "screen", origin: { x: 0, y: 0 }, width: 10, height: 10, scale: 1, png_base64, sha256: "ab" };
}

test("screenshot base64 validation: padded and unpadded accepted, bad characters and padding rejected", () => {
  assert.equal(validateResult("screenshot", shot(PNG)).png_base64, PNG);
  assert.equal(validateResult("screenshot", shot(`${PNG}AA==`)).png_base64.endsWith("=="), true);
  assert.equal(validateResult("screenshot", shot(`${PNG}AAA=`)).png_base64.endsWith("="), true);
  for (const bad of [`${PNG}AA!A`, `${PNG}A===`, `${PNG}=AAA`, `${PNG}A-_A`, `${PNG}AAA`]) {
    assert.throws(() => validateResult("screenshot", shot(bad)), /png_base64 is not base64/, bad);
  }
});
