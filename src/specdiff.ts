/**
 * Diffing two API descriptions, the way `diff.ts` diffs two `.d.ts` surfaces.
 *
 * **An OpenAPI description is the `.d.ts` for a raw HTTP call.** Spec v1 against
 * v2 is a surface diff; a `fetch` to `POST /v1/charges` is a call site; "does
 * this request still satisfy the new description?" is a static contract check.
 * That analogy is the whole reason this fits: the output is `SurfaceChange`, the
 * same type the type-level diff produces, so findings, the evidence gate and the
 * PR body need no new vocabulary to carry it.
 *
 * The severities mean what they mean elsewhere. Breaking is *existing callers
 * now fail*; a deprecation still works; a feature costs nobody anything. An
 * endpoint that gained an optional parameter is a feature no matter how large
 * the diff looks, and the headline count stays worth reading.
 */

import YAML from 'yaml';
import type { SurfaceChange } from './types.ts';

export interface SpecDiff {
  vendor: string;
  changes: SurfaceChange[];
  /** True when either side could not be read as a description. */
  unanalyzable: boolean;
  note?: string;
}

type Doc = Record<string, unknown>;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// ---------------------------------------------------------------------------
// $ref
// ---------------------------------------------------------------------------

/**
 * Follow `$ref` at one node, without touching the document around it.
 *
 * Following references is not optional — real descriptions are mostly made of
 * them, and a diff that cannot see through them is not merely incomplete but
 * *silently empty*, which reads as "checked, and fine". That is the one answer
 * this codebase may never give by accident.
 *
 * Inlining them wholesale is not the way to do it. That was tried, and it ran
 * the real 8MB Stripe description out of memory: a schema referenced hundreds of
 * times is copied hundreds of times, and every copy contains further references.
 * The growth is exponential in the nesting depth.
 *
 * So resolution happens where the diff actually looks — a route, an operation, a
 * parameter, a parameter's schema — which is a few hundred lookups rather than a
 * rewrite of the whole document. Chains are followed; cycles stop, because a
 * schema whose child is its own type is ordinary and an unguarded walk never
 * returns. External refs are left as they are: the document they name was never
 * fetched, and inventing a resolution is worse than admitting the gap.
 */
export function makeDeref(root: unknown): (node: unknown) => unknown {
  const lookup = (pointer: string): unknown => {
    // Local refs only: `#/components/schemas/Charge`.
    if (!pointer.startsWith('#/')) return undefined;
    let node: unknown = root;
    for (const raw of pointer.slice(2).split('/')) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (typeof node !== 'object' || node === null) return undefined;
      node = (node as Doc)[key];
    }
    return node;
  };

  return (node: unknown): unknown => {
    let current = node;
    const seen = new Set<string>();
    for (;;) {
      if (typeof current !== 'object' || current === null) return current;
      const ref = (current as Doc)['$ref'];
      if (typeof ref !== 'string') return current;
      if (seen.has(ref)) return current;
      seen.add(ref);
      const target = lookup(ref);
      if (target === undefined) return current;
      current = target;
    }
  };
}

// ---------------------------------------------------------------------------
// Reading an operation
// ---------------------------------------------------------------------------

interface Param {
  name: string;
  where: string;
  required: boolean;
  type: string;
}

interface Operation {
  deprecated: boolean;
  params: Map<string, Param>;
}

function readParams(op: Doc, deref: (node: unknown) => unknown): Map<string, Param> {
  const params = new Map<string, Param>();
  const list = op['parameters'];
  if (!Array.isArray(list)) return params;
  for (const entry of list) {
    // A parameter is commonly a bare `$ref` into `components/parameters`.
    const resolved = deref(entry);
    if (typeof resolved !== 'object' || resolved === null) continue;
    const p = resolved as Doc;
    if (typeof p['name'] !== 'string') continue;
    const schema = deref(p['schema']);
    const type =
      typeof schema === 'object' && schema !== null && typeof (schema as Doc)['type'] === 'string'
        ? ((schema as Doc)['type'] as string)
        : 'unknown';
    params.set(p['name'], {
      name: p['name'],
      where: typeof p['in'] === 'string' ? p['in'] : 'query',
      required: p['required'] === true,
      type,
    });
  }
  return params;
}

