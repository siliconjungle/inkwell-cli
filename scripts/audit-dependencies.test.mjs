import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyOsvReport } from './audit-dependencies.mjs';

const lock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/example': { version: '1.2.3' },
    'node_modules/local': { link: true, resolved: 'packages/local' },
  },
};
const report = (score, severity) => ({
  results: [
    {
      packages: [
        {
          package: { ecosystem: 'npm', name: 'example', version: '1.2.3' },
          vulnerabilities:
            score === undefined
              ? []
              : [{ id: 'TEST-1', database_specific: { severity } }],
          groups: [{ ids: ['TEST-1'], max_severity: score }],
        },
      ],
    },
  ],
});

void test('complete clean/lower-severity scans pass the existing high threshold', () => {
  assert.equal(verifyOsvReport(lock, report()).packages, 1);
  assert.equal(
    verifyOsvReport(lock, report('5.3', 'MODERATE')).findings.length,
    1,
  );
});
void test('high, critical, unknown, incomplete and wrong-ecosystem scans fail closed', () => {
  for (const input of [
    report('7.0', 'MODERATE'),
    report('5.3', 'HIGH'),
    report('9.8', 'CRITICAL'),
    report('', undefined),
    { results: [] },
    {},
  ])
    assert.throws(() => verifyOsvReport(lock, input));
  const input = report();
  input.results[0].packages[0].package.ecosystem = 'PyPI';
  assert.throws(() => verifyOsvReport(lock, input));
  assert.throws(() =>
    verifyOsvReport({ lockfileVersion: 3, packages: {} }, report()),
  );
});
