import { readFile } from 'node:fs/promises';

export const ENV_KEYS = {
  concurrency: 'SUPABASE_HEARTBEAT_CONCURRENCY',
  databaseUrls: 'SUPABASE_DATABASE_URLS',
  heartbeatId: 'SUPABASE_HEARTBEAT_ID',
};

export const DEFAULT_SQL_DIR = new URL('../sql/', import.meta.url);
export const TRANSACTION_POOLER_PORT = '6543';
export const CONNECT_TIMEOUT_MS = 15000;
export const STATEMENT_TIMEOUT_MS = 15000;

export async function loadSql(sqlDir = DEFAULT_SQL_DIR) {
  const [setupSql, pingSql] = await Promise.all([
    readFile(new URL('setup.sql', sqlDir), 'utf8'),
    readFile(new URL('ping.sql', sqlDir), 'utf8'),
  ]);

  return { pingSql, setupSql };
}

export function parseDatabaseUrlLine(rawLine) {
  const trimmedLine = rawLine.trim();

  if (trimmedLine === '' || trimmedLine.startsWith('#')) {
    return '';
  }

  const quote = trimmedLine[0];

  if (quote === '"' || quote === "'") {
    const closingQuoteIndex = trimmedLine.indexOf(quote, 1);

    if (closingQuoteIndex === -1) {
      return trimmedLine.slice(1).trim();
    }

    return trimmedLine.slice(1, closingQuoteIndex).trim();
  }

  return trimmedLine.split('#', 1)[0].trim();
}

export function parseDatabaseUrls(rawValue, secretName = ENV_KEYS.databaseUrls) {
  if (!rawValue || rawValue.trim() === '') {
    throw new Error(`${secretName} must contain at least one PostgreSQL URL`);
  }

  const targets = [];
  const warnings = [];

  rawValue.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const connectionString = parseDatabaseUrlLine(rawLine);

    if (connectionString === '') {
      return;
    }

    if (!connectionString.startsWith('postgres://') && !connectionString.startsWith('postgresql://')) {
      throw new Error(`invalid ${secretName} line ${lineNumber}: expected a PostgreSQL URL`);
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(connectionString);
    } catch {
      throw new Error(`invalid ${secretName} line ${lineNumber}: malformed PostgreSQL URL`);
    }

    if (!parsedUrl.hostname) {
      throw new Error(`invalid ${secretName} line ${lineNumber}: missing host`);
    }

    const target = {
      connectionString,
      index: targets.length + 1,
      label: `project ${targets.length + 1}`,
      lineNumber,
    };

    if (parsedUrl.port === TRANSACTION_POOLER_PORT) {
      warnings.push(`${target.label}: line ${lineNumber} uses port ${TRANSACTION_POOLER_PORT}; prefer the session pooler on port 5432`);
    }

    targets.push(target);
  });

  if (targets.length === 0) {
    throw new Error(`${secretName} must contain at least one PostgreSQL URL`);
  }

  return { targets, warnings };
}

export function getConcurrency(rawValue) {
  if (!rawValue || rawValue.trim() === '') {
    throw new Error(`${ENV_KEYS.concurrency} must be a positive integer`);
  }

  const trimmedValue = rawValue.trim();

  if (!/^\d+$/.test(trimmedValue)) {
    throw new Error(`${ENV_KEYS.concurrency} must be a positive integer`);
  }

  const parsedValue = Number.parseInt(trimmedValue, 10);

  if (parsedValue < 1) {
    throw new Error(`${ENV_KEYS.concurrency} must be a positive integer`);
  }

  return parsedValue;
}

export function getHeartbeatId(rawValue) {
  if (!rawValue || rawValue.trim() === '') {
    throw new Error(`${ENV_KEYS.heartbeatId} must not be empty`);
  }

  return rawValue.trim();
}

export function getClientConfig(connectionString) {
  const parsedUrl = new URL(connectionString);

  // pg-connection-string maps sslmode=require to verify-full, which rejects Supabase's
  // self-signed CA chain. Drop sslmode from the URL and drive TLS through the ssl option
  // so the connection stays encrypted without requiring chain verification.
  parsedUrl.searchParams.delete('sslmode');

  return {
    application_name: 'supabase-heartbeat',
    connectionString: parsedUrl.toString(),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ssl: { rejectUnauthorized: false },
    statement_timeout: STATEMENT_TIMEOUT_MS,
  };
}

export function redactText(value, connectionStrings = []) {
  let text = String(value);
  const passwords = new Set();

  for (const connectionString of connectionStrings) {
    text = text.split(connectionString).join('[redacted-url]');

    try {
      const parsedUrl = new URL(connectionString);

      if (parsedUrl.password) {
        passwords.add(parsedUrl.password);
        passwords.add(decodeURIComponent(parsedUrl.password));
      }
    } catch {
      continue;
    }
  }

  for (const password of passwords) {
    text = text.split(password).join('[redacted-password]');
  }

  return text;
}

export function formatError(error, connectionStrings = []) {
  if (!error) {
    return 'unknown error';
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? ` (${error.code})` : '';

  return redactText(`${message}${code}`, connectionStrings);
}

export async function runTarget(target, Client, { heartbeatId, sql }) {
  const client = new Client(getClientConfig(target.connectionString));
  let failure;

  try {
    await client.connect();
    await client.query(sql.setupSql);
    await client.query(sql.pingSql, [heartbeatId]);
  } catch (error) {
    failure = error;
  }

  try {
    await client.end();
  } catch (error) {
    failure ??= error;
  }

  if (failure) {
    throw failure;
  }
}

export async function loadPgClient() {
  const pg = await import('pg');
  return pg.Client ?? pg.default.Client;
}

export async function runHeartbeat({
  Client,
  env = process.env,
  logger = console,
} = {}) {
  const { targets, warnings } = parseDatabaseUrls(env[ENV_KEYS.databaseUrls]);
  const concurrency = Math.min(getConcurrency(env[ENV_KEYS.concurrency]), targets.length);
  const heartbeatId = getHeartbeatId(env[ENV_KEYS.heartbeatId]);
  const PgClient = Client ?? await loadPgClient();
  const sql = await loadSql();
  const connectionStrings = targets.flatMap((target) => [
    target.connectionString,
    getClientConfig(target.connectionString).connectionString,
  ]);
  const results = new Array(targets.length);
  let nextTargetIndex = 0;

  for (const warning of warnings) {
    logger.warn(warning);
  }

  async function work() {
    while (nextTargetIndex < targets.length) {
      const target = targets[nextTargetIndex];
      const resultIndex = nextTargetIndex;
      nextTargetIndex += 1;

      try {
        await runTarget(target, PgClient, { heartbeatId, sql });
        logger.info(`${target.label} ok`);
        results[resultIndex] = { ok: true, target };
      } catch (error) {
        logger.error(`${target.label} failed: ${formatError(error, connectionStrings)}`);
        results[resultIndex] = { error, ok: false, target };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => work()));

  const failed = results.filter((result) => !result.ok).length;
  const succeeded = results.length - failed;

  logger.info(`${succeeded} succeeded, ${failed} failed`);

  return {
    failed,
    ok: failed === 0,
    results,
    succeeded,
  };
}
