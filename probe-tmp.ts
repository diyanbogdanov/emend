import { fetchPackageDir } from './src/registry.ts';
import { extractSurface } from './src/surface.ts';
import { diffSurfaces, consumerImpacting } from './src/diff.ts';

const [a, b] = await Promise.all([
  fetchPackageDir('recharts', '2.15.4'),
  fetchPackageDir('recharts', '3.10.1'),
]);
const [from, to] = await Promise.all([
  extractSurface(a, 'recharts', '2.15.4'),
  extractSurface(b, 'recharts', '3.10.1'),
]);
const d = diffSurfaces(from, to);
console.log(`  raw changes: ${d.changes.length}`);
const byKind: Record<string, number> = {};
for (const c of d.changes) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
console.log('  by kind:', JSON.stringify(byKind));
console.log(`  consumerImpacting keeps: ${consumerImpacting(d).length}`);

for (const name of ['Tooltip', 'TooltipProps', 'Formatter', 'Cell']) {
  const hit = d.changes.filter((c) => c.path === name || c.path.startsWith(name + '.'));
  console.log(`\n  --- ${name}: ${hit.length} raw change(s) ---`);
  for (const c of hit.slice(0, 3)) {
    console.log(`    ${c.path}  kind=${c.kind} conf=${c.confidence} sev=${c.severity}`);
    if (c.kind === 'signature-changed') {
      console.log(`      before: ${String(c.before).slice(0, 100)}`);
      console.log(`      after : ${String(c.after).slice(0, 100)}`);
    }
  }
}
