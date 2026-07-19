import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trash2, LogOut, Search, Loader2, ArrowUp, ArrowDown, ArrowUpDown, ExternalLink, X, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  getAuthUrl,
  getProfile,
  searchMessages,
  trashMessages,
  listAllMessageIds,
  type GmailMessage,
} from "@/lib/gmail.functions";

const filterSchema = z.object({
  from: fallback(z.string(), "").default(""),
  fromNot: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
  subject: fallback(z.string(), "").default(""),
  subjectNot: fallback(z.string(), "").default(""),
  keyword: fallback(z.string(), "").default(""),
  unreadOnly: fallback(z.boolean(), false).default(false),
  hasAttachment: fallback(z.enum(["any", "yes", "no"]), "any").default("any"),
  category: fallback(
    z.enum(["", "promotions", "social", "updates", "forums", "primary"]),
    "",
  ).default(""),
  label: fallback(z.string(), "").default(""),
  olderThanDays: fallback(z.string(), "").default(""),
  newerThanDays: fallback(z.string(), "").default(""),
  largerThanMb: fallback(z.string(), "").default(""),
  smallerThanMb: fallback(z.string(), "").default(""),
  hasListUnsubscribe: fallback(z.boolean(), false).default(false),
  raw: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/")({
  validateSearch: zodValidator(filterSchema),
  head: () => ({
    meta: [
      { title: "Gmail Sweep — bulk-trash old emails" },
      {
        name: "description",
        content:
          "Open-source self-hosted tool to filter and bulk-trash Gmail messages by sender, age, size, read status and more.",
      },
      { property: "og:title", content: "Gmail Sweep" },
      {
        property: "og:description",
        content: "Filter and bulk-trash Gmail messages. Self-hosted, open source.",
      },
    ],
  }),
  component: Index,
  ssr: false,
});

type Tokens = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
};

type Filters = z.infer<typeof filterSchema>;

const emptyFilters: Filters = {
  from: "",
  fromNot: "",
  to: "",
  subject: "",
  subjectNot: "",
  keyword: "",
  unreadOnly: false,
  hasAttachment: "any",
  category: "",
  label: "",
  olderThanDays: "",
  newerThanDays: "",
  largerThanMb: "",
  smallerThanMb: "",
  hasListUnsubscribe: false,
  raw: "",
};

function buildQuery(f: Filters): string {
  const parts: string[] = [];
  if (f.from.trim()) parts.push(`from:${f.from.trim()}`);
  if (f.fromNot.trim()) parts.push(`-from:${f.fromNot.trim()}`);
  if (f.to.trim()) parts.push(`to:${f.to.trim()}`);
  if (f.subject.trim()) parts.push(`subject:(${f.subject.trim()})`);
  if (f.subjectNot.trim()) parts.push(`-subject:(${f.subjectNot.trim()})`);
  if (f.keyword.trim()) parts.push(`(${f.keyword.trim()})`);
  if (f.unreadOnly) parts.push("is:unread");
  if (f.hasAttachment === "yes") parts.push("has:attachment");
  if (f.hasAttachment === "no") parts.push("-has:attachment");
  if (f.category) parts.push(`category:${f.category}`);
  if (f.label.trim()) parts.push(`label:${f.label.trim()}`);
  if (f.olderThanDays.trim()) parts.push(`older_than:${f.olderThanDays.trim()}d`);
  if (f.newerThanDays.trim()) parts.push(`newer_than:${f.newerThanDays.trim()}d`);
  // Gmail's size operators only reliably parse integer sizes ("larger:5M");
  // express fractional megabytes as exact bytes ("larger:5872026").
  const mbQuery = (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Number.isInteger(n) ? `${n}M` : String(Math.round(n * 1024 * 1024));
  };
  const larger = mbQuery(f.largerThanMb.trim());
  const smaller = mbQuery(f.smallerThanMb.trim());
  if (f.largerThanMb.trim() && larger) parts.push(`larger:${larger}`);
  if (f.smallerThanMb.trim() && smaller) parts.push(`smaller:${smaller}`);
  if (f.hasListUnsubscribe) parts.push("list:*");
  if (f.raw.trim()) parts.push(f.raw.trim());
  // Exclude already-trashed by default
  parts.push("-in:trash");
  return parts.join(" ");
}

function loadTokens(): Tokens | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("gmail_tokens");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Tokens;
  } catch {
    return null;
  }
}

