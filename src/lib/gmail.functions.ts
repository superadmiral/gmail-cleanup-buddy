import { createServerFn } from "@tanstack/react-start";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";

function getRedirectUri(origin: string) {
  return `${origin}/api/auth/google/callback`;
}

export const getAuthUrl = createServerFn({ method: "POST" })
  .inputValidator((d: { origin: string }) => d)
  .handler(async ({ data }) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new Error("GOOGLE_CLIENT_ID not configured");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: getRedirectUri(data.origin),
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    });
    return { url: `${AUTH_URL}?${params.toString()}` };
  });

type Tokens = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
};

async function refreshIfNeeded(tokens: Tokens): Promise<Tokens> {
  if (Date.now() < tokens.expires_at - 60_000) return tokens;
  if (!tokens.refresh_token) throw new Error("Access token expired and no refresh token available — please reconnect.");
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return {
    access_token: j.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + j.expires_in * 1000,
  };
}

async function gmailFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
  attempt = 0,
): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    // Gmail throttles per-user bursts (429, or 403 with rateLimitExceeded).
    // Back off exponentially and retry instead of failing the whole search.
    const throttled =
      res.status === 429 || (res.status === 403 && text.includes("rateLimitExceeded"));
    if (throttled && attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
      return gmailFetch(accessToken, path, init, attempt + 1);
    }
    throw new Error(`Gmail API ${res.status}: ${text}`);
  }
  // Some Gmail endpoints (e.g. batchModify) return 204 with an empty body.
  if (res.status === 204) return {};
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
}

export type GmailMessage = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  sizeEstimate: number;
  unread: boolean;
};

export const searchMessages = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { tokens: Tokens; query: string; pageToken?: string; maxResults?: number }) => d,
  )
  .handler(async ({ data }) => {
    const tokens = await refreshIfNeeded(data.tokens);
    const params = new URLSearchParams({
      q: data.query,
      maxResults: String(Math.min(data.maxResults ?? 100, 500)),
    });
    if (data.pageToken) params.set("pageToken", data.pageToken);
    const list = (await gmailFetch(
      tokens.access_token,
      `/users/me/messages?${params.toString()}`,
    )) as {
      messages?: { id: string; threadId: string }[];
      nextPageToken?: string;
    };
    const ids = list.messages ?? [];
    // Fetch metadata in parallel batches of 10 — Gmail caps concurrent
    // requests per user, and larger bursts trip 429 rateLimitExceeded.
    const messages: GmailMessage[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const results = await Promise.all(
        batch.map((m) =>
          gmailFetch(
            tokens.access_token,
            `/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          ),
        ),
      );
      for (const r of results as Array<{
        id: string;
        threadId: string;
        snippet: string;
        sizeEstimate: number;
        labelIds?: string[];
        payload?: { headers?: Array<{ name: string; value: string }> };
      }>) {
        const h = (n: string) =>
          r.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
        messages.push({
          id: r.id,
          threadId: r.threadId,
          subject: h("Subject"),
          from: h("From"),
          date: h("Date"),
          snippet: r.snippet,
          sizeEstimate: r.sizeEstimate,
          unread: (r.labelIds ?? []).includes("UNREAD"),
        });
      }
    }
    return {
      messages,
      nextPageToken: list.nextPageToken ?? null,
      tokens, // possibly refreshed
    };
  });

export const trashMessages = createServerFn({ method: "POST" })
  .inputValidator((d: { tokens: Tokens; ids: string[] }) => d)
  .handler(async ({ data }) => {
    if (data.ids.length === 0) return { trashed: 0, tokens: data.tokens };
    const tokens = await refreshIfNeeded(data.tokens);
    // batchModify supports up to 1000 ids per call
    let trashed = 0;
    for (let i = 0; i < data.ids.length; i += 1000) {
      const chunk = data.ids.slice(i, i + 1000);
      await gmailFetch(tokens.access_token, `/users/me/messages/batchModify`, {
        method: "POST",
        body: JSON.stringify({ ids: chunk, addLabelIds: ["TRASH"] }),
      });
      trashed += chunk.length;
    }
    return { trashed, tokens };
  });

export const listAllMessageIds = createServerFn({ method: "POST" })
  .inputValidator((d: { tokens: Tokens; query: string; cap?: number }) => d)
  .handler(async ({ data }) => {
    const tokens = await refreshIfNeeded(data.tokens);
    const cap = Math.min(data.cap ?? 50_000, 100_000);
    const ids: string[] = [];
    let pageToken: string | undefined = undefined;
    while (ids.length < cap) {
      const params = new URLSearchParams({ q: data.query, maxResults: "500" });
      if (pageToken) params.set("pageToken", pageToken);
      const r = (await gmailFetch(
        tokens.access_token,
        `/users/me/messages?${params.toString()}`,
      )) as { messages?: { id: string }[]; nextPageToken?: string };
      for (const m of r.messages ?? []) ids.push(m.id);
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    return { ids, tokens, truncated: ids.length >= cap };
  });

export const getProfile = createServerFn({ method: "POST" })
  .inputValidator((d: { tokens: Tokens }) => d)
  .handler(async ({ data }) => {
    const tokens = await refreshIfNeeded(data.tokens);
    const p = (await gmailFetch(tokens.access_token, `/users/me/profile`)) as {
      emailAddress: string;
      messagesTotal: number;
      threadsTotal: number;
    };
    return { profile: p, tokens };
  });