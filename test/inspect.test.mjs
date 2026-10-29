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

const HORIZON = "6f8c7a0e5d531d3834c4d0be4659a1db8e7e5c2a";
const MIXINS = "0d6b103c70633d8fd9443d8d0acd3aadaacedb06";
const nativeExpected = { kind: "native-mod", id: "zoom", name: "Zoom", version: "2.0.0", game: "26.3" };

function nativePack(patch = {}) {
  const meta = {
    schema: 1,
    id: "zoom",
    version: "2.0.0",
    game: "26.3",
    horizon: HORIZON,
    mixins: MIXINS,
    hooks: 1,
    ...patch.meta,
  };
  const toml = `[mod]
id = "${patch.tomlId || "zoom"}"
version = "${patch.tomlVersion || "2.0.0"}"

[compatibility]
horizon_revision = "${patch.revision || HORIZON}"
`;
  return pack({
    "horizon-native.json": JSON.stringify(meta),
    "mixins/zoom/horizon-mixin.toml": toml,
    "mixins/zoom/zoom.rs": patch.rs ?? "pub fn zoom() {}\n",
    ...patch.files,
  });
}

test("нативный hnmod проходит без запуска кода", () => {
  const report = inspectArchive(nativePack(), nativeExpected);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.native.horizon, HORIZON);
  assert.equal(report.native.mixins, MIXINS);
  assert.equal(report.native.hooks, 1);
  assert.ok(report.warnings.some((item) => item.code === "native"));
  assert.equal(report.external, null);
});

test("лишний файл и бинарный rs в hnmod отклоняются", () => {
  const extra = inspectArchive(nativePack({ files: { "notes.txt": "no" } }), nativeExpected);
  assert.equal(extra.ok, false);
  assert.ok(extra.errors.some((item) => item.code === "fence"));
  const binary = inspectArchive(nativePack({ rs: "fn main() {}\0" }), nativeExpected);
  assert.equal(binary.ok, false);
  assert.ok(binary.errors.some((item) => item.message.includes("не похож на исходник")));
});

test("чужой id и exe внутри hnmod отклоняются", () => {
  const mismatch = inspectArchive(nativePack({ meta: { id: "other" } }), nativeExpected);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.some((item) => item.message.includes("horizon-native.json")));
  const exe = inspectArchive(nativePack({ files: { "mixins/zoom/run.exe": "MZ" } }), nativeExpected);
  assert.equal(exe.ok, false);
  assert.ok(exe.errors.some((item) => item.code === "denied" || item.code === "fence"));
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
