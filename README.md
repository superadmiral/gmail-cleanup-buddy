# Gmail Sweep

Open-source self-hosted tool to bulk-trash Gmail messages with a friendly
filter builder for Gmail's search operators — combine unread-only, larger
than N MB, older than N days, has List-Unsubscribe, category, and raw
queries without memorizing syntax, preview matches with per-message sizes,
select every match in one click, and trash tens of thousands in seconds.
Built with TanStack Start + React + Tailwind.

- **Safe:** moves messages to Gmail Trash (recoverable for 30 days). Never
  permanent-deletes — uses only the `gmail.modify` scope.
- **Private:** OAuth tokens live in your browser's `localStorage`. The
  server only proxies Gmail API calls and the OAuth code exchange (which
  requires the client secret).
- **Truly bulk:** "Select all matching" grabs every message matching your
  filters (up to 50,000) in one click — no page-by-page checkbox rounds —
  and trashing uses Gmail's `messages.batchModify` (up to 1000 ids per
  call), so clearing thousands of emails takes seconds.

## Setup

### 1. Create Google OAuth credentials

1. Go to <https://console.cloud.google.com/> → new project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → External → fill app info → add scope
   `https://www.googleapis.com/auth/gmail.modify` → add yourself as a test
   user. (Testing mode is fine for personal use.)
4. **Credentials → Create credentials → OAuth client ID → Web
   application**.
5. Authorized redirect URIs — add one per host you'll run on:
   - `http://localhost:5173/api/auth/google/callback`
   - `https://your-deployment.example.com/api/auth/google/callback`
6. Copy the **Client ID** and **Client secret**.

### 2. Configure environment

Set these as environment variables (or via your hosting provider's secret
manager):

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

### 3. Run

```
bun install
bun run dev
```

Open <http://localhost:5173>, click **Connect Gmail**, authorize, then
filter and trash away.

## Filters supported

| UI field | Gmail query operator |
|---|---|
| From contains | `from:` |
| To | `to:` |
| Subject contains | `subject:` |
| Body / keyword | free text |
| Unread only | `is:unread` |
| Has / no attachment | `has:attachment` / `-has:attachment` |
| Category | `category:promotions` etc. |
| Label | `label:` |
| Older / newer than (days) | `older_than:Nd` / `newer_than:Nd` |
| Larger / smaller than (MB) | `larger:NM` / `smaller:NM` |
| Mailing list | `list:*` (has `List-Unsubscribe` header) |
| Raw | anything from <https://support.google.com/mail/answer/7190> |

Trashed messages are excluded automatically (`-in:trash`).

## License

MIT.