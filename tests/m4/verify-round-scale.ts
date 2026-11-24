import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { fixturePool } from './database.ts';

const [argument] = process.argv.slice(2);
const match = /^--run=(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/.exec(argument ?? '');
if (!match) throw new Error('用法：node tests/m4/verify-round-scale.ts --run=YYYY-MM-DDTHH-mm-ss-SSSZ');
const runId = match[1]!;
const directory = new URL('../../docs/development/evidence/', import.meta.url);
const reportName = `m4-performance-round-summary-${runId}.json`;
const reportBytes = await readFile(new URL(reportName, directory));
const report = JSON.parse(reportBytes.toString('utf8')) as {
  runId: string;
  inferredScaleAtEnd: Record<string, string>;
  scaleEvidence: { end: string };
};
assert.equal(report.runId, runId);
assert.equal(report.scaleEvidence.end, 'inferred-from-last-round-start-and-all-phase-mutations');
const pool = await fixturePool();
try {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT
    (SELECT COUNT(*) FROM expenses) expenses,
    (SELECT COUNT(*) FROM expense_versions) versions,
    (SELECT COUNT(*) FROM expense_shares) shares,
    (SELECT COUNT(*) FROM confirmed_transfers) confirmed,
    (SELECT COUNT(*) FROM transfer_requests) requests`);
  const observed = Object.fromEntries(Object.entries(rows[0]!).map(([name, value]) => [name, String(value)]));
  const matches = Object.fromEntries(Object.keys(report.inferredScaleAtEnd).map(name => [name, observed[name] === report.inferredScaleAtEnd[name]]));
  const evidence = {
    scope: 'heji_m4_bench只读实际终点计数与分轮推算值对账',
    runId,
    observed,
    inferred: report.inferredScaleAtEnd,
    matches,
    allMatch: Object.values(matches).every(Boolean),
    sourceReport: reportName,
    sourceReportSha256: createHash('sha256').update(reportBytes).digest('hex'),
    recordedAt: new Date().toISOString(),
    noDatabaseWrites: true,
  };
  const filename = `m4-round-scale-${runId}.json`;
  await writeFile(new URL(filename, directory), JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ filename, observed, inferred: report.inferredScaleAtEnd, allMatch: evidence.allMatch }, null, 2));
  if (!evidence.allMatch) process.exitCode = 1;
} finally {
  await pool.end();
}
