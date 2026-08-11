/**
 * Versions a repository writes down as literals, and whether they agree.
 *
 * A dependency version lives in the lockfile, where the package manager keeps it
 * honest. The same version written into a Dockerfile tag, an `.nvmrc`, or a CI
 * matrix is a copy, and nothing keeps a copy honest. a scanned repository pins
 * `playwright` exactly and asserts in a test that its Docker base image matches;
 * that test is the only thing in the repository that noticed, and most
 * repositories have no such test.
 *
 * This is the same shape as the `.d.ts` wedge and is why run scripts and API
 * version pins are one detector rather than two subsystems: something declares a
 * version, something else can be asked what the version really is, and the
 * difference is a finding with a file and a line.
 *
 * Only provable mismatches are reported. A pin for a tool the repository does
 * not install is left alone — Emend can say a copy disagrees with its source,
 * and cannot say a version is "old" without knowing what current means.
 */

export type PinKind = 'docker-image' | 'node-version' | 'api-version';

export interface VersionPin {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed. */
  line: number;
  /**
   * What is pinned: `node`, an image name, or the vendor whose wire API it is.
   *
   * Null when a wire-API pin is real but unowned — a bare `apiVersion` in a
   * config object with no client near it. Naming a vendor there would be a
   * guess, and the guess is not free: `subject` is the key everything downstream
   * looks the vendor up by, so a wrong one gets the pin compared against a
   * different company's published version.
   */
  subject: string | null;
  version: string;
  /** The exact source text, so a repair is a locatable find/replace. */
  text: string;
  kind: PinKind;
}

export interface PinConflict {
  subject: string;
  /**
   * The version the pins should say, or null when nothing can arbitrate.
   *
   * Null is a real answer: three files declaring three node versions with no
   * `engines` field disagree, and picking a winner would be the guessing that
   * `plan.ts` already refuses to do.
   */
  expected: string | null;
  /** What established `expected`, for the finding's evidence. */
  authority: string | null;
  /** The pins that disagree with it. */
  pins: VersionPin[];
}

/** `v1.62.1-jammy` -> `1.62.1`, `18-alpine` -> `18`, `latest` -> null. */
function versionOfTag(tag: string): string | null {
  const match = tag.match(/^v?(\d+(?:\.\d+)*)/);
  return match?.[1] ?? null;
}

/** `mcr.microsoft.com/playwright` -> `playwright`. */
function imageName(ref: string): string {
  const segments = ref.split('/');
  return segments[segments.length - 1] ?? ref;
}

function fromDockerfile(file: string, source: string): VersionPin[] {
  const pins: VersionPin[] = [];
  source.split('\n').forEach((raw, index) => {
    // `FROM image:tag AS stage`, case-insensitive, digest refs ignored because
    // a digest is already exact and has nothing to drift against.
    const match = raw.match(/^\s*FROM\s+(\S+?):([\w.-]+)(?:\s|$)/i);
    if (!match) return;
    const [, ref = '', tag = ''] = match;
    const version = versionOfTag(tag);
    if (!version) return; // `latest`, `alpine`, `jammy` — nothing to disagree with

    const name = imageName(ref);
    pins.push({
      file,
      line: index + 1,
      // `FROM node:18` is how most repositories pin node, and reading it as an
      // opaque image would leave the commonest inconsistency invisible.
      subject: name === 'node' ? 'node' : name,
      version,
      text: `${ref}:${tag}`,
      kind: name === 'node' ? 'node-version' : 'docker-image',
    });
  });
  return pins;
}

