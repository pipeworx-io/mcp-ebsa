interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * EBSA enforcement — civil-penalty actions on ERISA benefit-plan filings
 *
 * "Has this plan sponsor been penalized for a deficient/late/non-filed Form
 * 5500", "most recent EBSA enforcement actions". `form5500` already covers
 * the FILINGS themselves (what sponsors reported); this is the Employee
 * Benefits Security Administration's own ENFORCEMENT record against
 * sponsors who filed deficiently, late, or not at all — distinct from
 * `dol-whd` (Wage & Hour back-wage/overtime cases) and from `osha` (safety
 * citations), both of which already live on this same DOL API gateway.
 *
 * SOURCE: U.S. Department of Labor, Employee Benefits Security
 * Administration — Office of the Chief Accountant Case Tracking System
 * (OCATS), dataset id 10361 on the DOL Open Data Portal. Closed enforcement
 * cases with a penalty assessment since 2000, published quarterly. This is a
 * civil-PENALTY / filing-compliance enforcement record (deficient filer,
 * late filer, non-filer), not a fiduciary-breach litigation docket — EBSA
 * does not publish a bulk dataset of individual fiduciary-breach case
 * outcomes; this is the enforcement dataset that actually exists in
 * structured, bulk-queryable form. Verified live 2026-10-17: catalog
 * metadata at `/v4/datasets/10361` needs no key and returns a 10-row
 * preview with real case data (e.g. Shell USA, Inc. Health & Wellbeing
 * Plan, penalty bucket "over $100,000"); the row endpoint
 * `/v4/get/EBSA/ocats/json` is the same gateway `dol-whd` and `osha`
 * already call with `PLATFORM_DOL_KEY` — verified live that the key is
 * valid right now via a sibling call (`dol_whd whd_search`).
 *
 * LIVE PROXY — every call reaches the upstream directly, nothing is stored
 * here between calls. This is the same `apiprod.dol.gov/v4` gateway
 * dol-whd and osha already use — every auth/behavior quirk documented in
 * mcps/dol-whd/src/index.ts's header applies verbatim here (same host, same
 * grammar) and is not re-derived:
 *   1. The catalog endpoint (`/v4/datasets/10361`) takes an X-API-KEY HEADER
 *      or no key at all; the row endpoint (`/v4/get/...`) REJECTS a header
 *      and requires the key as a QUERY PARAMETER.
 *   2. A zero-match query answers HTTP 204 with an EMPTY BODY, not a 200
 *      with `{"data":[]}` — `res.json()` on that throws, so 204 is
 *      short-circuited before parsing.
 *   3. The upstream throttles by SOURCE IP (shared egress), not by key, and
 *      sends no Retry-After — back off twice, then return a
 *      `upstream_rate_limited` refusal rather than treating it as "no match".
 *   4. `filter_object` keywords (`field`, `operator`, `value`, `and`, `or`)
 *      must be lowercase; a wrong dataset name or a malformed filter both
 *      answer a generic HTTP 500.
 *
 * FIELDS (from the live dataset_preview, not guessed): case_type, ein, pn
 * (plan number), plan_year, plan_name, plan_admin, plan_admin_state,
 * plan_admin_zip_code, final_close_reason, final_close_date, penalty_amount
 * (a DOL-ASSIGNED STRING BUCKET, e.g. "over $100,000", "$50,001 - $100,000",
 * "$0-$10,000" — never an exact dollar figure, so it is passed through as a
 * string and never parsed into a number), load_dt.
 *
 * NO INDIVIDUAL PII. `plan_admin` identifies the plan administrator/sponsor
 * (almost always a business entity making a mandatory public filing, e.g.
 * "Shell USA, Inc."), not a private person; the dataset carries no
 * point-of-contact or attorney name/email/phone fields at all (unlike the
 * LCA/PERM record layouts, OCATS has no such columns to begin with).
 */


const UA = 'pipeworx-ebsa-ocats/0.1 (+https://pipeworx.io)';

// Mirrors mcps/dol-whd/src/index.ts verbatim: apiprod.dol.gov is the
// documented host, api.dol.gov answers identically.
const BASE = 'https://apiprod.dol.gov/v4/get/EBSA/ocats/json';
const CATALOG = 'https://apiprod.dol.gov/v4/datasets/10361';

