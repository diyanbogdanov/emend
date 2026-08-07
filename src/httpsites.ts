/**
 * Finding outbound HTTP calls, and working out which endpoint each one reaches.
 *
 * The call-site half of the analogy `specdiff.ts` states: an OpenAPI description
 * is the `.d.ts` for a raw HTTP call, so a `fetch` to `POST /v1/charges` is the
 * call site, and asking whether it still satisfies the new description is the
 * type-checker analogue for untyped HTTP.
 *
 * The three steps have genuinely different confidence, and the code is built so
 * that shows.
 *
 * *Finding the calls* is high confidence — static and local, an AST walk over
 * source that is already being parsed. *Resolving a URL to a vendor and an
 * endpoint* is medium: a URL assembled at runtime is invisible to any amount of
 * reading. *Deciding something is broken* is medium too, and that judgement is
 * not made here at all — `specs.ts` decides whether the description was
 * authoritative enough to say so.
 *
 * The rule that holds it together: **a call that cannot be read is recorded, not
 * dropped.** Quietly skipping the ones that are hard is exactly how a report of
 * "no problems found" gets assembled out of things nobody looked at.
 */

import ts from 'typescript';
import { canAssertBreakage, describeProvenance, type SpecCandidate } from './specs.ts';
import { parseSpec, readOperations } from './specdiff.ts';
import type { CallSite, SurfaceChange } from './types.ts';

export interface HttpCall {
  file: string;
  line: number;
  column: number;
  /** The source text of the call, for the evidence body. */
  text: string;
  method: string;
  /** Whether the URL could be read statically. Everything below depends on it. */
  resolved: boolean;
  /** Null when unresolved. */
  host: string | null;
  /** Null when unresolved. A substituted segment is `{}`. */
  route: string | null;
  /** Why it could not be read, when it could not. */
  reason?: string;
}

/**
 * Clients whose first argument is a URL.
 *
 * `fetch` is the platform. The rest are the libraries people actually reach for,
 * and they share a shape: `client.verb(url, …)` or `client(url, …)`.
 */
const CLIENTS = new Set(['fetch', 'axios', 'got', 'ky', 'request', 'superagent']);
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** The route with query and fragment removed — the same endpoint either way. */
function routeOf(pathname: string): string {
  return pathname.replace(/[?#].*$/, '') || '/';
}

/**
 * Read a URL out of a string or template literal.
 *
 * A template is read as far as its substitutions allow. `/v1/charges/${id}` is a
 * real endpoint with a real path parameter — OpenAPI spells it
 * `/v1/charges/{charge}` — and refusing to read it would lose most of the
 * interesting call sites in any codebase. A substitution inside the *host* is
 * different: the host decides which API this is, and without it there is nothing
 * to check against.
 */
function readUrl(node: ts.Expression): { host: string; route: string } | { reason: string } {
  let raw: string;

  if (ts.isStringLiteralLike(node)) {
    raw = node.text;
  } else if (ts.isTemplateExpression(node)) {
    // `{}` marks a substituted segment, so a path parameter stays one segment
    // rather than collapsing into its neighbours.
    let text = node.head.text;
    for (const span of node.templateSpans) text += `{}${span.literal.text}`;
    raw = text;
  } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
    raw = node.text;
  } else {
    return { reason: 'the URL is not a literal, so it cannot be read without running the code' };
  }

  if (raw.startsWith('{}')) {
    return { reason: 'the host is substituted at runtime, so which API this reaches is unknown' };
  }
  if (!/^https?:\/\//i.test(raw)) {
    return {
      reason: 'the URL is relative, so it reaches this application’s own server rather than a vendor',
    };
  }

  // `{}` is not legal in a URL, so it is swapped out and back around parsing.
  const placeholder = '__EMEND_SEG__';
  let parsed: URL;
  try {
    parsed = new URL(raw.replaceAll('{}', placeholder));
  } catch {
    return { reason: 'the URL could not be parsed' };
  }
  if (parsed.hostname.includes(placeholder)) {
    return { reason: 'the host is substituted at runtime, so which API this reaches is unknown' };
  }

  return {
    host: parsed.hostname.toLowerCase(),
    route: routeOf(parsed.pathname).replaceAll(placeholder, '{}'),
  };
}

/** The method an options object declares, if it declares one. */
function methodFromOptions(node: ts.Expression | undefined): string | null {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : '';
    if (name !== 'method') continue;
    if (ts.isStringLiteralLike(prop.initializer)) return prop.initializer.text.toUpperCase();
  }
  return null;
}