/**
 * Wire-protocol versions pinned in source.
 *
 * A vendor versions its HTTP API separately from the SDK that calls it.
 * `stripe@18` and `apiVersion: '2024-06-20'` move independently, and upgrading
 * the package does not touch the pin — so a `.d.ts` diff, which is the only
 * thing Emend had, cannot see this drift at all. It is the same shape as a
 * Dockerfile tag: a version written as a literal, in a file nothing keeps honest.
 *
 * Read by convention rather than by vendor. Three conventions carry a wire
 * version, and the difference between them is not cosmetic — it is how much each
 * one tells you about whose version it is:
 *
 *   `'Notion-Version': '2022-06-28'`   the key names the vendor
 *   `new AWS.SES({ apiVersion: … })`   the constructor's import names it
 *   `…?api-version=2023-05-15`         the URL's host names it
 *
 * Which matters because the shape alone names nobody. Sampling repositories that
 * carry a dated `apiVersion`, eight in nine belonged to AWS, Sanity or Alibaba
 * rather than to Stripe, so a rule that reads the shape as one vendor's is wrong
 * far more often than it is right.
 */

/**
 * `'anthropic-version'`, `'Notion-Version'`, `'x-shopify-api-version'`.
 *
 * The whole point of this one: it needs no vendor list, because a header that
 * says `<name>-version` has already told you the name. It reads the vendors
 * nobody thought to write down.
 */
