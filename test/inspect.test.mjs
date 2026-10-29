import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { inspectArchive } from "../src/inspect.mjs";

const expected = { kind: "mod", id: "demo_mod", name: "Demo Mod", version: "1.0.0", game: "26.3" };

function pack(files) {
  const entries = {};
  for (const [name, value] of Object.entries(files)) {
    entries[name] = typeof value === "string" ? new TextEncoder().encode(value) : value;
  }
  return Buffer.from(zipSync(entries));
}

const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function manifest(extra = "") {
  return `id = "demo_mod"
name = "Demo Mod"
version = "1.0.0"
description = "demo"
authors = ["Ada"]
api = "0.1"
side = "client"
capabilities = ["hud"]
license = "MIT"
source = "https://example.com/demo"
${extra}`;
}

test("обычный мод проходит статическую проверку", () => {
  const report = inspectArchive(pack({ "horizon-mod.toml": manifest(), "mod.wasm": wasm }), expected);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

test("чужая возможность отклоняется", () => {
  const report = inspectArchive(pack({
    "horizon-mod.toml": manifest().replace('capabilities = ["hud"]', 'capabilities = ["fly"]'),
    "mod.wasm": wasm,
  }), expected);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((item) => item.code === "manifest"));
});

test("путь с .. не принимается", () => {
  const report = inspectArchive(pack({
    "horizon-mod.toml": manifest(),
    "mod.wasm": wasm,
    "../evil.txt": "no",
  }), expected);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((item) => item.code === "bad_name" || item.code === "bad_zip"));
});

test("слишком большой заявленный размер — это zip-bomb", () => {
  const report = inspectArchive(
    pack({ "horizon-mod.toml": manifest(), "mod.wasm": wasm }),
    expected,
    { maxFiles: 8192, maxEntry: 4, maxTotal: 256 * 1024 * 1024 },
  );
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((item) => item.code === "zip_bomb"));
});
