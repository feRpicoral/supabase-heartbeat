import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const rootDir = new URL('..', import.meta.url).pathname;

test('sync-gh-secret streams one-url-per-line config into one GitHub secret', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'supabase-heartbeat-'));
  const configPath = join(tmpDir, 'projects.env');
  const envPath = join(tmpDir, '.env');
  const bodyPath = join(tmpDir, 'body.txt');
  const argsPath = join(tmpDir, 'args.txt');
  const fakeGhPath = join(tmpDir, 'gh');
  const secretValue = [
    'postgresql://postgres.project-a:password@pooler-a.example.com:5432/postgres?sslmode=require',
    'postgresql://postgres.project-b:password@pooler-b.example.com:5432/postgres?sslmode=require',
  ].join('\n');

  await writeFile(configPath, `${secretValue}\n`);
  await writeFile(envPath, 'SUPABASE_DATABASE_URLS_SECRET_NAME=CUSTOM_DATABASE_URLS\n');
  await writeFile(fakeGhPath, [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$FAKE_GH_ARGS"',
    'cat > "$FAKE_GH_BODY"',
  ].join('\n'));
  chmodSync(fakeGhPath, 0o755);

  const result = spawnSync('bash', ['scripts/sync-gh-secret.sh', configPath], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_GH_ARGS: argsPath,
      FAKE_GH_BODY: bodyPath,
      PATH: `${tmpDir}:${process.env.PATH}`,
      SUPABASE_HEARTBEAT_ENV_FILE: envPath,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const args = await readFile(argsPath, 'utf8');
  const body = await readFile(bodyPath, 'utf8');

  assert.match(args, /secret\nset\nCUSTOM_DATABASE_URLS\n--app\nactions/);
  assert.equal(body, `${secretValue}\n`);
  assert.match(result.stdout, /updated CUSTOM_DATABASE_URLS with 2 PostgreSQL URL/);
  assert.doesNotMatch(result.stdout, /postgresql:\/\//);
});
