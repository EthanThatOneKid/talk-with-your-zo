import type { Context } from "hono";

const ZO_ASK_URL = "https://api.zo.computer/zo/ask";
const MAX_INPUT_LENGTH = 4000;

function corsHeaders(origin: string | undefined) {
  const allowedOrigin = origin || "https://etok.zo.space";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept",
    "Vary": "Origin",
  };
}

function json(c: Context, body: unknown, status = 200) {
  return c.json(body, status, corsHeaders(c.req.header("origin")));
}

export default async function talkWithZo(c: Context) {
  const origin = c.req.header("origin");

  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (c.req.method === "GET") {
    return json(c, {
      ok: true,
      route: "/api/talk-with-zo",
      accepts: "POST { input, stream?, conversationId? }",
    });
  }

  if (c.req.method !== "POST") {
    return json(c, { error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.ZO_API_KEY;
  if (!apiKey) {
    return json(c, {
      error: "Zo API key is not configured",
      detail: "Add ZO_API_KEY in Zo Settings > Advanced > Secrets.",
    }, 503);
  }

  let payload: {
    input?: unknown;
    stream?: unknown;
    conversationId?: unknown;
    personaId?: unknown;
    modelName?: unknown;
  };

  try {
    payload = await c.req.json();
  } catch {
    return json(c, { error: "Request body must be JSON" }, 400);
  }

  const input = typeof payload.input === "string" ? payload.input.trim() : "";
  if (!input) {
    return json(c, { error: "Input is required" }, 400);
  }

  if (input.length > MAX_INPUT_LENGTH) {
    return json(c, {
      error: "Input is too long",
      maxLength: MAX_INPUT_LENGTH,
    }, 413);
  }

  const zoBody: Record<string, unknown> = {
    input,
    stream: payload.stream !== false,
  };

  if (typeof payload.conversationId === "string" && payload.conversationId.trim()) {
    zoBody.conversation_id = payload.conversationId.trim();
  }

  if (typeof payload.personaId === "string" && payload.personaId.trim()) {
    zoBody.persona_id = payload.personaId.trim();
  }

  if (typeof payload.modelName === "string" && payload.modelName.trim()) {
    zoBody.model_name = payload.modelName.trim();
  }

  const upstream = await fetch(ZO_ASK_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": zoBody.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(zoBody),
  });

  const headers = new Headers(corsHeaders(origin));
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", upstream.headers.get("content-type") || "application/json");

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
