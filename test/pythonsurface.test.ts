import test from 'node:test';
import assert from 'node:assert/strict';
import { extractorFor } from '../src/surface.ts';
import { diffSurfaces } from '../src/diff.ts';
import { surfaceFromSource } from '../src/python/surface.ts';

test('PyPI is claimed by the Python extractor', () => {
  assert.equal(extractorFor('PyPI')?.id, 'python');
  assert.equal(extractorFor('npm')?.id, 'typescript');
  assert.equal(extractorFor('crates.io'), undefined);
});

test('module-level functions and classes become symbols with signatures', async () => {
  const source = `def send(url: str, timeout: int = 30) -> bytes:
    return b""


class Session:
    def close(self) -> None:
        pass
`;
  const surface = await surfaceFromSource('httpkit', '1.0.0', { 'httpkit/client.py': source });

  assert.equal(surface.symbols['send']?.kind, 'function');
  assert.equal(surface.symbols['send']?.signature, '(url: str, timeout: int = 30) -> bytes');
  assert.equal(surface.symbols['Session']?.kind, 'class');
  assert.equal(surface.symbols['Session.close']?.kind, 'method');
});

test('a leading underscore is private, and __all__ overrides that', async () => {
  const withoutAll = `def _helper() -> None:
    pass


def public() -> None:
    pass
`;
  const bare = await surfaceFromSource('pkg', '1.0.0', { 'pkg/mod.py': withoutAll });
  assert.equal('_helper' in bare.symbols, false);
  assert.equal('public' in bare.symbols, true);

  const withAll = `__all__ = ["_helper"]


def _helper() -> None:
    pass


def public() -> None:
    pass
`;
  const declared = await surfaceFromSource('pkg', '1.0.0', { 'pkg/mod.py': withAll });
  // __all__ is the module's own statement of what it exports, and honouring
  // the underscore convention over an explicit declaration would substitute a
  // guess for a fact.
  assert.equal('_helper' in declared.symbols, true);
  assert.equal('public' in declared.symbols, false);
});

test('a deprecated decorator sets the flag and captures the reason', async () => {
  const source = `@deprecated("use send() instead")
def old_send():
    """Use send() instead; this will be removed in 2.0."""
    pass
`;
  const surface = await surfaceFromSource('httpkit', '1.0.0', { 'httpkit/client.py': source });
  const sym = surface.symbols['old_send'];
  assert.equal(sym?.deprecated, true);
  assert.equal(sym?.doc?.includes('Use send() instead'), true);
});

test('a package with no readable source reports unanalyzable, not an empty surface', async () => {
  // An empty surface diffs as "nothing changed", which renders as a clean
  // upgrade — the most dangerous wrong answer this can give.
  const surface = await surfaceFromSource('ghost', '1.0.0', {});
  assert.equal(surface.entry, null);
  assert.equal(typeof surface.note, 'string');
  assert.deepEqual(surface.symbols, {});
});

test('a signature change is what diff.ts sees', async () => {
  const before = `def send(url: str) -> bytes:
    return b""
`;
  const after = `def send(url: str, timeout: int) -> bytes:
    return b""
`;
  const from = await surfaceFromSource('httpkit', '1.0.0', { 'httpkit/client.py': before });
  const to = await surfaceFromSource('httpkit', '2.0.0', { 'httpkit/client.py': after });

  const diff = diffSurfaces(from, to);
  assert.equal(diff.unanalyzable, false);
  assert.equal(
    diff.changes.some((c) => c.path === 'send'),
    true,
  );
});