type Op = 'eq' | 'neq' | 'gt' | 'lt' | 'in' | 'not_in' | 'like';
interface Cond { field: string; operator: Op; value: string | number }
interface FilterGroup { and?: Array<Cond | FilterGroup>; or?: Array<Cond | FilterGroup> }

/** A closed OCATS enforcement case. Field names are the live ones from the dataset preview. */
interface OcatsCase {
  case_type?: string;
  ein?: string;
  pn?: string;
  plan_year?: string;
  plan_name?: string;
  plan_admin?: string;
  plan_admin_state?: string;
  plan_admin_zip_code?: string;
  final_close_reason?: string;
  final_close_date?: string;
  penalty_amount?: string;
  load_dt?: string;
  [key: string]: unknown;
}

async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 'DOL EBSA Open Data API');
}

/** A refusal an agent can act on, rather than a bare throw — same shape as dol-whd's WhdRefusal. */
class EbsaRefusal extends Error {
  constructor(readonly payload: Record<string, unknown>) {
    super(String(payload.error ?? payload.reason ?? 'refused'));
    this.name = 'EbsaRefusal';
  }
}

function buildUrl(params: Record<string, string | number | undefined>, apiKey: string): string {
  const u = new URL(BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  }
  u.searchParams.set('X-API-KEY', apiKey);
  return u.toString();
}

/**
 * The key is a caller-supplied `_apiKey` today, or the gateway-injected
 * `PLATFORM_DOL_KEY` once this pack is wired with `platformKeyEnv` (the same
 * key osha and dol-whd already hold and that a live sibling call confirmed
 * still works 2026-10-17).
 */
function requireKey(args: Record<string, unknown>): string {
  const key = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  if (key) return key;
  throw new EbsaRefusal({
    found: false,
    reason: 'auth_required',
    error:
      'This tool requires an API key for the US Department of Labor Open Data Portal. Register free at https://dataportal.dol.gov and pass it as _apiKey.',
    hint: 'The dataset catalog is open but row access is not, so a 200 on the catalog does not mean the rows are reachable. ebsa_coverage answers its catalog half without a key.',
  });
}

async function ebsaFetch(params: Record<string, string | number | undefined>, apiKey: string): Promise<OcatsCase[]> {
  const url = buildUrl(params, apiKey);

  for (let attempt = 0; ; attempt++) {
    const res = await pwFetch(url);

    if (res.status === 204) return [];

    if (res.status === 429) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt * 2 + 1)));
        continue;
      }
      throw new EbsaRefusal({
        found: false,
        reason: 'upstream_rate_limited',
        error:
          'The DOL Open Data Portal is throttling requests (HTTP 429) and sends no Retry-After. This is a rate limit, not an empty result — the query itself may be fine.',
        hint: 'Retry in a few minutes. The throttle applies per source IP and clears on its own; narrowing the query does not lift it.',
      });
    }

    if (res.status === 401 || res.status === 403) {
      throw new EbsaRefusal({
        found: false,
        reason: 'auth_required',
        error: `The DOL Open Data Portal rejected the credentials (HTTP ${res.status}). This tool requires an API key; register free at https://dataportal.dol.gov and pass it as _apiKey.`,
        hint: 'The row endpoints take the key as an X-API-KEY QUERY PARAMETER — they answer 401 to an X-API-KEY header, which the catalog endpoint accepts.',
      });
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new EbsaRefusal({
        found: false,
        reason: 'upstream_error',
        error: `The DOL EBSA enforcement API returned HTTP ${res.status}.`,
        upstream_message: detail.slice(0, 300) || null,
        hint: 'A 500 here usually means a malformed filter, not an outage — DOL answers 500 (not 404) to an unknown dataset name and to filter_object keywords that are not lowercase.',
      });
    }

    const text = await res.text();
    if (!text.trim()) return [];
    let body: { data?: OcatsCase[] };
    try {
      body = JSON.parse(text) as { data?: OcatsCase[] };
    } catch {
      throw new EbsaRefusal({
        found: false,
        reason: 'upstream_unparseable',
        error: 'The DOL EBSA enforcement API returned a body that is not JSON.',
        upstream_message: text.slice(0, 200),
        hint: 'Retry once; if it persists the upstream is degraded rather than the query being wrong.',
      });
    }
    return body.data ?? [];
  }
}