/**
 * The path prefixes a description's routes are stated relative to.
 *
 * A description spells its paths relative to a base the call site must write out
 * in full: Slack's own Swagger says `basePath: "/api"` and lists `/auth.test`,
 * while every call in every repository reads `https://slack.com/api/auth.test`.
 * Comparing the two directly matches nothing, and a contract check that matches
 * nothing reports a clean integration — the exact shape of "could not check"
 * being rendered as "checked and clean".
 *
 * Deliberately *not* folded into `readOperations`. Those keys are also the keys
 * `diffSpecs` compares two descriptions by, where a base path is common to both
 * sides and prefixing it would only churn every path in the diff. Alignment is
 * the caller's business, and only the caller that meets a real URL has it.
 *
 * The empty prefix is always included: a description that declares a base and
 * then lists absolute paths anyway is common, and the cost of allowing both is a
 * call matching when it should not — which understates breakage. Erring toward
 * the finding Emend does not make is the right direction to err in.
 */
export function basePathsOf(doc: unknown): string[] {
  const bases = new Set<string>(['']);
  if (typeof doc !== 'object' || doc === null) return [...bases];
  const d = doc as Doc;

  const add = (raw: string): void => {
    // A server URL may be absolute, origin-relative, or templated with `{}`
    // variables that no URL parser will accept — so the authority is stripped
    // textually rather than parsed, and what is left is the path.
    const path = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
    const trimmed = path.replace(/\/+$/, '');
    if (trimmed.startsWith('/')) bases.add(trimmed);
  };

  // Swagger 2.0.
  if (typeof d['basePath'] === 'string') add(d['basePath']);
  // OpenAPI 3, where the base moved into the server URL.
  if (Array.isArray(d['servers'])) {
    for (const server of d['servers']) {
      if (typeof server === 'object' && server !== null && typeof (server as Doc)['url'] === 'string') {
        add((server as Doc)['url'] as string);
      }
    }
  }
  return [...bases];
}

