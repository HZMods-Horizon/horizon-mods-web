const base = (process.env.PUBLIC_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
const installed = process.argv[2] || "demo_mod@0.1.0";
const game = process.argv[3] || "26.3";
const channel = process.argv[4] || "release";
const url = new URL("/api/v1/updates", base);
url.searchParams.set("installed", installed);
url.searchParams.set("game", game);
url.searchParams.set("channel", channel);
const response = await fetch(url);
if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}
const body = await response.json();
for (const item of body.updates) {
  if (item.update) console.log(`${item.id} ${item.current} -> ${item.version} ${item.file.url}`);
  else console.log(`${item.id} ${item.current || "—"} no update`);
}
