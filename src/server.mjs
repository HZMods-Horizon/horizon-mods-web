import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { resolveActor, seedAdmin } from "./auth.mjs";
import config from "./config.mjs";
import { closeDb, migrate, openDb, query } from "./db.mjs";
import { HttpError } from "./errors.mjs";
import { sweepOrphans } from "./files.mjs";
import { renderError, sendHtml } from "./html.mjs";
import { clientIp } from "./http.mjs";
import { applyLimitHeaders, cleanupLimits, consume, isHealth, isStatic, routeBuckets } from "./rate.mjs";
import { registerApi } from "./routes-api.mjs";
import { registerWeb } from "./routes-web.mjs";

function tightest(results) {
  return results.reduce((best, item) => (!best || item.remaining < best.remaining ? item : best));
}

function isPublicCors(req) {
  const urlPath = req.url.split("?")[0];
  const open = urlPath === "/api/v1/index.json"
    || urlPath === "/api/v1/updates"
    || /^\/api\/v1\/projects\/[^/]+\/update$/.test(urlPath)
    || urlPath.startsWith("/download/");
  if (!open) return false;
  return req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
}

function wantsHtml(req) {
  const urlPath = req.url.split("?")[0];
  return String(req.headers.accept || "").includes("text/html")
    && !urlPath.startsWith("/api/")
    && !urlPath.startsWith("/download/");
}

export async function buildApp() {
  await openDb();
  await migrate();
  await seedAdmin();
  await sweepOrphans();

  const app = Fastify({
    trustProxy: config.trustProxy ? "loopback, linklocal, uniquelocal" : false,
    requestTimeout: 120_000,
    bodyLimit: 256 * 1024,
    genReqId: () => randomUUID(),
    logger: {
      level: config.isTest ? "warn" : "info",
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 8,
      fields: 40,
      fieldSize: 32 * 1024,
    },
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        "img-src": ["'self'", "data:"],
        "font-src": ["'self'"],
        "script-src": ["'self'", "https://challenges.cloudflare.com"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "frame-src": ["https://challenges.cloudflare.com"],
        "connect-src": ["'self'", "https://challenges.cloudflare.com"],
        "object-src": ["'none'"],
        "upgrade-insecure-requests": null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  await app.register(fastifyStatic, {
    root: path.join(config.root, "public"),
    prefix: "/",
    decorateReply: false,
    index: false,
    wildcard: false,
    setHeaders(reply, filePath) {
      if (/\.(css|js|svg)$/.test(filePath)) reply.header("cache-control", "public, max-age=3600");
    },
  });
  const fonts = [
    ["/vendor/geist/", "@fontsource/geist"],
    ["/vendor/geist-mono/", "@fontsource/geist-mono"],
    ["/vendor/pixelify-sans/", "@fontsource/pixelify-sans"],
  ];
  for (const [prefix, folder] of fonts) {
    await app.register(fastifyStatic, {
      root: path.join(config.root, "node_modules", folder, "files"),
      prefix,
      decorateReply: false,
      index: false,
      setHeaders(reply) {
        reply.header("cache-control", "public, max-age=604800");
      },
    });
  }

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    if (req.url.split("?")[0].startsWith("/api/")) reply.header("x-horizon-mods-api", "1");
    if (!isPublicCors(req)) return;
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET, HEAD, OPTIONS");
    reply.header("access-control-allow-headers", "Content-Type, If-None-Match");
    reply.header("access-control-expose-headers", "ETag, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After");
  });

  app.addHook("onRequest", async (req, reply) => {
    if (isStatic(req.url) || isHealth(req.url)) return;
    const ipResult = await consume({ name: "ip", id: clientIp(req), limit: config.rate.ipPerMin, windowSec: 60 });
    await resolveActor(req, reply);
    const results = [ipResult];
    for (const bucket of routeBuckets(req)) results.push(await consume(bucket));
    const result = tightest(results);
    applyLimitHeaders(reply, result);
    if (results.some((item) => !item.ok)) {
      reply.header("retry-after", String(result.retryAfter));
      throw new HttpError(429, "rate_limited", "Слишком много запросов. Подождите и повторите.");
    }
    if (req.method === "OPTIONS" && isPublicCors(req)) return reply.code(204).send();
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await query("SELECT 1 AS ok");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await registerApi(app);
  await registerWeb(app);

  app.setNotFoundHandler((req, reply) => {
    if (!wantsHtml(req)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Нет такого адреса", requestId: req.id } });
    }
    return sendHtml(reply, renderError(req, 404, "Нет такой страницы"), { status: 404 });
  });

  app.setErrorHandler((err, req, reply) => {
    let status = err.status || err.statusCode || 500;
    let code = err instanceof HttpError ? err.code : "error";
    let message = err.message || "Ошибка";
    if (status === 413 || err.code === "FST_REQ_FILE_TOO_LARGE") {
      status = 413;
      code = "too_large";
      message = "Запрос больше лимита";
    } else if (err.code === "FST_ERR_CTP_INVALID_JSON") {
      status = 400;
      code = "invalid";
      message = "JSON не разбирается";
    } else if (!(err instanceof HttpError)) {
      status = status >= 400 && status < 500 ? status : 500;
      code = status === 500 ? "internal" : code;
      message = status === 500 ? "Внутренняя ошибка" : message;
    }
    if (status >= 500) req.log.error({ err });
    if (!wantsHtml(req)) {
      return reply.code(status).send({
        error: { code, message, details: err.details, requestId: req.id },
      });
    }
    return sendHtml(reply, renderError(req, status, message), { status, robots: true });
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const app = await buildApp();
  const timer = setInterval(() => {
    sweepOrphans().catch((err) => app.log.error({ err }, "sweep"));
    cleanupLimits().catch((err) => app.log.error({ err }, "limits"));
  }, 15 * 60 * 1000);
  timer.unref();
  if (config.turnstileTest) {
    app.log.warn("Turnstile is on Cloudflare test keys. Replace TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY before a public domain.");
  }
  await app.listen({ host: config.host, port: config.port });
  const stop = async () => {
    clearInterval(timer);
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => { stop().catch(() => process.exit(1)); });
  process.on("SIGTERM", () => { stop().catch(() => process.exit(1)); });
}