const LABELLED_VERSION = /['"](?:x-)?([a-z][a-z\d]*(?:-[a-z\d]+)*?)-(?:api-)?(?:version|beta)['"]\s*:\s*['"]([^'"]{1,40})['"]/i;

/** `apiVersion: '2024-06-20'` — dated, because an undated one is `apps/v1`. */
const DATED_OPTION = /\bapi[_-]?version\s*:\s*['"](\d{4}-\d{2}-\d{2}[\w.]*)['"]/i;

/**
 * Whether a version names a wire contract rather than a build.
 *
 * `<name>-version` is also how a client announces itself — `xt-app-version:
 * 1.4.50`, `em-client-version: 1.3.2` — and in sampled repositories those
 * outnumbered the real pins. The convention cannot tell them apart, but what the
 * value is a version *of* can: a wire API is a dated revision of a contract that
 * both sides agree to speak, so vendors name it by release date (Stripe,
 * Anthropic, Notion, Square) or by a channel (`assistants=v2`). Software
 * artifacts are versioned by semver. A header carrying `1.4.50` is saying which
 * build is calling, which is a fact about the caller and not about the contract.
 *
 * A vendor that versioned its wire API in semver would be missed. That is the
 * safe direction and the one this module takes everywhere: unreported beats
 * wrongly reported.
 */
const WIRE_VERSION = /^(?:\d{4}-\d{2}(?:-\d{2})?[\w.-]*|v\d+(?:\.\d+)?|[a-z][\w-]*=v?\d+)$/i;

/** `?api-version=2023-05-15`, whose vendor is the host in the same URL. */
const VERSION_QUERY = /[?&]api-version=(\d{4}-\d{2}-\d{2}[\w.-]*)/i;

/** `https://x.openai.azure.com/…` -> `azure`: the label the vendor is known by. */
function vendorOfUrl(text: string): string | null {
  const host = text.match(/https?:\/\/([^/'"\s]+)/)?.[1];
  const labels = host?.split('.') ?? [];
  // Second-to-last, so `management.azure.com` and `x.openai.azure.com` agree.
  return labels.length >= 2 ? (labels[labels.length - 2] ?? null) : null;
}

/**
 * The package whose client is being constructed at or just above `line`.
 *
 * Resolved by binding name *and* an actual import of it, never by the name
 * alone — `Stripe` in a file that imports nothing is an identifier, not a
 * vendor. This is the rule `httpsites.ts` already applies to base URLs, and it
 * exists because the name is the part a reader assumes and the import is the
 * part that proves it.
 */
function constructedFrom(lines: string[], line: number): string | null {
  // Upwards, because the option sits inside an argument that often opens on an
  // earlier line. Bounded, so a pin far below an unrelated `new` is not adopted.
  for (let i = line; i >= 0 && i > line - 8; i--) {
    const binding = lines[i]?.match(/\bnew\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*\(\s*\{/);
    const name = binding?.[1] ?? binding?.[2];
    if (!name) continue;
    for (const raw of lines) {
      const imported = raw.match(
        new RegExp(`\\b${name}\\b[^'"\`]*?(?:from|require\\(|import\\()\\s*['"]([^'"]+)['"]`),
      );
      const module = imported?.[1];
      if (module && !module.startsWith('.') && !module.startsWith('node:')) {
        // The scope where there is one: `@sanity/client` is Sanity's, and the
        // sub-package `client` names a module rather than a vendor.
        return module.startsWith('@') ? (module.split('/')[0]?.slice(1) ?? module) : module;
      }
    }
  }
  return null;
}

function fromSource(file: string, source: string): VersionPin[] {
  const pins: VersionPin[] = [];
  const lines = source.split('\n');

  lines.forEach((raw, index) => {
    const add = (subject: string | null, version: string, text: string) => {
      if (!WIRE_VERSION.test(version)) return;
      pins.push({ file, line: index + 1, subject, version, text, kind: 'api-version' });
    };

    const labelled = raw.match(LABELLED_VERSION);
    // `api` labels nothing — `'x-api-version'` is the convention with the vendor
    // left out, so it identifies no more than the bare option does.
    if (labelled?.[1] && labelled[2] && labelled[1].toLowerCase() !== 'api') {
      add(labelled[1].toLowerCase(), labelled[2], labelled[0]);
      return;
    }

    const query = raw.match(VERSION_QUERY);
    if (query?.[1]) {
      add(vendorOfUrl(raw), query[1], query[0]);
      return;
    }

    const option = raw.match(DATED_OPTION);
    if (option?.[1]) add(constructedFrom(lines, index), option[1], option[0]);
  });

  return pins;
}

function fromWorkflow(file: string, source: string): VersionPin[] {
  const pins: VersionPin[] = [];
  source.split('\n').forEach((raw, index) => {
    const match = raw.match(/^\s*node-version:\s*['"]?(\d+(?:\.\d+)*)['"]?\s*$/);
    const version = match?.[1];
    if (!version) return;
    pins.push({
      file,
      line: index + 1,
      subject: 'node',
      version,
      text: raw.trim(),
      kind: 'node-version',
    });
  });
  return pins;
}

function fromManifest(file: string, source: string): VersionPin[] {
  let manifest: { engines?: { node?: string } };
  try {
    manifest = JSON.parse(source) as { engines?: { node?: string } };
  } catch {
    return [];
  }
  const declared = manifest.engines?.node;
  if (!declared) return [];
  const version = declared.match(/(\d+(?:\.\d+)*)/)?.[1];
  if (!version) return [];

  const lines = source.split('\n');
  const line = lines.findIndex((l) => l.includes('"node"')) + 1;
  return [
    {
      file,
      line: line > 0 ? line : 1,
      subject: 'node',
      version,
      text: declared,
      kind: 'node-version',
    },
  ];
}

/** Every version literal the given files declare. */
export function extractPins(files: ReadonlyMap<string, string>): VersionPin[] {
  const pins: VersionPin[] = [];
  for (const [file, source] of files) {
    const base = file.split('/').pop() ?? file;
    if (/^Dockerfile/i.test(base)) pins.push(...fromDockerfile(file, source));
    else if (base === '.nvmrc') {
      const version = source.trim().replace(/^v/, '');
      if (/^\d/.test(version)) {
        pins.push({ file, line: 1, subject: 'node', version, text: source.trim(), kind: 'node-version' });
      }
    } else if (base === 'package.json') pins.push(...fromManifest(file, source));
    else if (/\.ya?ml$/.test(base)) pins.push(...fromWorkflow(file, source));
    else if (/\.[cm]?[jt]sx?$/.test(base)) pins.push(...fromSource(file, source));
  }
  return pins;
}

/**
 * Pins that disagree with something able to arbitrate.
 *
 * Two authorities, and no others. For a package the repository installs, the
 * resolved version is the fact and the pin is a stale copy of it. For node, the
 * `engines` field is the project's own statement of intent — anything else would
 * be Emend choosing a version the project never asked for.
 */
export function findPinConflicts(
  pins: VersionPin[],
  installed: ReadonlyMap<string, string>,
): PinConflict[] {
  const conflicts: PinConflict[] = [];

  const images = pins.filter((p) => p.kind === 'docker-image');
  const bySubject = new Map<string, VersionPin[]>();
  for (const pin of images) {
    // An image reference always names its image, so this is never null in
    // practice; grouping unattributed pins together would invent a shared
    // subject for images that have nothing to do with each other.
    if (pin.subject === null) continue;
    bySubject.set(pin.subject, [...(bySubject.get(pin.subject) ?? []), pin]);
  }
  for (const [subject, group] of bySubject) {
    const resolved = installed.get(subject);
    // Not an npm dependency: outside what can be proven, so not reported.
    if (!resolved) continue;
    const disagreeing = group.filter((p) => p.version !== resolved);
    if (disagreeing.length > 0) {
      conflicts.push({
        subject,
        expected: resolved,
        authority: `the installed ${subject}`,
        pins: disagreeing,
      });
    }
  }

  const nodePins = pins.filter((p) => p.kind === 'node-version');
  if (nodePins.length > 1) {
    const distinct = new Set(nodePins.map((p) => p.version));
    if (distinct.size > 1) {
      const engine = nodePins.find((p) => p.file.endsWith('package.json'));
      const expected = engine?.version ?? null;
      conflicts.push({
        subject: 'node',
        expected,
        authority: expected ? 'the declared engines.node' : null,
        // With an authority, only the pins that disagree with it. Without one,
        // all of them, because the disagreement is the finding.
        pins: expected ? nodePins.filter((p) => p.version !== expected) : nodePins,
      });
    }
  }

  return conflicts;
}

/**
 * Deterministic edits that bring drifted pins back in line.
 *
 * No model is involved and none is needed: the target version is known, the
 * location is known, and the change is a substring substitution. Only the
 * version is replaced — the `v` prefix, the distro suffix and the surrounding
 * YAML or Dockerfile syntax are the repository's own choices, and rewriting them
 * would be an edit the drift did not call for.
 *
 * A conflict with no authority yields nothing. Reporting that three files
 * disagree is honest; inventing a version to settle it is the guess `plan.ts`
 * refuses to make, and that one belongs to a human.
 */
export function planPinRepair(
  conflict: PinConflict,
): Array<{ file: string; line: number; find: string; replace: string; reason: string }> {
  const target = conflict.expected;
  if (!target) return [];

  return conflict.pins.map((pin) => ({
    file: pin.file,
    line: pin.line,
    find: pin.text,
    // Anchored to the version this pin actually carries, so a tag that happens
    // to contain the digits elsewhere — `playwright:v1.62.1-node18` — is not
    // rewritten in the wrong place.
    replace: pin.text.replace(pin.version, target),
    reason: `${conflict.subject} is ${target} per ${conflict.authority}`,
  }));
}

/**
 * Versions that can arbitrate a disagreement.
 *
 * A dependency whose version was inferred from its declared range is explicitly
 * not a fact about the repository — it may name a release that was never
 * published. Using one as the authority would report a Dockerfile as drifted
 * against a version that does not exist, and the reader has no way to tell that
 * finding from a lockfile-backed one.
 */
export function resolvedVersions(
  deps: ReadonlyArray<{ name: string; installed: string | null; source: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const dep of deps) {
    if (dep.installed === null) continue;
    if (dep.source !== 'node_modules' && dep.source !== 'lockfile') continue;
    out.set(dep.name, dep.installed);
  }
  return out;
}

/**
 * Files a repository writes versions into.
 *
 * A fixed list rather than a walk: these are the places a version is copied by
 * convention, and globbing a repository for anything version-shaped is how a
 * detector starts reporting suspicion instead of evidence.
 */
export const PIN_FILES = [
  'Dockerfile',
  'Dockerfile.dev',
  'Dockerfile.prod',
  '.nvmrc',
  'package.json',
  '.github/workflows/ci.yml',
  '.github/workflows/test.yml',
  '.github/workflows/build.yml',
  '.github/workflows/main.yml',
];

/** Read a repository's version pins and report the ones that disagree. */
export async function scanPins(
  installed: ReadonlyMap<string, string>,
  read: (file: string) => Promise<string | null>,
  /**
   * Repo-relative source files to search for wire-protocol version pins.
   *
   * Separate from `PIN_FILES` because the two are found differently. A
   * Dockerfile is at a known path; an `apiVersion` option is wherever the client
   * happens to be constructed, so the caller supplies the list it already walked
   * rather than this module walking the repository a second time.
   */
  sourceFiles: string[] = [],
): Promise<{ conflicts: PinConflict[]; apiVersions: VersionPin[] }> {
  const files = new Map<string, string>();
  for (const file of [...PIN_FILES, ...sourceFiles]) {
    if (files.has(file)) continue;
    const source = await read(file);
    if (source !== null) files.set(file, source);
  }
  const pins = extractPins(files);
  // Wire-protocol pins are observations, not conflicts. Nothing on this machine
  // knows what Stripe's current API version is, so there is nothing for them to
  // disagree with — but "you pin Stripe at 2024-06-20, here is where" is useful
  // and true, and it is the only view of that drift Emend can offer at all.
  return { conflicts: findPinConflicts(pins, installed), apiVersions: unarbitratedPins(pins) };
}

/**
 * Version pins with nothing able to arbitrate them.
 *
 * A wire-protocol pin is one of these by construction: Emend can see that a
 * repository pins Stripe at `2024-06-20` and has no way to know what the current
 * version is, which would need a vendor registry it does not have. Reporting the
 * pin is useful and true; inventing a target would be the guessing the planner
 * refuses to do everywhere else.
 */
export function unarbitratedPins(pins: VersionPin[]): VersionPin[] {
  return pins.filter((p) => p.kind === 'api-version');
}

/** One line per conflict, for a report or a prompt. */
export function describePinConflicts(conflicts: PinConflict[]): string {
  return conflicts
    .map((cf) => {
      const where = cf.pins.map((p) => `${p.file}:${p.line} (${p.version})`).join(', ');
      return cf.expected
        ? `- \`${cf.subject}\` should be ${cf.expected} per ${cf.authority}, but ${where}`
        : `- \`${cf.subject}\` is pinned inconsistently and nothing declares the intended version: ${where}`;
    })
    .join('\n');
}

/** A dated API version, which is the only shape that can be ordered. */
const DATED = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Whether a pinned wire-API version is behind the one the vendor publishes.
 *
 * `null` when the two cannot be compared, which is most of the time and is a
 * real answer rather than a failure. A description's `info.version` is only the
 * *API's* version where the vendor versions its API that way: Stripe publishes
 * `2026-07-29.dahlia` and pins read `2024-10-21`, the same shape, so they order.
 * OpenAI publishes `2.3.0`, which versions the document — comparing it against a
 * date would report every OpenAI pin as behind on a number that does not mean
 * what the pin means.
 *
 * Shape is what decides it, not a list of vendors, because the question is
 * whether these two strings are the same kind of thing.
 */
export function behindCurrent(pinned: string, current: string): boolean | null {
  const a = DATED.exec(pinned.trim())?.[1];
  const b = DATED.exec(current.trim())?.[1];
  if (!a || !b) return null;
  return a < b;
}