function shapeCase(row: OcatsCase) {
  return {
    case_type: row.case_type ?? null,
    plan_name: row.plan_name ?? null,
    plan_sponsor: row.plan_admin ?? null,
    plan_sponsor_state: row.plan_admin_state ?? null,
    plan_sponsor_zip: row.plan_admin_zip_code ?? null,
    ein: row.ein ?? null,
    plan_number: row.pn ?? null,
    plan_year: row.plan_year ?? null,
    final_close_date: row.final_close_date ?? null,
    final_close_reason: row.final_close_reason ?? null,
    penalty_amount_bucket: row.penalty_amount ?? null,
  };
}

/** `%term%` substring match, the DOL-documented `like` operator (same anchored-vs-wildcard behavior dol-whd measured). */
function sponsorFilter(sponsor: string): FilterGroup {
  return { or: [{ field: 'plan_admin', operator: 'like', value: `%${sponsor}%` }, { field: 'plan_name', operator: 'like', value: `%${sponsor}%` }] };
}

function whichFieldMatched(row: OcatsCase, sponsor: string): string {
  const needle = sponsor.toLowerCase();
  if ((row.plan_admin ?? '').toLowerCase().includes(needle)) return 'plan_admin';
  if ((row.plan_name ?? '').toLowerCase().includes(needle)) return 'plan_name';
  return 'unknown';
}

// Not in any tool's `required` list — the gateway injects the platform key
// via `platformKeyEnv`, so a caller supplies this only to use their own key.
const KEY_PROP = {
  _apiKey: {
    type: 'string',
    description: 'Optional. Your own free DOL Open Data Portal key (dataportal.dol.gov); omit it to use the platform key.',
  },
} as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'ebsa_search',
    description:
      'Search closed EBSA (Employee Benefits Security Administration) civil-penalty enforcement cases since 2000 — deficient-filer, late-filer and non-filer penalty assessments against ERISA benefit-plan sponsors for their Form 5500 filings. Filter by plan sponsor/administrator name, case type, state, or plan year. Returns the plan, sponsor, case type, close reason/date, and the penalty amount (a DOL-assigned dollar-range bucket, e.g. "over $100,000"). Complements the `form5500` pack, which covers the filings themselves rather than enforcement against them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sponsor: { type: 'string', description: 'Plan sponsor / administrator name, matched as a substring against both the plan administrator and the plan name.' },
        case_type: { type: 'string', description: 'Case type, e.g. "Deficient Filer", "Late Filer", "Non Filer". Matched as a substring.' },
        state: { type: 'string', description: 'Two-letter or full state name of the plan administrator as DOL records it (e.g. "Texas").' },
        plan_year: { type: ['string', 'number'], description: 'Plan year of the filing that triggered the case, e.g. 2022.' },
        limit: { type: 'number', description: 'Cases to return, 1-100 (default 20).' },
        ...KEY_PROP,
      },
      required: [],
    },
  },
  {
    name: 'ebsa_sponsor',
    description:
      'Full EBSA civil-penalty enforcement history for one named plan sponsor/administrator, with every closed case and a count by case type. Matches the sponsor against both the plan administrator name and the plan name and reports which one hit. Use to answer whether an employer\'s benefit plans have a history of filing-compliance penalties.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sponsor: { type: 'string', description: 'Plan sponsor / administrator name, matched against the plan administrator and the plan name.' },
        limit: { type: 'number', description: 'Cases to examine, 1-100 (default 100).' },
        ...KEY_PROP,
      },
      required: ['sponsor'],
    },
  },
  {
    name: 'ebsa_recent',
    description:
      'The most recent closed EBSA civil-penalty enforcement actions, newest first, optionally restricted to one case type or state. Returns plan, sponsor, case type, close date/reason and penalty bucket for each. Use for "what EBSA enforcement actions closed recently".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        case_type: { type: 'string', description: 'Restrict to one case type, e.g. "Deficient Filer".' },
        state: { type: 'string', description: 'Restrict to one plan-administrator state as DOL records it (e.g. "California").' },
        limit: { type: 'number', description: 'Cases to return, 1-100 (default 20).' },
        ...KEY_PROP,
      },
      required: [],
    },
  },
  {
    name: 'ebsa_coverage',
    description:
      'Report what the EBSA OCATS enforcement dataset currently covers: its publication date, update frequency and the close-date range of a sample query. Use to check how current the enforcement data is before relying on an absence of cases.',
    inputSchema: {
      type: 'object' as const,
      properties: { ...KEY_PROP },
      required: [],
    },
  },
];

