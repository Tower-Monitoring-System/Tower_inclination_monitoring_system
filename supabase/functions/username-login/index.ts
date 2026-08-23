import { withSupabase } from "npm:@supabase/server@^1";

type LoginPayload = {
  username?: unknown;
  password?: unknown;
};

const MIN_RESPONSE_MS = 450;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function respondAfterMinimumDelay(
  startedAt: number,
  body: Record<string, unknown>,
  status: number
) {
  const remaining = MIN_RESPONSE_MS - (Date.now() - startedAt);
  if (remaining > 0) {
    await sleep(remaining);
  }
  return Response.json(body, { status });
}

function unauthorized(startedAt: number) {
  return respondAfterMinimumDelay(
    startedAt,
    { error: "Invalid username or password." },
    401
  );
}

export default {
  fetch: withSupabase({ auth: "publishable" }, async (req, ctx) => {
    const startedAt = Date.now();

    if (req.method !== "POST") {
      return respondAfterMinimumDelay(startedAt, { error: "Method not allowed." }, 405);
    }

    let payload: LoginPayload;
    try {
      payload = await req.json();
    } catch {
      return unauthorized(startedAt);
    }

    const username =
      typeof payload.username === "string" ? payload.username.trim().toLowerCase() : "";
    const password = typeof payload.password === "string" ? payload.password : "";

    if (!USERNAME_PATTERN.test(username) || password.length < 1 || password.length > 256) {
      return unauthorized(startedAt);
    }

    const { data: profile, error: profileError } = await ctx.supabaseAdmin
      .from("profiles")
      .select("id, username, role")
      .eq("username", username)
      .maybeSingle();

    if (profileError || !profile || profile.role !== "owner") {
      return unauthorized(startedAt);
    }

    const { data: adminUser, error: adminUserError } =
      await ctx.supabaseAdmin.auth.admin.getUserById(profile.id);

    const email = adminUser?.user?.email;
    if (adminUserError || !email) {
      return unauthorized(startedAt);
    }

    const { data: signInData, error: signInError } =
      await ctx.supabase.auth.signInWithPassword({ email, password });

    const session = signInData?.session;
    const signedInUser = signInData?.user;

    if (
      signInError ||
      !session?.access_token ||
      !session.refresh_token ||
      !signedInUser ||
      signedInUser.id !== profile.id
    ) {
      return unauthorized(startedAt);
    }

    return respondAfterMinimumDelay(
      startedAt,
      {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
        token_type: session.token_type
      },
      200
    );
  })
};
