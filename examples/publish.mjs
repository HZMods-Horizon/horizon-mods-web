import { readFile } from "node:fs/promises";

const base = (process.env.PUBLIC_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
const key = process.env.HORIZON_MODS_KEY;
const project = process.argv[2];
const version = process.argv[3];
const filePath = process.argv[4];
if (!key || !project || !version || !filePath) {
  console.error("Need HORIZON_MODS_KEY, an id, a version, and a path to the archive.");
  process.exit(1);
}
const bytes = await readFile(filePath);
const form = new FormData();
form.set("version", version);
form.set("channel", process.env.CHANNEL || "release");
form.set("changelog", process.env.CHANGELOG || "");
form.set("file", new Blob([bytes]), filePath.split("/").pop());
const response = await fetch(`${base}/api/v1/mods/${encodeURIComponent(project)}/versions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${key}`,
    "idempotency-key": `publish-${project}-${version}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
  },
  body: form,
});
const text = await response.text();
console.log(text);
if (!response.ok) process.exit(1);
