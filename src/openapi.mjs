import config from "./config.mjs";

export function openApiDocument() {
  const url = config.publicUrl;
  return {
    openapi: "3.0.3",
    info: {
      title: "Horizon Mods API",
      version: "1",
      description: "Unofficial Horizon mod registry. Schema 1 index, accounts, review before publish, and rate limits.",
    },
    servers: [{ url }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", bearerFormat: "hmk_live_" },
        cookie: { type: "apiKey", in: "cookie", name: "hm_session" },
      },
    },
    paths: {
      "/api/v1/index.json": { get: { summary: "Public schema 1 index", responses: { 200: { description: "index" } } } },
      "/api/v1/updates": {
        get: { summary: "Which mods are newer", parameters: installedParams(), responses: { 200: { description: "updates" } } },
        post: { summary: "Same check with a JSON body", responses: { 200: { description: "updates" } } },
      },
      "/api/v1/projects/{id}/update": {
        get: { summary: "Update for one mod", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "current", in: "query", schema: { type: "string" } }, { name: "game", in: "query", schema: { type: "string" } }, { name: "channel", in: "query", schema: { type: "string", enum: ["release", "beta"] } }], responses: { 200: { description: "update" } } },
      },
      "/api/v1/limits": { get: { summary: "Numeric limits", responses: { 200: { description: "limits" } } } },
      "/api/v1/auth/register": { post: { summary: "Register with a name and password and set the session cookie", responses: { 201: { description: "account created" } } } },
      "/api/v1/auth/login": { post: { summary: "Log in with a name and password and set the session cookie", responses: { 200: { description: "user" } } } },
      "/api/v1/auth/logout": { post: { summary: "Log out", responses: { 204: { description: "empty" } } } },
      "/api/v1/me": {
        get: { summary: "Current account and profile", security: [{ bearer: [] }, { cookie: [] }], responses: { 200: { description: "user" } } },
        patch: { summary: "Display name, text, color, and profile links", security: [{ bearer: [] }, { cookie: [] }], responses: { 200: { description: "user" } } },
      },
      "/api/v1/users/{username}": {
        get: { summary: "Public profile, stats, and published mods", responses: { 200: { description: "user, stats, projects" }, 404: { description: "no profile" } } },
      },
      "/api/v1/users/{username}/follow": {
        post: { summary: "Follow or unfollow this profile", security: [{ bearer: [] }, { cookie: [] }], responses: { 200: { description: "following flag and stats" }, 400: { description: "cannot follow yourself" } } },
      },
      "/api/v1/keys": {
        get: { summary: "Own keys", security: [{ bearer: [] }, { cookie: [] }], responses: { 200: { description: "keys" } } },
        post: { summary: "New key, secret returned once", security: [{ bearer: [] }, { cookie: [] }], responses: { 201: { description: "secret" } } },
      },
      "/api/v1/keys/{id}": { delete: { summary: "Revoke a key", security: [{ bearer: [] }, { cookie: [] }], responses: { 204: { description: "revoked" } } } },
      "/api/v1/mods": {
        get: { summary: "Published pages", responses: { 200: { description: "projects" } } },
        post: { summary: "Create a page", security: [{ bearer: [] }, { cookie: [] }], responses: { 201: { description: "id" } } },
      },
      "/api/v1/mods/{id}": {
        get: { summary: "Page and visible versions", responses: { 200: { description: "project" } } },
        patch: { summary: "Edit your page", security: [{ bearer: [] }, { cookie: [] }], responses: { 200: { description: "id" } } },
      },
      "/api/v1/mods/{id}/versions": {
        post: { summary: "Upload an archive", security: [{ bearer: [] }, { cookie: [] }], responses: { 201: { description: "accepted" }, 422: { description: "checks failed" } } },
      },
      "/api/v1/feed": { get: { summary: "Recent published versions, with screenshot and short video paths", responses: { 200: { description: "versions" } } } },
      "/api/v1/mods/{id}/media": {
        post: { summary: "Upload one screenshot or one short video", security: [{ bearer: [] }, { cookie: [] }], responses: { 201: { description: "stored" }, 400: { description: "not a picture or short video" } } },
      },
      "/api/v1/mods/{id}/media/{mediaId}": {
        delete: { summary: "Remove a screenshot or short video", security: [{ bearer: [] }, { cookie: [] }], responses: { 204: { description: "removed" } } },
      },
      "/mods/{id}/media/{mediaId}": { get: { summary: "Screenshot or short video of a visible mod", responses: { 200: { description: "bytes" }, 404: { description: "hidden or missing" } } } },
      "/api/v1/versions/{id}/review": { post: { summary: "approve or reject", security: [{ bearer: [] }, { cookie: [] }], responses: { 200: { description: "decision" } } } },
      "/api/v1/revocations": { post: { summary: "Revoke a project or sha256", security: [{ bearer: [] }, { cookie: [] }], responses: { 200: { description: "revoked" } } } },
      "/download/{project}/{version}/{file}": { get: { summary: "File of a published version", responses: { 200: { description: "bytes" }, 304: { description: "not modified" }, 410: { description: "revoked" } } } },
    },
  };
}

function installedParams() {
  return [
    { name: "installed", in: "query", schema: { type: "string" }, description: "id@version,id@version" },
    { name: "game", in: "query", schema: { type: "string" } },
    { name: "channel", in: "query", schema: { type: "string", enum: ["release", "beta"] } },
  ];
}
