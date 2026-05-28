import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECT_TIMEOUT_MS,
  ENV_KEYS,
  getClientConfig,
  getConcurrency,
  getHeartbeatId,
  loadSql,
  parseDatabaseUrlLine,
  parseDatabaseUrls,
  redactText,
  runHeartbeat,
  STATEMENT_TIMEOUT_MS,
} from '../scripts/heartbeat-lib.mjs';

test('parses URL list comments like dotenv values', () => {
  assert.equal(
    parseDatabaseUrlLine('postgresql://postgres.project:password@pooler.example.com:5432/postgres?sslmode=require # comment'),
    'postgresql://postgres.project:password@pooler.example.com:5432/postgres?sslmode=require',
  );
  assert.equal(
    parseDatabaseUrlLine('postgresql://postgres.project:password@pooler.example.com:5432/postgres?sslmode=require#comment'),
    'postgresql://postgres.project:password@pooler.example.com:5432/postgres?sslmode=require',
  );
  assert.equal(
    parseDatabaseUrlLine('"postgresql://postgres.project:p%23ssword@pooler.example.com:5432/postgres?sslmode=require" # comment'),
    'postgresql://postgres.project:p%23ssword@pooler.example.com:5432/postgres?sslmode=require',
  );
  assert.equal(parseDatabaseUrlLine('  # comment'), '');
});

test('parses one PostgreSQL URL per non-empty line', () => {
  const rawValue = [
    '# Production',
    '',
    '  # Staging',
    'postgresql://postgres.project-a:password@pooler-a.example.com:5432/postgres?sslmode=require # production',
    'postgres://postgres.project-b:password@pooler-b.example.com:5432/postgres?sslmode=require#staging',
    '',
  ].join('\n');

  const parsed = parseDatabaseUrls(rawValue);

  assert.equal(parsed.targets.length, 2);
  assert.equal(parsed.targets[0].label, 'project 1');
  assert.equal(parsed.targets[0].lineNumber, 4);
  assert.equal(parsed.targets[1].label, 'project 2');
  assert.deepEqual(parsed.warnings, []);
});

test('rejects invalid config without echoing the line value', () => {
  const rawValue = 'not-a-url-with-secret-password';

  assert.throws(
    () => parseDatabaseUrls(rawValue),
    (error) => {
      assert.match(error.message, /line 1/);
      assert.doesNotMatch(error.message, /secret-password/);
      return true;
    },
  );
});

test('warns when a URL uses the transaction pooler port', () => {
  const rawValue = 'postgresql://postgres.project:password@pooler.example.com:6543/postgres?sslmode=require';

  const parsed = parseDatabaseUrls(rawValue);

  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /6543/);
  assert.match(parsed.warnings[0], /5432/);
});

test('connects over TLS without verifying the certificate chain', () => {
  const config = getClientConfig('postgresql://postgres.project:password@pooler.example.com:5432/postgres');

  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
  assert.equal(config.application_name, 'supabase-heartbeat');
});

test('strips sslmode so it cannot be reinterpreted as verify-full', () => {
  const config = getClientConfig('postgresql://postgres.project:password@pooler.example.com:5432/postgres?sslmode=require');

  assert.equal(new URL(config.connectionString).searchParams.has('sslmode'), false);
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
});

test('bounds connect and statement time on the client config', () => {
  const config = getClientConfig('postgresql://postgres.project:password@pooler.example.com:5432/postgres');

  assert.equal(config.connectionTimeoutMillis, CONNECT_TIMEOUT_MS);
  assert.equal(config.statement_timeout, STATEMENT_TIMEOUT_MS);
});

test('parses explicit concurrency', () => {
  assert.equal(getConcurrency('7'), 7);
  assert.throws(() => getConcurrency(), /SUPABASE_HEARTBEAT_CONCURRENCY/);
  assert.throws(() => getConcurrency('0'), /positive integer/);
  assert.throws(() => getConcurrency('7abc'), /positive integer/);
});

test('parses the heartbeat id from env', () => {
  assert.equal(getHeartbeatId(' github-actions '), 'github-actions');
  assert.throws(() => getHeartbeatId(''), /SUPABASE_HEARTBEAT_ID/);
});

test('redacts raw URLs and passwords from text', () => {
  const connectionString = 'postgresql://postgres.project:s%40cret@pooler.example.com:5432/postgres?sslmode=require';

  const redacted = redactText(`failed for ${connectionString} with password s@cret`, [connectionString]);

  assert.doesNotMatch(redacted, /postgresql:\/\//);
  assert.doesNotMatch(redacted, /s%40cret/);
  assert.doesNotMatch(redacted, /s@cret/);
});

test('continues after a project fails and reports overall failure', async () => {
  const sql = await loadSql();
  const rawValue = [
    'postgresql://postgres.ok:password@ok.example.com:5432/postgres?sslmode=require',
    'postgresql://postgres.fail:secret@fail.example.com:5432/postgres?sslmode=require',
    'postgresql://postgres.other:password@other.example.com:5432/postgres?sslmode=require',
  ].join('\n');
  const connectAttempts = [];
  const queries = [];

  class FakeClient {
    constructor(config) {
      this.config = config;
    }

    async connect() {
      connectAttempts.push(this.config.connectionString);

      if (this.config.connectionString.includes('fail.example.com')) {
        throw new Error(`could not connect to ${this.config.connectionString}`);
      }
    }

    async query(sql, values) {
      queries.push({ sql, values });
    }

    async end() {}
  }

  const logs = {
    errors: [],
    infos: [],
    warnings: [],
  };

  const result = await runHeartbeat({
    Client: FakeClient,
    env: {
      [ENV_KEYS.concurrency]: '2',
      [ENV_KEYS.databaseUrls]: rawValue,
      [ENV_KEYS.heartbeatId]: 'github-actions',
    },
    logger: {
      error: (message) => logs.errors.push(message),
      info: (message) => logs.infos.push(message),
      warn: (message) => logs.warnings.push(message),
    },
  });

  assert.equal(connectAttempts.length, 3);
  assert.equal(result.ok, false);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(queries.filter((query) => query.sql === sql.setupSql).length, 2);
  assert.equal(queries.filter((query) => query.sql === sql.pingSql).length, 2);
  assert.match(logs.errors[0], /project 2 failed/);
  assert.doesNotMatch(logs.errors[0], /postgresql:\/\//);
  assert.doesNotMatch(logs.errors[0], /secret/);
  assert.deepEqual(logs.warnings, []);
});

test('loads SQL files from disk', async () => {
  const sql = await loadSql();

  assert.match(sql.setupSql, /CREATE SCHEMA IF NOT EXISTS heartbeat/);
  assert.match(sql.pingSql, /INSERT INTO heartbeat\.pings/);
});