function intArg(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
}

function conditionsFor(args: Record<string, unknown>): Array<Cond | FilterGroup> {
  const out: Array<Cond | FilterGroup> = [];
  const caseType = typeof args.case_type === 'string' ? args.case_type.trim() : '';
  const state = typeof args.state === 'string' ? args.state.trim() : '';
  const planYear = args.plan_year !== undefined && args.plan_year !== '' ? String(args.plan_year).trim() : '';
  if (caseType) out.push({ field: 'case_type', operator: 'like', value: `%${caseType}%` });
  if (state) out.push({ field: 'plan_admin_state', operator: 'like', value: `%${state}%` });
  if (planYear) out.push({ field: 'plan_year', operator: 'eq', value: planYear });
  return out;
}

function filterParam(conds: Array<Cond | FilterGroup>): string | undefined {
  if (!conds.length) return undefined;
  return JSON.stringify({ and: conds });
}

async function ebsaSearch(args: Record<string, unknown>) {
  const apiKey = requireKey(args);
  const limit = intArg(args.limit, 20, 1, 100);
  const conds = conditionsFor(args);
  const sponsor = typeof args.sponsor === 'string' ? args.sponsor.trim() : '';
  const page = { limit, offset: 0, sort: 'desc', sort_by: 'final_close_date' };
  const rows = sponsor
    ? await ebsaFetch({ ...page, filter_object: JSON.stringify({ and: [sponsorFilter(sponsor), ...conds] }) }, apiKey)
    : await ebsaFetch({ ...page, filter_object: filterParam(conds) }, apiKey);
  const filters_applied = { sponsor: sponsor || null, case_type: args.case_type ?? null, state: args.state ?? null, plan_year: args.plan_year ?? null };
  if (!rows.length) {
    return {
      found: false,
      reason: 'no_matching_cases',
      hint: 'No closed EBSA enforcement case matched. The dataset covers CLOSED penalty-assessment cases only (deficient/late/non-filer), so an open investigation will not appear. Try widening by dropping a filter, or check the sponsor name against the plan name instead.',
      filters_applied,
    };
  }
  return {
    found: true,
    count: rows.length,
    filters_applied,
    cases: rows.map(shapeCase),
    source: 'US Department of Labor, Employee Benefits Security Administration — Office of the Chief Accountant Case Tracking System (OCATS), closed cases since 2000',
  };
}

async function ebsaSponsor(args: Record<string, unknown>) {
  const apiKey = requireKey(args);
  const sponsor = String(args.sponsor ?? '').trim();
  if (!sponsor) {
    throw new EbsaRefusal({
      found: false,
      reason: 'missing_argument',
      error: 'The "sponsor" argument is required and cannot be empty.',
      hint: 'Pass a plan sponsor/administrator name, e.g. { sponsor: "Shell USA" }. Use ebsa_search to browse without naming a sponsor.',
    });
  }
  const limit = intArg(args.limit, 100, 1, 100);
  const rows = await ebsaFetch(
    { limit, offset: 0, sort: 'desc', sort_by: 'final_close_date', filter_object: JSON.stringify({ and: [sponsorFilter(sponsor)] }) },
    apiKey,
  );
  if (!rows.length) {
    return {
      found: false,
      reason: 'no_cases_for_sponsor',
      hint: `No closed EBSA enforcement case names a plan administrator or plan matching "${sponsor}". Absence here is not a clean compliance record: it only means no CLOSED penalty-assessment case is in this dataset.`,
    };
  }
  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.case_type ?? 'Unknown', (byType.get(r.case_type ?? 'Unknown') ?? 0) + 1);
  return {
    found: true,
    sponsor_query: sponsor,
    case_count: rows.length,
    cases_by_type: Object.fromEntries(byType),
    matched_fields: [...new Set(rows.map((r) => whichFieldMatched(r, sponsor)))],
    cases: rows.map(shapeCase),
    source: 'US Department of Labor, Employee Benefits Security Administration — Office of the Chief Accountant Case Tracking System (OCATS), closed cases since 2000',
  };
}