function saveTokens(t: Tokens) {
  localStorage.setItem("gmail_tokens", JSON.stringify(t));
}

// Gmail's snippet field is HTML-escaped ("week&#39;s"); decode the common
// named entities plus numeric character references for display.
function decodeEntities(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function Index() {
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const filters = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const setFilters = (next: Filters) => {
    navigate({ search: next, replace: true });
  };
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [knownTotal, setKnownTotal] = useState<number | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  // Fresh search in flight (as opposed to infinite-scroll pagination):
  // dims stale results and drives the results-panel spinner.
  const [searching, setSearching] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<"date" | "size" | "from">("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sortedMessages = useMemo(() => {
    const arr = [...messages];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "date") {
        cmp = (Date.parse(a.date || "") || 0) - (Date.parse(b.date || "") || 0);
      } else if (sortKey === "size") {
        cmp = (a.sizeEstimate ?? 0) - (b.sizeEstimate ?? 0);
      } else {
        cmp = (a.from ?? "").toLowerCase().localeCompare((b.from ?? "").toLowerCase());
      }
      return cmp * dir;
    });
    return arr;
  }, [messages, sortKey, sortDir]);

  function toggleSort(key: "date" | "size" | "from") {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "from" ? "asc" : "desc");
    }
  }

  const fnAuthUrl = useServerFn(getAuthUrl);
  const fnProfile = useServerFn(getProfile);
  const fnSearch = useServerFn(searchMessages);
  const fnTrash = useServerFn(trashMessages);
  const fnListIds = useServerFn(listAllMessageIds);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);

  useEffect(() => {
    const t = loadTokens();
    if (t) setTokens(t);
  }, []);

  useEffect(() => {
    if (!tokens) return;
    fnProfile({ data: { tokens } })
      .then((r) => {
        setEmail(r.profile.emailAddress);
        if (r.tokens.access_token !== tokens.access_token) {
          saveTokens(r.tokens);
          setTokens(r.tokens);
        }
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens?.access_token]);

  const query = useMemo(() => buildQuery(filters), [filters]);

  // Per-group count of active filters, shown as a badge on each group
  // header so active filters stay visible when a group is collapsed.
  const activeCounts = useMemo(() => {
    const has = (s: string) => s.trim() !== "";
    return {
      sender: [filters.from, filters.fromNot, filters.to].filter(has).length,
      metadata:
        (filters.unreadOnly ? 1 : 0) +
        (filters.hasListUnsubscribe ? 1 : 0) +
        (filters.category ? 1 : 0) +
        (has(filters.label) ? 1 : 0) +
        (filters.hasAttachment !== "any" ? 1 : 0),
      content: [filters.subject, filters.subjectNot, filters.keyword].filter(has).length,
      dateSize: [
        filters.olderThanDays,
        filters.newerThanDays,
        filters.largerThanMb,
        filters.smallerThanMb,
      ].filter(has).length,
      advanced: has(filters.raw) ? 1 : 0,
    };
  }, [filters]);

  async function handleConnect() {
    const { url } = await fnAuthUrl({ data: { origin: window.location.origin } });
    // Google blocks OAuth inside iframes (X-Frame-Options: DENY). When we're
    // embedded in an iframe, open in a new tab; otherwise navigate the
    // current window.
    const embedded = window.top !== window.self;
    if (embedded) {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      window.location.href = url;
    }
  }

  function handleDisconnect() {
    localStorage.removeItem("gmail_tokens");
    setTokens(null);
    setEmail(null);
    setMessages([]);
    setSelected(new Set());
  }

  async function runSearch(pageToken?: string) {
    if (!tokens) return;
    setLoading(true);
    setError(null);
    // Fresh search (not pagination): drop any selection carried over from
    // previous results, so "Trash N" can never act on messages from an
    // earlier query that the user is no longer looking at.
    if (!pageToken) {
      setSelected(new Set());
      setKnownTotal(null);
      setHasSearched(true);
      setSearching(true);
    }
    try {
      const r = await fnSearch({
        data: { tokens, query, pageToken, maxResults: 100 },
      });
      if (r.tokens.access_token !== tokens.access_token) {
        saveTokens(r.tokens);
        setTokens(r.tokens);
      }
      // Compute the next list outside the state updater: React may defer the
      // updater callback, so a count captured inside it can still be stale
      // when read below. Concurrent searches are prevented by `loading`.
      let next: GmailMessage[];
      if (!pageToken) {
        next = r.messages;
      } else {
        const seen = new Set(messages.map((m) => m.id));
        next = [...messages, ...r.messages.filter((m) => !seen.has(m.id))];
      }
      setMessages(next);
      setNextPageToken(r.nextPageToken);
      // Gmail's resultSizeEstimate is wildly unreliable — ignore it.
      // Only set a known total once every page has been loaded.
      if (!r.nextPageToken) {
        setKnownTotal(next.length);
      } else if (!pageToken) {
        setKnownTotal(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      if (!pageToken) setSearching(false);
    }
  }

  // Infinite scroll: auto-load next page when sentinel enters viewport.
  useEffect(() => {
    if (!sentinelRef.current || !nextPageToken || loading) return;
    const el = sentinelRef.current;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) runSearch(nextPageToken);
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextPageToken, loading, messages.length]);

  async function handleSelectAllMatching() {
    if (!tokens) return;
    setSelectingAll(true);
    setError(null);
    try {
      const r = await fnListIds({ data: { tokens, query } });
      if (r.tokens.access_token !== tokens.access_token) {
        saveTokens(r.tokens);
        setTokens(r.tokens);
      }
      setSelected(new Set(r.ids));
      if (!r.truncated) {
        setKnownTotal(r.ids.length);
      }
      if (r.truncated) {
        setError(`Selection capped at ${r.ids.length} messages. Refine filters for more.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSelectingAll(false);
    }
  }

  async function handleTrashSelected() {
    if (!tokens || selected.size === 0) return;
    if (
      !confirm(
        `Move ${selected.size} message${selected.size === 1 ? "" : "s"} to Gmail Trash? (Auto-purged after 30 days, or empty Trash manually.)`,
      )
    )
      return;
    setTrashing(true);
    setError(null);
    try {
      const ids = Array.from(selected);
      let currentTokens = tokens;
      // Chunk in batches of 1000 to give progress feedback for large trashes
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        const r = await fnTrash({ data: { tokens: currentTokens, ids: chunk } });
        currentTokens = r.tokens;
      }
      if (currentTokens.access_token !== tokens.access_token) {
        saveTokens(currentTokens);
        setTokens(currentTokens);
      }
      const trashedSet = new Set(ids);
      setMessages((prev) => prev.filter((m) => !trashedSet.has(m.id)));
      setSelected(new Set());
      toast.success(
        `Moved ${ids.length} message${ids.length === 1 ? "" : "s"} to Trash`,
      );
    } catch (e) {
      setError((e as Error).message);
      toast.error((e as Error).message);
    } finally {
      setTrashing(false);
    }
  }

  function toggleAll() {
    const allLoadedSelected = messages.every((m) => selected.has(m.id));
    if (allLoadedSelected) {
      // Deselect everything (including off-screen "select all matching" picks)
      setSelected(new Set());
    } else {
      // Add all loaded ids to whatever is already selected
      setSelected((prev) => {
        const next = new Set(prev);
        for (const m of messages) next.add(m.id);
        return next;
      });
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!tokens) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="text-2xl">Gmail Sweep</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Bulk-trash old, unread, or marketing Gmail messages with an easy filter builder —
              no search-operator syntax to memorize. One click selects every match (up to
              50,000) and trashes them in seconds. Tokens stay in your browser; the backend
              only proxies Gmail API calls.
            </p>
            <Button onClick={handleConnect} className="w-full">
              Connect Gmail account
            </Button>
            <p className="text-xs text-muted-foreground">
              Requires <code>gmail.modify</code> scope. Messages go to Trash (recoverable for 30
              days) — never permanently deleted.{" "}
              <a
                href="https://github.com/superadmiral/gmail-sweep"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Open source on GitHub
              </a>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background min-[600px]:h-screen min-[600px]:flex min-[600px]:flex-col min-[600px]:overflow-hidden">
      <header className="border-b min-[600px]:shrink-0">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Gmail Sweep</h1>
            <p className="text-xs text-muted-foreground">{email ?? "loading…"}</p>
          </div>
          <Button variant="secondary" onClick={handleDisconnect}>
            <LogOut className="h-4 w-4 mr-1" /> Disconnect
          </Button>
        </div>
      </header>

      <main className="max-w-6xl w-full mx-auto px-6 py-6 grid gap-6 min-[600px]:grid-cols-[280px_1fr] lg:grid-cols-[340px_1fr] min-[600px]:flex-1 min-[600px]:min-h-0 min-[600px]:grid-rows-[minmax(0,1fr)]">
        <Card className="flex flex-col min-[600px]:h-full min-[600px]:min-h-0 min-[600px]:overflow-hidden">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runSearch();
            }}
            className="flex flex-col min-h-0 flex-1"
          >
          <CardContent className="panel-scroll pt-4 space-y-2 overflow-y-auto flex-1 min-h-0">
            <FilterGroup label="Sender & recipient" activeCount={activeCounts.sender}>
            <Field label="From contains / not">
              <div className="flex gap-1">
                <Input
                  placeholder="e.g. marketing"
                  value={filters.from}
                  onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                  className="flex-[2] min-w-0"
                />
                <Input
                  placeholder="not…"
                  value={filters.fromNot}
                  onChange={(e) => setFilters({ ...filters, fromNot: e.target.value })}
                  className="flex-1 min-w-0"
                />
              </div>
            </Field>
            <Field label="To">
              <Input
                placeholder="me@example.com"
                value={filters.to}
                onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              />
            </Field>
            </FilterGroup>
            <FilterGroup label="Gmail metadata" defaultOpen activeCount={activeCounts.metadata}>
            <div className="flex items-center gap-2">
              <Checkbox
                id="unread"
                checked={filters.unreadOnly}
                onCheckedChange={(v) => setFilters({ ...filters, unreadOnly: !!v })}
              />
              <Label
                htmlFor="unread"
                className="text-sm"
                title="Only messages you never opened (is:unread)"
              >
                Unread only
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="lu"
                checked={filters.hasListUnsubscribe}
                onCheckedChange={(v) => setFilters({ ...filters, hasListUnsubscribe: !!v })}
              />
              <Label
                htmlFor="lu"
                className="text-sm"
                title="Newsletters and bulk mail — messages with a List-Unsubscribe header"
              >
                Mailing list
              </Label>
            </div>
            <Field label="Category">
              <NativeSelect
                value={filters.category}
                onChange={(e) =>
                  setFilters({ ...filters, category: e.target.value as Filters["category"] })
                }
              >
                <option value="">Any</option>
                <option value="primary">Primary</option>
                <option value="promotions">Promotions</option>
                <option value="social">Social</option>
                <option value="updates">Updates</option>
                <option value="forums">Forums</option>
              </NativeSelect>
            </Field>
            <Field label="Label">
              <Input
                placeholder="Newsletters"
                value={filters.label}
                onChange={(e) => setFilters({ ...filters, label: e.target.value })}
              />
            </Field>
            <Field label="Attachments">
              <NativeSelect
                value={filters.hasAttachment}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    hasAttachment: e.target.value as Filters["hasAttachment"],
                  })
                }
              >
                <option value="any">Any</option>
                <option value="yes">Has attachment</option>
                <option value="no">No attachment</option>
              </NativeSelect>
            </Field>
            </FilterGroup>
            <FilterGroup label="Content" activeCount={activeCounts.content}>
            <Field label="Subject contains / not">
              <div className="flex gap-1">
                <Input
                  value={filters.subject}
                  onChange={(e) => setFilters({ ...filters, subject: e.target.value })}
                  className="flex-[2] min-w-0"
                />
                <Input
                  placeholder="not…"
                  value={filters.subjectNot}
                  onChange={(e) => setFilters({ ...filters, subjectNot: e.target.value })}
                  className="flex-1 min-w-0"
                />
              </div>
            </Field>
            <Field label="Body / keyword">
              <Input
                value={filters.keyword}
                onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
              />
            </Field>
            </FilterGroup>
            <FilterGroup label="Date & size" activeCount={activeCounts.dateSize}>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Older than (days)">
                <Input
                  type="number"
                  min={0}
                  placeholder="365"
                  value={filters.olderThanDays}
                  onChange={(e) => setFilters({ ...filters, olderThanDays: e.target.value })}
                />
              </Field>
              <Field label="Newer than (days)">
                <Input
                  type="number"
                  min={0}
                  value={filters.newerThanDays}
                  onChange={(e) => setFilters({ ...filters, newerThanDays: e.target.value })}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Larger than (MB)">
                <Input
                  type="number"
                  min={0}
                  step="any"
                  placeholder="5"
                  value={filters.largerThanMb}
                  onChange={(e) => setFilters({ ...filters, largerThanMb: e.target.value })}
                />
              </Field>
              <Field label="Smaller than (MB)">
                <Input
                  type="number"
                  min={0}
                  step="any"
                  value={filters.smallerThanMb}
                  onChange={(e) => setFilters({ ...filters, smallerThanMb: e.target.value })}
                />
              </Field>
            </div>
            </FilterGroup>
            <FilterGroup label="Advanced" activeCount={activeCounts.advanced}>
            <Field label="Raw Gmail query">
              <Input
                placeholder="e.g. before:2025/01/01"
                value={filters.raw}
                onChange={(e) => setFilters({ ...filters, raw: e.target.value })}
              />
            </Field>
            </FilterGroup>
          </CardContent>
          <div className="flex-shrink-0 sticky bottom-0 rounded-b-xl border-t bg-card/95 backdrop-blur p-3 space-y-2">
            <div className="text-xs text-muted-foreground break-words max-h-16 overflow-y-auto">
              <span className="font-mono">{query}</span>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={loading} className="flex-1">
                {loading ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Search className="h-4 w-4 mr-1" />
                )}
                Search
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setFilters(emptyFilters);
                  setMessages([]);
                  setSelected(new Set());
                  setNextPageToken(null);
                  setKnownTotal(null);
                  setError(null);
                }}
              >
                Reset
              </Button>
            </div>
          </div>
          </form>
        </Card>

        <Card className="min-w-0 flex flex-col min-[600px]:h-full min-[600px]:min-h-0 min-[600px]:overflow-hidden">
          <CardHeader className="shrink-0">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-base">
                Results{" "}
                {messages.length > 0 && (
                  <span className="text-sm font-normal text-muted-foreground">
                    ({messages.length} loaded
                    {knownTotal !== null && knownTotal !== messages.length && `, ${knownTotal} total`})
                  </span>
                )}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col min-[600px]:flex-1 min-[600px]:min-h-0">
            {error && (
              <div className="mb-3 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded p-2">
                {error}
              </div>
            )}
            {messages.length === 0 && searching && (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching Gmail…
              </div>
            )}
            {messages.length === 0 && !loading && !error && (
              <p className="text-sm text-muted-foreground py-8 text-center">
                {hasSearched
                  ? "No messages match these filters. Loosen or change them and search again."
                  : "Configure filters and hit Search."}
              </p>
            )}
            {messages.length > 0 && (
              <>
                <div className="flex items-center gap-2 mb-2 text-sm min-w-0">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleSelectAllMatching}
                    disabled={selectingAll}
                    className="min-w-0 px-2"
                    title="Select every message matching the current filters"
                  >
                    {selectingAll ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin shrink-0" />
                    ) : null}
                    <span className="truncate">
                      Select all{knownTotal !== null ? ` (${knownTotal})` : ""}
                    </span>
                  </Button>
                  {selected.size > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelected(new Set())}
                      className="shrink-0 px-2"
                      title="Clear selection"
                      aria-label="Clear selection"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleTrashSelected}
                    disabled={trashing || selected.size === 0}
                    className="ml-auto shrink-0"
                  >
                    {trashing ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4 mr-1" />
                    )}
                    Trash{selected.size > 0 ? ` ${selected.size}` : ""}
                  </Button>
                </div>
                <div
                  className={`panel-scroll border rounded-md overflow-auto min-[600px]:flex-1 min-[600px]:min-h-0 transition-opacity ${
                    searching ? "opacity-50 pointer-events-none" : ""
                  }`}
                >
                  <table className="w-full min-w-[960px] table-fixed text-sm border-collapse">
                    <thead className="bg-background sticky top-0 z-10 shadow-[0_1px_0_hsl(var(--border))]">
                        <tr className="text-xs font-medium text-left">
                          <th className="px-3 py-2 w-8">
                            <Checkbox
                              checked={
                                messages.length > 0 &&
                                messages.every((m) => selected.has(m.id))
                              }
                              onCheckedChange={toggleAll}
                            />
                          </th>
                          <th className="px-2 py-2 w-[92px]">
                            <SortHeader label="Date" active={sortKey === "date"} dir={sortDir} onClick={() => toggleSort("date")} />
                          </th>
                          <th className="px-2 py-2 w-[70px] text-right">
                            <SortHeader label="Size" active={sortKey === "size"} dir={sortDir} onClick={() => toggleSort("size")} align="right" />
                          </th>
                          <th className="px-2 py-2 w-[200px]">
                            <SortHeader label="From" active={sortKey === "from"} dir={sortDir} onClick={() => toggleSort("from")} />
                          </th>
                          <th className="px-2 py-2">Subject</th>
                          <th className="px-2 py-2 w-10"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {sortedMessages.map((m) => (
                          <tr
                            key={m.id}
                            className="hover:bg-muted/30 cursor-pointer"
                            onClick={() => toggleOne(m.id)}
                          >
                            <td className="px-3 py-2 align-top">
                              <Checkbox
                                checked={selected.has(m.id)}
                                onCheckedChange={() => toggleOne(m.id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                            </td>
                            <td className="px-2 py-2 text-xs text-muted-foreground align-top whitespace-nowrap">
                              {m.date ? new Date(m.date).toLocaleDateString() : ""}
                            </td>
                            <td className="px-2 py-2 text-right text-xs text-muted-foreground align-top whitespace-nowrap">
                              {formatBytes(m.sizeEstimate)}
                            </td>
                            <td
                              className="px-2 py-2 max-w-[180px] truncate align-top"
                              title={m.from}
                            >
                              {m.from || "(no sender)"}
                            </td>
                            <td
                              className="px-2 py-2 align-top min-w-0"
                              title={[m.subject, decodeEntities(m.snippet)]
                                .filter(Boolean)
                                .join("\n\n")}
                            >
                              <div className="truncate">
                                {m.unread && (
                                  <Badge variant="secondary" className="mr-2 text-[10px]">
                                    unread
                                  </Badge>
                                )}
                                {m.subject || (
                                  <span className="italic text-muted-foreground">
                                    (no subject)
                                  </span>
                                )}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {decodeEntities(m.snippet)}
                              </div>
                            </td>
                            <td className="px-2 py-2 align-top text-right">
                              <a
                                href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(email ?? "")}#all/${m.threadId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                title="Open in Gmail"
                                className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {nextPageToken && (
                      <div
                        ref={sentinelRef}
                        className="py-4 text-center text-xs text-muted-foreground"
                      >
                        {loading ? (
                          <span className="inline-flex items-center gap-2">
                            <Loader2 className="h-3 w-3 animate-spin" /> Loading more…
                          </span>
                        ) : (
                          "Scroll to load more"
                        )}
                      </div>
                    )}
                    {!nextPageToken && messages.length > 0 && (
                      <div className="py-3 text-center text-xs text-muted-foreground">
                        End of results.
                      </div>
                    )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </main>

      <footer className="max-w-6xl w-full mx-auto px-6 py-3 text-xs text-muted-foreground min-[600px]:shrink-0">
        <a
          href="https://github.com/superadmiral/gmail-sweep"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Open source on GitHub
        </a>
        . Tokens stored in your browser localStorage. Messages move to Trash (recoverable for
        30 days) — empty Trash in Gmail to reclaim storage immediately.
      </footer>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function NativeSelect(props: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        {...props}
        className="w-full appearance-none rounded-md border border-input bg-background h-9 pl-3 pr-8 text-base md:text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
    </div>
  );
}

function FilterGroup({
  label,
  defaultOpen = false,
  activeCount = 0,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  activeCount?: number;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group pt-1.5 pb-2 -mx-2 px-2 rounded-md transition-colors hover:bg-muted/40"
    >
      <summary className="cursor-pointer list-none flex items-center justify-between text-sm font-medium select-none py-1">
        <span className="flex items-center gap-2">
          {label}
          {activeCount > 0 && (
            <span
              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium leading-none text-muted-foreground"
              title={`${activeCount} active filter${activeCount === 1 ? "" : "s"} in this group`}
            >
              {activeCount}
            </span>
          )}
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90 group-hover:text-foreground" />
      </summary>
      <div className="space-y-3 pt-2">{children}</div>
    </details>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "right";
}) {
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 hover:text-foreground ${
        active ? "text-foreground" : "text-muted-foreground"
      } ${align === "right" ? "w-full justify-end" : ""}`}
    >
      <span>{label}</span>
      <Icon className="h-3 w-3" />
    </button>
  );
}
