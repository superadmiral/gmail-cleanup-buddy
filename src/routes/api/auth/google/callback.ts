import { createFileRoute } from "@tanstack/react-router";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function errorPage(message: string) {
  return html(
    `<!doctype html><meta charset="utf-8"><title>Auth error</title>
     <body style="font-family:system-ui;padding:2rem;max-width:600px;margin:auto">
       <h1>Gmail connection failed</h1>
       <p style="color:#b91c1c">${message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!))}</p>
       <p><a href="/">Back to app</a></p>
     </body>`,
    400,
  );
}

export const Route = createFileRoute("/api/auth/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const oauthError = url.searchParams.get("error");
        if (oauthError) return errorPage(`Google returned: ${oauthError}`);
        if (!code) return errorPage("Missing authorization code.");

        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return errorPage("Server is missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.");
        }

        const redirectUri = `${url.origin}/api/auth/google/callback`;
        const res = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        });
        if (!res.ok) {
          return errorPage(`Token exchange failed: ${res.status} ${await res.text()}`);
        }
        const tok = (await res.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
        };
        const payload = {
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          expires_at: Date.now() + tok.expires_in * 1000,
        };
        // Hand off to client via small HTML page; tokens stay in browser localStorage.
        return html(
          `<!doctype html><meta charset="utf-8"><title>Connecting…</title>
           <body style="font-family:system-ui;padding:2rem">Connecting Gmail…
           <script>
             try {
               localStorage.setItem('gmail_tokens', ${JSON.stringify(JSON.stringify(payload))});
             } catch (e) {}
             location.replace('/');
           </script></body>`,
        );
      },
    },
  },
});