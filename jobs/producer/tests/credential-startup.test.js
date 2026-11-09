import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { consumerStartupCommand, projectCheckoutUrl } from '../paths/gke.js';

function executable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
}

// Exercise the real shell command with deterministic Python/git/awfl substitutes.
function exerciseStartup({ importStatus = '0', gitStatus = '0', githubFilePath } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'awfl-consumer-startup-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const actions = join(root, 'actions.txt');
  const googleFile = join(root, 'google.token');
  const githubFile = githubFilePath === 'unwritable'
    ? join(root, 'missing', 'github.token')
    : join(root, 'github.token');
  executable(join(bin, 'python'), [
    '#!/bin/sh',
    'if [ "$1" = "-c" ]; then exit "$PYTHON_IMPORT_STATUS"; fi',
    'if [ "$1" = "-m" ]; then echo "refresh-attempted" >> "$AWFL_TEST_ACTIONS"; exit 1; fi',
    'exit 99',
    '',
  ].join('\n'));
  executable(join(bin, 'git'), [
    '#!/bin/sh',
    'echo "git-helper-requested" >> "$AWFL_TEST_ACTIONS"',
    'exit "$GIT_CONFIG_STATUS"',
    '',
  ].join('\n'));
  executable(join(bin, 'awfl'), [
    '#!/bin/sh',
    'echo "awfl-run:$*:google-env=${CLOUDSDK_AUTH_ACCESS_TOKEN-unset}:google-file=${CLOUDSDK_AUTH_ACCESS_TOKEN_FILE-unset}:github-env=${GITHUB_TOKEN-unset}:github-file=${AWFL_GITHUB_TOKEN_FILE-unset}" >> "$AWFL_TEST_ACTIONS"',
    'exit 0',
    '',
  ].join('\n'));

  try {
    const result = spawnSync('sh', ['-lc', consumerStartupCommand({ refreshEnabled: true })], {
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        HOME: root,
        PYTHON_IMPORT_STATUS: importStatus,
        GIT_CONFIG_STATUS: gitStatus,
        AWFL_TEST_ACTIONS: actions,
        CLOUDSDK_AUTH_ACCESS_TOKEN: 'startup-google',
        CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: googleFile,
        GITHUB_TOKEN: 'startup-github',
        AWFL_GITHUB_TOKEN_FILE: githubFile,
      },
      encoding: 'utf8',
      timeout: 5000,
    });

    return {
      status: result.status,
      stderr: result.stderr,
      actions: existsSync(actions) ? readFileSync(actions, 'utf8') : '',
      googleContents: existsSync(googleFile) ? readFileSync(googleFile, 'utf8') : null,
      githubContents: existsSync(githubFile) ? readFileSync(githubFile, 'utf8') : null,
      googleMode: existsSync(googleFile) ? statSync(googleFile).mode & 0o777 : null,
      githubMode: existsSync(githubFile) ? statSync(githubFile).mode & 0o777 : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('failed background credential refresh never blocks consumer startup', () => {
  const run = exerciseStartup();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.actions, /awfl-run:run:google-env=unset/);
  assert.match(run.actions, /github-env=startup-github/);
  assert.match(run.actions, /git-helper-requested/);
  assert.equal(run.googleContents, 'startup-google\n');
  assert.equal(run.githubContents, 'startup-github\n');
  assert.equal(run.googleMode, 0o600);
  assert.equal(run.githubMode, 0o600);
});

test('older consumer image without refresher module keeps startup credentials', () => {
  const run = exerciseStartup({ importStatus: '1' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /lacks credential refresher/);
  assert.match(run.actions, /awfl-run:run:google-env=startup-google:google-file=unset/);
  assert.match(run.actions, /github-env=startup-github:github-file=unset/);
  assert.equal(run.googleContents, null);
  assert.equal(run.githubContents, null);
});

test('Git helper configuration error does not block startup', () => {
  const run = exerciseStartup({ gitStatus: '1' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /Git credential helper setup failed/);
  assert.match(run.actions, /awfl-run:run/);
});

test('failed GitHub token file staging preserves environment credential', () => {
  const run = exerciseStartup({ githubFilePath: 'unwritable' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /GitHub token staging failed/);
  assert.match(run.actions, /awfl-run:run/);
  assert.match(run.actions, /github-env=startup-github:github-file=unset/);
});

test('custom startup and non-refresh consumers keep existing behavior', () => {
  assert.equal(
    consumerStartupCommand({ startupSh: 'custom start', refreshEnabled: true }),
    'custom start',
  );
  assert.equal(
    consumerStartupCommand({ startupSh: 'awfl run', refreshEnabled: false }),
    'awfl run',
  );
});


test('GitHub remotes normalize for checkout; untrusted/non-GitHub strings are rejected', () => {
  assert.equal(projectCheckoutUrl('github.com:awfl-us/server.git'), 'https://github.com/awfl-us/server.git');
  assert.equal(projectCheckoutUrl('github.com/awfl-us/server.git'), 'https://github.com/awfl-us/server.git');
  assert.equal(projectCheckoutUrl('https://github.com/awfl-us/server'), 'https://github.com/awfl-us/server.git');
  assert.equal(projectCheckoutUrl('git@github.com:awfl-us/server.git'), 'https://github.com/awfl-us/server.git');
  for (const invalid of ['https://evil.example/repo.git', 'github.com/owner/repo;echo hacked',
    'github.com/owner/repo name', '', undefined]) {
    assert.equal(projectCheckoutUrl(invalid), null);
  }
});

test('project checkout is nonfatal and uses standard GKE consumer startup', () => {
  const command = consumerStartupCommand({ refreshEnabled: true, checkoutEnabled: true });
  assert.match(command, /git clone --quiet/);
  assert.match(command, /GIT_TERMINAL_PROMPT=0/);
  assert.match(command, /project clone unavailable; shell remains usable/);
  assert.match(command, /exec awfl run$/);
  const withoutRefresh = consumerStartupCommand({ refreshEnabled: false, checkoutEnabled: true });
  assert.match(withoutRefresh, /git clone --quiet/);
  assert.match(withoutRefresh, /exec awfl run$/);
});
