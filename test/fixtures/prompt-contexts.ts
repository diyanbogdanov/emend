/**
 * The contexts the prompt goldens are rendered from.
 *
 * Their only job is branch coverage. Every `if` in the four renderers has a
 * fixture that enters it and a fixture that does not, because a byte-identity
 * check that never renders the deprecation block proves byte-identity of
 * everything except the deprecation block — and that is the section most likely
 * to be dropped by a careless recomposition, since it is the only one nested two
 * levels deep.
 *
 * Shared by the golden test and by whatever regenerates the goldens, so the two
 * cannot disagree about what was rendered.
 */

import type {
  AgentContext,
  LintFixContext,
  ReviewContext,
  TighteningContext,
} from '../../src/llm/tasks.ts';
import type { Finding } from '../../src/types.ts';

const FINDING: Finding = {
  id: 'f-recharts-1',
  detector: 'npm-surface',
  pkg: 'recharts',
  fromVersion: '2.15.0',
  toVersion: '3.10.1',
  change: {
    path: 'Tooltip.formatter',
    kind: 'signature-changed',
    severity: 'breaking',
    confidence: 'medium',
    before: '(value: TValue, name: TName) => ReactNode',
    after: '(value: ValueType | undefined, name: NameType) => ReactNode',
  },
  sites: [],
  confidence: 'medium',
};

const SOURCES = new Map([
  [
    'src/Chart.tsx',
    "import { Tooltip } from 'recharts';\n\nexport const Chart = () => (\n  <Tooltip formatter={(value: any) => [`${value.toFixed(1)}%`, LABEL]} />\n);\n",
  ],
  [
    'src/Legend.tsx',
    "import { Cell } from 'recharts';\n\nexport const swatch = (fill: string) => <Cell fill={fill} />;\n",
  ],
]);

/** Everything optional present: candidates, impact, failure output. */
export const MIGRATION_FULL: AgentContext = {
  finding: FINDING,
  changes: [
    {
      change: {
        path: 'Tooltip.formatter',
        kind: 'signature-changed',
        severity: 'breaking',
        confidence: 'medium',
        before: '(value: TValue, name: TName) => ReactNode',
        after: '(value: ValueType | undefined, name: NameType) => ReactNode',
        guidance: 'Use the exported ValueType and narrow before formatting.',
      },
      sites: [
        { file: 'src/Chart.tsx', line: 4, column: 20, text: 'formatter={(value: any) =>', via: 'import' },
      ],
    },
    {
      // No `after`, which is the "symbol no longer exists" branch of describeChange.
      change: {
        path: 'Cell',
        kind: 'removed',
        severity: 'breaking',
        confidence: 'high',
        before: 'declare const Cell: FC<CellProps>',
        after: null,
      },
      sites: [
        { file: 'src/Legend.tsx', line: 3, column: 45, text: '<Cell fill={fill} />', via: 'import' },
      ],
    },
  ],
  sources: SOURCES,
  candidateSymbols: ['Tooltip', 'ValueType', 'NameType', 'Rectangle', 'Customized'],
  failureOutput:
    "src/Chart.tsx(4,38): error TS18048: 'value' is possibly 'undefined'.\nsrc/Legend.tsx(3,32): error TS2304: Cannot find name 'Cell'.",
  impact: [
    {
      name: 'swatch',
      declaredIn: 'src/Legend.tsx',
      external: [
        { file: 'src/Panel.tsx', line: 12, column: 9, text: 'swatch(theme.accent)' },
        { file: 'src/Table.tsx', line: 88, column: 21, text: 'cells.map(swatch)' },
      ],
    },
  ],
};

/** Every optional absent, so each guarded section has to disappear entirely. */
export const MIGRATION_MINIMAL: AgentContext = {
  finding: FINDING,
  changes: [
    {
      change: {
        path: 'Tooltip.formatter',
        kind: 'signature-changed',
        severity: 'drift',
        confidence: 'medium',
        before: '(value: TValue) => ReactNode',
        after: '(value: ValueType) => ReactNode',
      },
      sites: [],
    },
  ],
  sources: new Map([['src/Chart.tsx', 'export const Chart = () => null;\n']]),
  candidateSymbols: [],
};

export const TIGHTENING: TighteningContext = {
  finding: FINDING,
  sources: new Map([
    ['src/Chart.tsx', 'export const fmt = (value) => `${value.toFixed(1)}%`;\n'],
    ['src/Legend.tsx', 'export const swatch = (fill) => fill.trim();\n'],
  ]),
  errors:
    "src/Chart.tsx(1,36): error TS18046: 'value' is of type 'unknown'.\nsrc/Legend.tsx(1,34): error TS18046: 'fill' is of type 'unknown'.",
};

/** Gaps present and candidates present: both nested sections render. */
export const REVIEW_FULL: ReviewContext = {
  finding: FINDING,
  sources: SOURCES,
  diff: "--- a/src/Chart.tsx\n+++ b/src/Chart.tsx\n@@ -4,1 +4,1 @@\n-  <Tooltip formatter={(value) => value.toFixed(1)} />\n+  <Tooltip formatter={(value: any) => value.toFixed(1)} />\n",
  deprecationGaps: 'Cell (src/Legend.tsx:3)\nLabelList (src/Chart.tsx:9)',
  candidateSymbols: ['Rectangle', 'Customized', 'Text'],
};

/** Gaps present, candidates empty: the outer section renders, the inner does not. */
export const REVIEW_GAPS_NO_CANDIDATES: ReviewContext = {
  ...REVIEW_FULL,
  candidateSymbols: [],
};

/** No gaps: the whole unfinished-deprecations block disappears. */
export const REVIEW_CLEAN: ReviewContext = {
  ...REVIEW_FULL,
  deprecationGaps: '',
};

export const LINT: LintFixContext = {
  findings: [
    { file: 'Dockerfile', line: 3, code: 'DL3006', message: 'Always tag the version of an image explicitly' },
    { file: 'scripts/release.sh', line: 12, code: 'SC2086', message: 'Double quote to prevent globbing and word splitting' },
  ],
  sources: new Map([
    ['Dockerfile', 'FROM node\nWORKDIR /app\nRUN npm ci\n'],
    ['scripts/release.sh', '#!/bin/sh\nset -e\nnpm publish $TAG\n'],
  ]),
};