/**
 * Every outbound HTTP call in one file.
 *
 * Parsed standalone rather than through a `Program`: this needs no type
 * information — the shape of the call is the whole signal — and a detector that
 * can run over a single file is one that can run before a build succeeds.
 */
export function findHttpCalls(file: string, source: string): HttpCall[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const calls: HttpCall[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let method: string | null = null;
      let recognised = false;

      if (ts.isIdentifier(node.expression)) {
        // `fetch(url, …)`, `got(url, …)`
        if (CLIENTS.has(node.expression.text)) recognised = true;
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        // `axios.post(url, …)`, `got.put(url, …)`
        const verb = node.expression.name.text.toLowerCase();
        const client = ts.isIdentifier(node.expression.expression)
          ? node.expression.expression.text
          : '';
        if (VERBS.has(verb) && CLIENTS.has(client)) {
          recognised = true;
          method = verb.toUpperCase();
        }
      }

      const url = node.arguments[0];
      if (recognised && url) {
        const read = readUrl(url);
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const base = {
          file,
          line: line + 1,
          column: character + 1,
          text: node.getText(sf).split('\n')[0]?.slice(0, 160) ?? '',
          // Unspecified means GET, which is what every one of these clients does.
          method: method ?? methodFromOptions(node.arguments[1]) ?? 'GET',
        };
        calls.push(
          'reason' in read
            ? { ...base, resolved: false, host: null, route: null, reason: read.reason }
            : { ...base, resolved: true, host: read.host, route: read.route },
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return calls;
}

// ---------------------------------------------------------------------------
// The contract check
// ---------------------------------------------------------------------------

export interface ContractHit {
  change: SurfaceChange;
  sites: CallSite[];
  /**
   * Calls to this host whose URL could not be read.
   *
   * Carried on every hit so a report can never be rendered as "nothing wrong
   * with your integration" when part of it was unreadable. Emend looked at what
   * it could read, and says how much that was.
   */
  unresolvedCalls: number;
}

export interface ContractCheck {
  /** Calls reaching an endpoint the current description does not contain. */
  gone: HttpCall[];
  /** How many of this host's calls the description accounted for. */
  matched: number;
  unresolvedCalls: number;
  /** Why nothing is claimed, when nothing is. */
  note?: string;
}

/**
 * Check a host's calls against the description of it, without needing a previous
 * one to compare against.
 *
 * `diffSpecs` answers "what changed"; this answers the question a customer
 * actually has — *is my integration still valid?* — which needs only today's
 * description and needs no baseline, so it works on a first scan.
 *
 * Two things stop it being confidently wrong.
 *
 * A description that is not the provider's own word claims nothing. That is
 * `specs.ts`'s rule applied where it bites: telling somebody their integration
 * is broken on the strength of a copy that may be years stale is exactly the
 * false certainty every honesty rule here exists to prevent, and a reader cannot
 * tell it from a real finding.
 *
 * And if *no* call matches anything in the description, the conclusion is that
 * the two could not be aligned — a base path, a host convention, a versioned
 * prefix — not that every endpoint the customer calls has been deleted. Without
 * that guard the worst case is a page of confident nonsense; with it, the
 * detector has to demonstrate it can find this API before it may say anything is
 * missing from it.
 */
export function checkAgainstSpec(
  calls: HttpCall[],
  host: string,
  spec: SpecCandidate,
): ContractCheck {
  const mine = calls.filter((c) => c.resolved && c.host === host);
  const unresolvedCalls = calls.filter((c) => !c.resolved).length;
  const empty = { gone: [], matched: 0, unresolvedCalls };

  if (!spec.body) return { ...empty, note: 'the description was located but not fetched' };
  if (!canAssertBreakage(spec)) {
    return {
      ...empty,
      note: `not authoritative, so nothing is claimed from it — ${describeProvenance(spec)}`,
    };
  }

  const doc = parseSpec(spec.body);
  if (!doc) return { ...empty, note: 'the description could not be read as OpenAPI or Swagger' };
  const ops = readOperations(doc);
  if (ops.size === 0) return { ...empty, note: 'the description could not be read as OpenAPI or Swagger' };

  const described = [...ops.keys()].map((key) => endpointOf(key)).filter((e) => e !== null);
  const present = (call: HttpCall): boolean =>
    described.some((e) => e.method === call.method && call.route && sameRoute(call.route, e.route));

  const matched = mine.filter(present).length;
  if (matched === 0) {
    return {
      ...empty,
      note:
        mine.length === 0
          ? 'no readable call reaches this host'
          : 'the description could not be aligned with any call in this repository, so nothing is claimed',
    };
  }

  return { gone: mine.filter((c) => !present(c)), matched, unresolvedCalls };
}

/** `POST /v1/charges query:x` and `POST /v1/charges` both name that endpoint. */
function endpointOf(changePath: string): { method: string; route: string } | null {
  const match = changePath.match(/^([A-Z]+) (\S+)/);
  if (!match?.[1] || !match[2]) return null;
  return { method: match[1], route: match[2] };
}

/**
 * Whether a call's route reaches a described one.
 *
 * OpenAPI templates a path parameter as `{charge}`; a call site substitutes it,
 * which `findHttpCalls` records as `{}`. Either side being templated matches the
 * other, since both mean "some value goes here".
 */
function sameRoute(callRoute: string, specRoute: string): boolean {
  const a = callRoute.split('/');
  const b = specRoute.split('/');
  if (a.length !== b.length) return false;
  return a.every((segment, i) => {
    const other = b[i] ?? '';
    if (segment === '{}' || /^\{.*\}$/.test(other)) return true;
    return segment === other;
  });
}

/**
 * Which changes actually reach this codebase.
 *
 * Only what breaks or is deprecated. A new optional parameter on an endpoint
 * somebody calls is not a task, and raising it would bury the seven real breaks
 * of a Stripe upgrade under its hundred and eighty-three additions — the same
 * reason `severity` exists at all.
 *
 * Nothing here decides whether a finding may be *asserted*: that depends on how
 * authoritative the description was, and `canAssertBreakage` owns it.
 */
export function matchAgainstDiff(
  calls: HttpCall[],
  host: string,
  changes: SurfaceChange[],
): ContractHit[] {
  const mine = calls.filter((c) => c.resolved && c.host === host);
  // Unresolved calls have no host by definition, so they count against every
  // vendor rather than none. Attributing them would be a guess.
  const unresolvedCalls = calls.filter((c) => !c.resolved).length;

  const hits: ContractHit[] = [];
  for (const change of changes) {
    if (change.severity !== 'breaking' && change.severity !== 'deprecation') continue;
    const endpoint = endpointOf(change.path);
    if (!endpoint) continue;

    const sites = mine
      .filter((c) => c.method === endpoint.method && c.route && sameRoute(c.route, endpoint.route))
      .map(
        (c): CallSite => ({ file: c.file, line: c.line, column: c.column, text: c.text, via: 'import' }),
      );
    if (sites.length > 0) hits.push({ change, sites, unresolvedCalls });
  }
  return hits;
}
