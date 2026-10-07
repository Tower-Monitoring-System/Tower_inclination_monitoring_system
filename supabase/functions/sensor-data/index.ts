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
const LOCAL_DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const INVALID_SHEET_NAME_PATTERN = /[:\\/?*\[\]]/;
const MAXIMUM_ROWS = 20000;
const UPSTREAM_TIMEOUT_MS = 25000;
const CACHE_TTL_MS = 3000;
const CACHE_MAX_ENTRIES = 4;
const CACHE_MAX_BYTES = 8_000_000;
const MAXIMUM_IN_FLIGHT_KEYS = 16;
const ALLOWED_ROLES = new Set(["owner", "operator"]);
type SensorDataResult = { body: string; status: number };
type CachedResult = { result: SensorDataResult; expiresAt: number; bytes: number };
// Isolate-local only. Authorization is checked afresh before either map is used.
const successfulReads = new Map<string, CachedResult>();
const inFlightReads = new Map<string, Promise<SensorDataResult>>();
let cachedBytes = 0;

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

function sensorDataResult(body: Record<string, unknown>, status: number): SensorDataResult {
  return { body: JSON.stringify(body), status };
}

function removeCachedRead(key: string) {
  const cached = successfulReads.get(key);
  if (cached) {
    cachedBytes -= cached.bytes;
    successfulReads.delete(key);
  }
}

async function readSensorData(cacheKey: string, appsScriptUrl: string, sharedSecret: string, towerId: string) {
  const now = Date.now();
  for (const [key, cached] of successfulReads) {
    if (cached.expiresAt <= now) {
      removeCachedRead(key);
    }
  }
  const cached = successfulReads.get(cacheKey);
  if (cached) {
    return cached.result;
  }
  const pending = inFlightReads.get(cacheKey);
  if (pending) {
    return pending;
  }

  const read = fetchSensorData(appsScriptUrl, sharedSecret, towerId).then((result) => {
    // Count UTF-16 storage conservatively; failed and oversized responses are never retained.
    const bytes = result.body.length * 2;
    if (result.status === 200 && bytes <= CACHE_MAX_BYTES) {
      removeCachedRead(cacheKey);
      while (successfulReads.size >= CACHE_MAX_ENTRIES || cachedBytes + bytes > CACHE_MAX_BYTES) {
        const oldestKey = successfulReads.keys().next().value;
        if (oldestKey === undefined) break;
        removeCachedRead(oldestKey);
      }
      successfulReads.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS, bytes });
      cachedBytes += bytes;
    }
    return result;
  });
  // Bound bookkeeping when many different tower requests arrive together. The
  // overflow request still works, but is not retained for request coalescing.
  const tracked = inFlightReads.size < MAXIMUM_IN_FLIGHT_KEYS;
  if (tracked) {
    inFlightReads.set(cacheKey, read);
  }
  try {
    return await read;
  } finally {
    if (tracked && inFlightReads.get(cacheKey) === read) {
      inFlightReads.delete(cacheKey);
    }
  }
}

function normalizeDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  const isoMatch = text.match(DATE_PATTERN);
  const localMatch = text.match(LOCAL_DATE_PATTERN);
  const match = isoMatch || (localMatch
    ? [localMatch[0], localMatch[3], localMatch[2], localMatch[1]]
    : null);
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
  const normalizedValue = typeof value === "string" && value.includes(",") && !value.includes(".")
    ? value.replace(",", ".")
    : value;
  const parsed = typeof normalizedValue === "number" ? normalizedValue : Number(normalizedValue);
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

