import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = 'v2.5.1';
const BINARIES = {
  'linux-x64': [
    'linux_amd64',
    'f9f25499a2c8cc367b3af45df2ea7eeca7fbccceab9c35079968f4b3652194be',
  ],
  'darwin-arm64': [
    'darwin_arm64',
    '75c44d6332f892a1e56286f4105a98ed751ae28d215ca0a8b65cc00d84103054',
  ],
};

export function verifyOsvReport(lock, report) {
  assert(
    lock.lockfileVersion >= 2 && lock.packages,
    'A versioned npm lockfile is required',
  );
  const expected = new Set(
    Object.entries(lock.packages)
      .filter(([path, entry]) => path.includes('node_modules/') && !entry.link)
      .map(
        ([path, entry]) =>
          `${entry.name ?? path.split('node_modules/').at(-1)}@${entry.version}`,
      ),
  );
  assert(expected.size > 0, 'Refusing an empty dependency scan');
  assert(Array.isArray(report.results), 'Missing OSV scan results');
  const scanned = new Set();
  const findings = [];
  for (const source of report.results) {
    assert(Array.isArray(source.packages), 'Malformed OSV package results');
    for (const item of source.packages) {
      if (item.package?.ecosystem === 'npm')
        scanned.add(`${item.package.name}@${item.package.version}`);
      for (const vuln of item.vulnerabilities ?? []) {
        const group = item.groups?.find((candidate) =>
          candidate.ids?.includes(vuln.id),
        );
        const raw = group?.max_severity;
        const score =
          typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        const knownScore = Number.isFinite(score) && score >= 0 && score <= 10;
        const severity = vuln.database_specific?.severity?.toUpperCase();
        const knownSeverity = [
          'LOW',
          'MODERATE',
          'MEDIUM',
          'HIGH',
          'CRITICAL',
        ].includes(severity);
        assert(
          knownScore || knownSeverity,
          `Unclassified vulnerability: ${vuln.id}`,
        );
        findings.push({
          package: `${item.package.name}@${item.package.version}`,
          id: vuln.id,
          severity,
          score: knownScore ? score : null,
        });
        assert(
          !(knownScore && score >= 7) &&
            severity !== 'HIGH' &&
            severity !== 'CRITICAL',
          `High/critical vulnerability: ${vuln.id}`,
        );
      }
    }
  }
  for (const dependency of expected)
    assert(
      scanned.has(dependency),
      `Incomplete OSV scan: missing ${dependency}`,
    );
  return { packages: expected.size, findings };
}

export async function auditDependencies() {
  const directory = resolve('artifacts/dependency-audit');
  await mkdir(directory, { recursive: true });
  const lockText = await readFile('package-lock.json', 'utf8');
  const lock = JSON.parse(lockText);
  const lockSha256 = createHash('sha256').update(lockText).digest('hex');
  const npm = spawnSync(
    'npm',
    [
      'audit',
      '--json',
      '--audit-level=high',
      '--fetch-timeout=20000',
      '--fetch-retries=0',
    ],
    {
      encoding: 'utf8',
      timeout: 45000,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  await writeFile(join(directory, 'npm.json'), npm.stdout || '{}');
  let report;
  try {
    report = JSON.parse(npm.stdout);
  } catch {
    /* The independent scan below remains mandatory. */
  }
  // A known vulnerability result is never reinterpreted as a service outage.
  const counts = report?.metadata?.vulnerabilities;
  assert(
    !Object.values(report?.vulnerabilities ?? {}).some((v) =>
      ['high', 'critical'].includes(v.severity),
    ),
    'npm reported high/critical vulnerabilities',
  );
  assert(
    !(counts?.high > 0 || counts?.critical > 0),
    'npm reported high/critical vulnerabilities',
  );
  if (
    !npm.error &&
    !report?.error &&
    report?.auditReportVersion === 2 &&
    counts?.high === 0 &&
    counts?.critical === 0 &&
    [0, 1].includes(npm.status)
  ) {
    await writeFile(
      join(directory, 'summary.json'),
      JSON.stringify({ scanner: 'npm', lockSha256, counts }, null, 2),
    );
    console.log(
      'PASS: npm dependency audit (no high/critical vulnerabilities).',
    );
    return;
  }
  console.warn(
    'npm did not produce a complete audit; requiring an independent, full-lockfile OSV scan.',
  );
  const spec = BINARIES[`${process.platform}-${process.arch}`];
  assert(spec, 'No pinned OSV binary for this platform');
  const temporary = await mkdtemp(join(tmpdir(), 'inkwell-audit-'));
  try {
    const response = await fetch(
      `https://github.com/google/osv-scanner/releases/download/${VERSION}/osv-scanner_${spec[0]}`,
      { signal: AbortSignal.timeout(60000) },
    );
    assert(response.ok, `OSV download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      spec[1],
      'OSV binary checksum mismatch',
    );
    const binary = join(temporary, 'osv-scanner');
    await writeFile(binary, bytes);
    await chmod(binary, 0o700);
    const output = join(directory, 'osv.json');
    // Remove only this previous scan result: stale reports cannot pass a failed scan.
    await rm(output, { force: true });
    const scan = spawnSync(
      binary,
      [
        'scan',
        'source',
        '--lockfile',
        resolve('package-lock.json'),
        '--format',
        'json',
        '--all-packages',
        '--all-vulns',
        '--output-file',
        output,
      ],
      {
        encoding: 'utf8',
        timeout: 120000,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    assert(
      !scan.error && [0, 1].includes(scan.status),
      'OSV failed or timed out; security gate remains closed',
    );
    const summary = verifyOsvReport(
      lock,
      JSON.parse(await readFile(output, 'utf8')),
    );
    assert.equal(
      createHash('sha256')
        .update(await readFile('package-lock.json'))
        .digest('hex'),
      lockSha256,
      'Lockfile changed during audit',
    );
    await writeFile(
      join(directory, 'summary.json'),
      JSON.stringify(
        { scanner: `OSV ${VERSION}`, lockSha256, ...summary },
        null,
        2,
      ),
    );
    console.log(
      `PASS: OSV scanned all ${summary.packages} locked dependencies; no high/critical vulnerabilities. ${summary.findings.length} lower-severity findings retained in artifacts/dependency-audit.`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await auditDependencies();
