import assert from "node:assert/strict";
import test from "node:test";
import { bestVersion, cmpSemver } from "../src/semver.mjs";

test("пререлиз меньше того же релиза", () => {
  assert.ok(cmpSemver("1.2.0-beta.1", "1.2.0") < 0);
  assert.ok(cmpSemver("1.2.0", "1.2.0-beta.1") > 0);
  assert.equal(cmpSemver("1.2.0", "1.2.0"), 0);
  assert.equal(bestVersion(["1.0.0", "1.2.0-beta.1", "1.2.0", "0.9.0"]), "1.2.0");
});
