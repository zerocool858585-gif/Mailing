import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PROJECT_ROOT, resolveProjectPath, toProjectRelative } from "./project-paths.mjs";

test("resolveProjectPath resolves repository-relative paths from the current clone", () => {
  assert.equal(resolveProjectPath("senler/uploads/image.jpg"), path.join(PROJECT_ROOT, "senler", "uploads", "image.jpg"));
});

test("resolveProjectPath relocates legacy absolute repository paths", () => {
  const legacy = "C:\\Projects\\senler_salebot_mailer\\senler\\uploads\\image.jpg";
  assert.equal(resolveProjectPath(legacy), path.join(PROJECT_ROOT, "senler", "uploads", "image.jpg"));
  assert.equal(toProjectRelative(legacy), "senler/uploads/image.jpg");
});