async function ebsaRecent(args: Record<string, unknown>) {
  const apiKey = requireKey(args);
  const limit = intArg(args.limit, 20, 1, 100);
  const conds = conditionsFor(args);
  const rows = await ebsaFetch(
    { limit, offset: 0, sort: 'desc', sort_by: 'final_close_date', filter_object: filterParam(conds) },
    apiKey,
  );
  const filters_applied = { case_type: args.case_type ?? null, state: args.state ?? null };
  if (!rows.length) {
    return {
      found: false,
      reason: 'no_matching_cases',
      hint: 'Nothing matched those filters. Drop the case_type or state filter to widen.',
      filters_applied,
    };
  }
  return {
    found: true,
    count: rows.length,
    sorted_by: 'final_close_date desc',
    filters_applied,
    cases: rows.map(shapeCase),
    source: 'US Department of Labor, Employee Benefits Security Administration — Office of the Chief Accountant Case Tracking System (OCATS), closed cases since 2000',
  };
}

async function ebsaCoverage(args: Record<string, unknown>) {
  const res = await pwFetch(CATALOG);
  if (!res.ok) {
    throw new EbsaRefusal({
      found: false,
      reason: 'upstream_error',
      error: `The DOL dataset catalog returned HTTP ${res.status}.`,
      hint: 'The catalog endpoint needs no key, so a failure here is an upstream problem rather than a credential one.',
    });
  }
  const meta = (await res.json()) as { dataset?: Record<string, unknown> };
  const ds = meta.dataset ?? {};

  let sample: { earliest_close_date: string | null; latest_close_date: string | null; sampled: number } | null = null;
  let sample_error: string | null = null;
  const key = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  if (key) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dated = (dir: 'asc' | 'desc') =>
        ebsaFetch(
          {
            limit: 1,
            sort: dir,
            sort_by: 'final_close_date',
            filter_object: JSON.stringify({
              and: [
                { field: 'final_close_date', operator: 'gt', value: '1990-01-01' },
                { field: 'final_close_date', operator: 'lt', value: today },
              ],
            }),
          },
          key,
        );
      const newest = await dated('desc');
      const oldest = await dated('asc');
      sample = {
        latest_close_date: (newest[0]?.final_close_date as string) ?? null,
        earliest_close_date: (oldest[0]?.final_close_date as string) ?? null,
        sampled: newest.length + oldest.length,
      };
    } catch (e) {
      sample_error = e instanceof Error ? e.message : String(e);
    }
  } else {
    sample_error = 'No _apiKey supplied, so the close-date range could not be read. The catalog fields above need no key; the rows do.';
  }

  return {
    found: true,
    dataset: {
      id: ds.id ?? null,
      name: ds.name ?? null,
      agency: (ds.agency as { name?: string } | undefined)?.name ?? null,
      description: ds.description ?? null,
      update_frequency: ds.frequency ?? null,
      published_at: ds.published_at ?? null,
    },
    close_date_range: sample,
    ...(sample_error ? { sample_error } : {}),
    coverage_note: 'Dates describe case CLOSE dates, not when the underlying filing deficiency occurred.',
    source: 'US Department of Labor Open Data Portal, dataset 10361 (EBSA/ocats)',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'ebsa_search':
        return await ebsaSearch(args);
      case 'ebsa_sponsor':
        return await ebsaSponsor(args);
      case 'ebsa_recent':
        return await ebsaRecent(args);
      case 'ebsa_coverage':
        return await ebsaCoverage(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof EbsaRefusal) return e.payload;
    throw e;
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