/** Every `METHOD /path` an description defines, with what each one expects. */
export function readOperations(doc: unknown): Map<string, Operation> {
  const ops = new Map<string, Operation>();
  if (typeof doc !== 'object' || doc === null) return ops;
  const deref = makeDeref(doc);
  const paths = (doc as Doc)['paths'];
  if (typeof paths !== 'object' || paths === null) return ops;

  for (const [route, rawItem] of Object.entries(paths as Doc)) {
    const item = deref(rawItem);
    if (typeof item !== 'object' || item === null) continue;
    for (const [method, rawOp] of Object.entries(item as Doc)) {
      if (!METHODS.includes(method.toLowerCase())) continue;
      const op = deref(rawOp);
      if (typeof op !== 'object' || op === null) continue;
      ops.set(`${method.toUpperCase()} ${route}`, {
        deprecated: (op as Doc)['deprecated'] === true,
        params: readParams(op as Doc, deref),
      });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

function isSpec(doc: unknown): boolean {
  if (typeof doc !== 'object' || doc === null) return false;
  const d = doc as Doc;
  const versioned = typeof d['openapi'] === 'string' || typeof d['swagger'] === 'string';
  return versioned && typeof d['paths'] === 'object' && d['paths'] !== null;
}

/** Above this, a body is not being read as an API description by anybody. */
export const MAX_SPEC_BYTES = 16 * 1024 * 1024;

/**
 * Read a description in either form, or refuse it.
 *
 * The single place a spec document is turned into an object, so `looksLikeSpec`,
 * the diff and the contract check cannot drift on what counts as readable.
 *
 * JSON is tried first because it is cheap and common; YAML 1.2 is a superset of
 * JSON, so the fallback would handle both, just slower. YAML is not optional —
 * most first-party descriptions are YAML, and Stripe's own `x-origin` names
 * `spec3.yaml`, so refusing it meant the best pointer any directory gives us
 * landed on a file we would not open.
 *
 * These bodies come from arbitrary URLs — a directory listing, a stranger's
 * repository, a CDN — so the parser's defaults matter and are tested rather than
 * assumed: alias bombs are refused, `__proto__` stays an own key, and a tag
 * naming a function yields a string. No custom tags are enabled; the default
 * schema constructs nothing.
 */
export function parseSpec(body: string): unknown | null {
  if (body.length === 0 || body.length > MAX_SPEC_BYTES) return null;

  const accept = (doc: unknown): unknown | null => (isSpec(doc) ? doc : null);

  const trimmed = body.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      return accept(JSON.parse(body));
    } catch {
      return null;
    }
  }

  try {
    return accept(YAML.parse(body, { logLevel: 'silent' }));
  } catch {
    // Unreadable is not the same as absent, and the caller renders that
    // distinction. What must not happen is a parse error taking a scan down.
    return null;
  }
}

function parse(body: string): unknown | null {
  return parseSpec(body);
}

/**
 * What changed between two descriptions of the same API.
 *
 * Nothing is reported when nothing moved: a description compared with itself
 * yields an empty list, which is the rule every detector here is held to. A
 * detector that manufactures work against identical input cannot be trusted to
 * stay quiet against real input.
 */
export function diffSpecs(vendor: string, beforeBody: string, afterBody: string): SpecDiff {
  const before = parse(beforeBody);
  const after = parse(afterBody);
  if (!before || !after) {
    // Said, not swallowed. "I could not check" and "I checked and it is fine"
    // are different answers and only one is safe to render as a green tick.
    return {
      vendor,
      changes: [],
      unanalyzable: true,
      note: `the ${!before ? 'previous' : 'current'} description could not be read as OpenAPI or Swagger`,
    };
  }

  const oldOps = readOperations(before);
  const newOps = readOperations(after);
  const changes: SurfaceChange[] = [];

  for (const [route, oldOp] of oldOps) {
    const newOp = newOps.get(route);

    if (!newOp) {
      changes.push({
        path: route,
        kind: 'removed',
        severity: 'breaking',
        confidence: 'high',
        before: 'present',
        after: null,
      });
      continue;
    }

    // Still works. Calling it breaking would put a false number on the one line
    // of a scan anybody reads.
    if (newOp.deprecated && !oldOp.deprecated) {
      changes.push({
        path: route,
        kind: 'deprecated',
        severity: 'deprecation',
        confidence: 'high',
        before: 'current',
        after: 'deprecated',
      });
    }

    for (const [name, oldParam] of oldOp.params) {
      const label = `${route} ${oldParam.where}:${name}`;
      const newParam = newOp.params.get(name);

      if (!newParam) {
        // Servers differ: most ignore an unknown query parameter, strict ones
        // reject the request. The description cannot say which, so the change is
        // reported and the consequence is not asserted.
        changes.push({
          path: label,
          kind: 'removed',
          severity: 'breaking',
          confidence: 'medium',
          before: oldParam.required ? 'required' : 'optional',
          after: null,
        });
        continue;
      }

      // The change with no visible edit: the call site is byte-for-byte what it
      // was and the request it sends is now incomplete.
      if (newParam.required && !oldParam.required) {
        changes.push({
          path: label,
          kind: 'signature-changed',
          severity: 'breaking',
          confidence: 'high',
          before: 'optional',
          after: 'required',
        });
      }

      if (newParam.type !== oldParam.type && oldParam.type !== 'unknown' && newParam.type !== 'unknown') {
        changes.push({
          path: label,
          kind: 'signature-changed',
          severity: 'breaking',
          confidence: 'high',
          before: oldParam.type,
          after: newParam.type,
        });
      }
    }

    for (const [name, newParam] of newOp.params) {
      if (oldOp.params.has(name)) continue;
      const label = `${route} ${newParam.where}:${name}`;
      changes.push({
        path: label,
        kind: newParam.required ? 'signature-changed' : 'added',
        // A new required parameter breaks every existing call, which sends
        // nothing for it. A new optional one costs nobody anything.
        severity: newParam.required ? 'breaking' : 'feature',
        confidence: 'high',
        before: null,
        after: newParam.required ? 'required' : 'optional',
      });
    }
  }

  for (const route of newOps.keys()) {
    if (oldOps.has(route)) continue;
    changes.push({
      path: route,
      kind: 'added',
      severity: 'feature',
      confidence: 'high',
      before: null,
      after: 'present',
    });
  }

  return { vendor, changes, unanalyzable: false };
}