function validateTowerId(value: unknown) {
  if (typeof value !== "string") {
    return { valid: false as const, error: "Tower ID must be a string." };
  }
  const towerId = value.trim();
  if (!towerId) {
    return { valid: false as const, error: "Tower ID is required." };
  }
  if (
    towerId.length > 100
    || INVALID_SHEET_NAME_PATTERN.test(towerId)
    || towerId.startsWith("'")
    || towerId.endsWith("'")
  ) {
    return { valid: false as const, error: "Tower ID is not a valid Google Sheet name." };
  }
  return { valid: true as const, towerId };
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

  let requestPayload: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Request body must be an object.");
    }
    requestPayload = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: "Request body is invalid." }, 400, corsOrigin);
  }

  let towerId = "";
  if (Object.prototype.hasOwnProperty.call(requestPayload, "towerId")) {
    const validation = validateTowerId(requestPayload.towerId);
    if (!validation.valid) {
      return jsonResponse({ ok: false, error: validation.error }, 400, corsOrigin);
    }
    towerId = validation.towerId;
  }

  // Include all configuration that can change the source or authorization
  // context. Default-sheet reads and explicitly named towers stay separate.
  const cacheKey = JSON.stringify([supabaseUrl, serviceRoleKey, appsScriptUrl, sharedSecret, towerId]);
  const result = await readSensorData(cacheKey, appsScriptUrl, sharedSecret, towerId);
  return new Response(result.body, { status: result.status, headers: responseHeaders(corsOrigin) });
});

async function fetchSensorData(appsScriptUrl: string, sharedSecret: string, towerId: string): Promise<SensorDataResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstreamResponse = await fetch(appsScriptUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(towerId ? { token: sharedSecret, towerId } : { token: sharedSecret }),
      redirect: "follow",
      signal: controller.signal
    });
    if (!upstreamResponse.ok) {
      return sensorDataResult({ ok: false, error: "Sensor data source is unavailable." }, 502);
    }

    const responseText = await upstreamResponse.text();
    if (responseText.length > 5_000_000) {
      return sensorDataResult({ ok: false, error: "Sensor data response is too large." }, 502);
    }

    let upstreamPayload: unknown;
    try {
      upstreamPayload = JSON.parse(responseText);
    } catch {
      return sensorDataResult({ ok: false, error: "Sensor data source returned an invalid response." }, 502);
    }

    const payload = upstreamPayload as {
      ok?: unknown;
      data?: unknown;
      error?: unknown;
      errorCode?: unknown;
      meta?: { towerId?: unknown; truncated?: unknown };
    };
    if (!payload || payload.ok !== true) {
      const errorCode = typeof payload?.errorCode === "string" ? payload.errorCode : "UPSTREAM_ERROR";
      const upstreamMessage = typeof payload?.error === "string" && payload.error.length <= 220
        ? payload.error
        : "Sensor data source returned an invalid response.";
      const status = errorCode === "SHEET_NOT_FOUND" ? 404 : errorCode === "INVALID_TOWER_ID" ? 400 : 502;
      return sensorDataResult({ ok: false, error: upstreamMessage, errorCode }, status);
    }
    if (!Array.isArray(payload.data)) {
      return sensorDataResult({ ok: false, error: "Sensor data source returned an invalid response." }, 502);
    }
    if (payload.data.length > MAXIMUM_ROWS) {
      return sensorDataResult({ ok: false, error: "Sensor data response is too large." }, 502);
    }

    const data = payload.data.map(normalizeRow).filter((row): row is SensorRow => row !== null);
    if (payload.data.length > 0 && data.length === 0) {
      return sensorDataResult({ ok: false, error: "Sensor data source contains no valid rows." }, 502);
    }

    return sensorDataResult(
      {
        ok: true,
        data,
        meta: {
          received: payload.data.length,
          accepted: data.length,
          rejected: payload.data.length - data.length,
          generatedAt: new Date().toISOString(),
          truncated: payload.meta?.truncated === true,
          towerId: typeof payload.meta?.towerId === "string" ? payload.meta.towerId : towerId || null
        }
      },
      200
    );
  } catch (error) {
    console.error(
      "sensor-data upstream request failed",
      error instanceof Error ? error.name : "UnknownError"
    );
    return controller.signal.aborted
      ? sensorDataResult({ ok: false, error: "Sensor data source timed out.", errorCode: "UPSTREAM_TIMEOUT" }, 504)
      : sensorDataResult({ ok: false, error: "Sensor data source is unavailable." }, 502);
  } finally {
    clearTimeout(timeoutId);
  }
}
