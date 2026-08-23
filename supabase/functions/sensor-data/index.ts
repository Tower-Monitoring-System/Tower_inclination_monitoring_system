import { createClient } from "npm:@supabase/supabase-js@2";

type SensorRow = {
  Date: string;
  Time: string;
  X: number;
  Y: number;
  Z: number;
  Battery: number;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const MAXIMUM_ROWS = 20000;
const UPSTREAM_TIMEOUT_MS = 10000;
const ALLOWED_ROLES = new Set(["owner", "operator"]);

function getCorsOrigin(request: Request) {
  const requestOrigin = request.headers.get("origin") || "";
  const configuredOrigins = (Deno.env.get("SENSOR_DATA_ALLOWED_ORIGINS") || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configuredOrigins.length === 0) {
    return requestOrigin || "*";
  }
  return configuredOrigins.includes(requestOrigin) ? requestOrigin : "";
}

function responseHeaders(corsOrigin: string) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin"
  });
  if (corsOrigin) {
    headers.set("Access-Control-Allow-Origin", corsOrigin);
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  return headers;
}

function jsonResponse(body: Record<string, unknown>, status: number, corsOrigin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(corsOrigin)
  });
}

function normalizeDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(DATE_PATTERN);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeTime(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(TIME_PATTERN);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }
  return `${match[1]}:${match[2]}:${String(seconds).padStart(2, "0")}`;
}

function normalizeNumber(value: unknown, minimum: number, maximum: number) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizeRow(value: unknown): SensorRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const date = normalizeDate(row.Date);
  const time = normalizeTime(row.Time);
  const x = normalizeNumber(row.X, -180, 180);
  const y = normalizeNumber(row.Y, -180, 180);
  const z = normalizeNumber(row.Z, -180, 180);
  const battery = normalizeNumber(row.Battery, 0, 24);

  if (date === null || time === null || x === null || y === null || z === null || battery === null) {
    return null;
  }
  return { Date: date, Time: time, X: x, Y: y, Z: z, Battery: battery };
}

Deno.serve(async (request) => {
  const corsOrigin = getCorsOrigin(request);
  if (!corsOrigin) {
    return jsonResponse({ ok: false, error: "Origin is not allowed." }, 403, "");
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(corsOrigin) });
  }
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405, corsOrigin);
  }

  const authorization = request.headers.get("authorization") || "";
  const jwt = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) {
    return jsonResponse({ ok: false, error: "Authentication required." }, 401, corsOrigin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const appsScriptUrl = Deno.env.get("GOOGLE_APPS_SCRIPT_URL");
  const sharedSecret = Deno.env.get("GOOGLE_APPS_SCRIPT_SHARED_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !appsScriptUrl || !sharedSecret) {
    return jsonResponse({ ok: false, error: "Sensor data service is not configured." }, 503, corsOrigin);
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(appsScriptUrl)) {
    return jsonResponse({ ok: false, error: "Sensor data service is not configured." }, 503, corsOrigin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);
  if (userError || !userData.user) {
    return jsonResponse({ ok: false, error: "Authentication required." }, 401, corsOrigin);
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError || !profile || !ALLOWED_ROLES.has(profile.role)) {
    return jsonResponse({ ok: false, error: "Access denied." }, 403, corsOrigin);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstreamResponse = await fetch(appsScriptUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ token: sharedSecret }),
      redirect: "follow",
      signal: controller.signal
    });
    if (!upstreamResponse.ok) {
      return jsonResponse({ ok: false, error: "Sensor data source is unavailable." }, 502, corsOrigin);
    }

    const responseText = await upstreamResponse.text();
    if (responseText.length > 5_000_000) {
      return jsonResponse({ ok: false, error: "Sensor data response is too large." }, 502, corsOrigin);
    }

    let upstreamPayload: unknown;
    try {
      upstreamPayload = JSON.parse(responseText);
    } catch {
      return jsonResponse({ ok: false, error: "Sensor data source returned an invalid response." }, 502, corsOrigin);
    }

    const payload = upstreamPayload as { ok?: unknown; data?: unknown };
    if (!payload || payload.ok !== true || !Array.isArray(payload.data)) {
      return jsonResponse({ ok: false, error: "Sensor data source returned an invalid response." }, 502, corsOrigin);
    }
    if (payload.data.length > MAXIMUM_ROWS) {
      return jsonResponse({ ok: false, error: "Sensor data response is too large." }, 502, corsOrigin);
    }

    const data = payload.data.map(normalizeRow).filter((row): row is SensorRow => row !== null);
    if (payload.data.length > 0 && data.length === 0) {
      return jsonResponse({ ok: false, error: "Sensor data source contains no valid rows." }, 502, corsOrigin);
    }

    return jsonResponse(
      {
        ok: true,
        data,
        meta: {
          received: payload.data.length,
          accepted: data.length,
          rejected: payload.data.length - data.length,
          generatedAt: new Date().toISOString()
        }
      },
      200,
      corsOrigin
    );
  } catch (error) {
    console.error(
      "sensor-data upstream request failed",
      error instanceof Error ? error.name : "UnknownError"
    );
    return jsonResponse({ ok: false, error: "Sensor data source is unavailable." }, 502, corsOrigin);
  } finally {
    clearTimeout(timeoutId);
  }
});
