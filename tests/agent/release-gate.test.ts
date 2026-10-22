import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

type Request = { tag: string; sha: string; version: string };
type Body = Record<string, unknown>;
type Api = (method: string, path: string, body?: Body, allowMissing?: boolean) => Promise<unknown>;
type Reference = { object: { type: 'commit' | 'tag'; sha: string } };
type Call = { method: string; path: string; body?: Body; allowMissing?: boolean };
const moduleUrl = new URL('../../scripts/release-gate.mjs', import.meta.url);
const { validateRequest, verifyRelease, publishRelease } = await import(moduleUrl.href) as {
  validateRequest(environment: NodeJS.ProcessEnv, inputs: unknown): Request;
  verifyRelease(request: Request, api: Api): Promise<{ reference: Reference | null }>;
  publishRelease(request: Request, api: Api): Promise<Body>;
};
const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40), annotationSha = 'c'.repeat(40);
const inputs = { tag: 'v0.3.2', commit_sha: sha };
const request: Request = { tag: inputs.tag, sha, version: '0.3.2' };
const environment: NodeJS.ProcessEnv = {
  GITHUB_REPOSITORY: 'BizAgentOS/context-os', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'NoraJing', GITHUB_ACTOR_ID: '46467776',
  GITHUB_TRIGGERING_ACTOR: 'NoraJing',
};
const tagPath = `/git/ref/tags/${inputs.tag}`;
const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

function fixture(options: {
  comparison?: string; version?: string; reference?: Reference | null;
  existingRelease?: Body; pages?: Body[][];
  annotations?: Map<string, Reference>;
  override?: (call: Call) => unknown;
} = {}) {
  const calls: Call[] = [];
  let reference = options.reference ?? null;
  const annotations = options.annotations ?? new Map<string, Reference>();
  const api: Api = async (method, path, body, allowMissing) => {
    const call = { method, path, body, allowMissing }; calls.push(call);
    const override = options.override?.(call);
    if (override !== undefined) return override;
    if (method === 'GET') {
      if (path === `/git/commits/${sha}`) return { sha };
      if (path === `/compare/${sha}...main`) return { status: options.comparison ?? 'ahead' };
      if (path === `/contents/package.json?ref=${sha}`) return {
        type: 'file', encoding: 'base64',
        content: Buffer.from(JSON.stringify({ version: options.version ?? request.version })).toString('base64'),
      };
      if (path === `/releases/tags/${inputs.tag}`) return options.existingRelease ?? null;
      const page = /^\/releases\?per_page=100&page=(\d+)$/.exec(path);
      if (page) return options.pages?.[Number(page[1]) - 1] ?? [];
      if (path === tagPath) return reference;
      if (path.startsWith('/git/tags/')) {
        const annotation = annotations.get(path.slice('/git/tags/'.length));
        if (!annotation) throw new Error(`Unknown annotated tag: ${path}`);
        return annotation;
      }
    }
    if (method === 'POST' && path === '/git/tags') {
      annotations.set(annotationSha, { object: { type: 'commit', sha: String(body?.object) } });
      return { sha: annotationSha };
    }
    if (method === 'POST' && path === '/git/refs') {
      reference = { object: { type: 'tag', sha: String(body?.sha) } };
      return reference;
    }
    if (method === 'POST' && path === '/releases') return {
      ...body, id: 1, html_url: `https://github.com/BizAgentOS/context-os/releases/tag/${inputs.tag}`,
    };
    throw new Error(`Unexpected mock request: ${method} ${path}`);
  };
  return { api, calls, reference: () => reference };
}

test('release gate accepts NoraJing only with the bound ID and actual triggering actor', () => {
  assert.deepEqual(validateRequest(environment, inputs), request);
  assert.deepEqual(validateRequest(environment, { tag: ' v0.3.2 ', commit_sha: sha.toUpperCase() }), request);
});

for (const [name, change] of Object.entries({
  administrator: { GITHUB_ACTOR: 'poppersamhar', GITHUB_ACTOR_ID: '1', GITHUB_TRIGGERING_ACTOR: 'poppersamhar' },
  'root actor': { GITHUB_ACTOR: 'root' },
  'wrong immutable ID': { GITHUB_ACTOR_ID: '1' },
  'missing immutable ID': { GITHUB_ACTOR_ID: undefined },
  'someone else rerunning Nora workflow': { GITHUB_TRIGGERING_ACTOR: 'poppersamhar' },
  'non-main branch': { GITHUB_REF: 'refs/heads/feature/release' },
  'tag invocation': { GITHUB_REF: 'refs/tags/v0.3.2' },
  'non-manual event': { GITHUB_EVENT_NAME: 'push' },
  'another repository': { GITHUB_REPOSITORY: 'someone/context-os' },
})) {
  test(`release gate rejects ${name}`, () => {
    assert.throws(() => validateRequest({ ...environment, ...change }, inputs), /Only NoraJing/);
  });
}

test('release gate rejects malformed, prerelease and shell-like tags and incomplete SHAs', () => {
  for (const tag of ['', '0.3.2', 'v01.3.2', 'v0.3', 'v0.3.2-rc.1', 'v0.3.2+build', 'v0.3.2;echo bad', 'v0.3.2/other']) {
    assert.throws(() => validateRequest(environment, { ...inputs, tag }), /stable semantic version/);
  }
  for (const commit_sha of ['', 'main', sha.slice(0, 7), 'g'.repeat(40), `${sha};echo bad`]) {
    assert.throws(() => validateRequest(environment, { ...inputs, commit_sha }), /complete reviewed 40-character/);
  }
  assert.throws(() => validateRequest(environment, undefined), /stable semantic version/);
});

test('read-only verification accepts reviewed ancestors or the exact main tip without writes', async () => {
  for (const comparison of ['ahead', 'identical']) {
    const mock = fixture({ comparison });
    assert.deepEqual(await verifyRelease(request, mock.api), { reference: null });
    assert.deepEqual(writes(mock.calls), []);
    assert(mock.calls.some((call) => call.path === `/contents/package.json?ref=${sha}`));
    assert(mock.calls.filter((call) => call.allowMissing).every((call) =>
      call.path === tagPath || call.path === `/releases/tags/${inputs.tag}`));
  }
});

test('release gate rejects commits outside main history, mismatched commit responses and versions', async () => {
  for (const comparison of ['behind', 'diverged', 'unknown']) {
    const mock = fixture({ comparison });
    await assert.rejects(publishRelease(request, mock.api), /present in main history/);
    assert.deepEqual(writes(mock.calls), []);
  }
  const wrongCommit = fixture({ override: ({ path }) => path === `/git/commits/${sha}` ? { sha: otherSha } : undefined });
  await assert.rejects(publishRelease(request, wrongCommit.api), /resolved exactly/);
  assert.deepEqual(writes(wrongCommit.calls), []);
  const wrongVersion = fixture({ version: '0.3.1' });
  await assert.rejects(publishRelease(request, wrongVersion.api), /does not match package.json version/);
  assert.deepEqual(writes(wrongVersion.calls), []);
});

test('release gate rejects malformed package responses before any publication', async () => {
  for (const manifest of [
    { type: 'dir', encoding: 'base64', content: '' },
    { type: 'file', encoding: 'utf8', content: '{}' },
    { type: 'file', encoding: 'base64' },
  ]) {
    const mock = fixture({ override: ({ path }) => path.startsWith('/contents/') ? manifest : undefined });
    await assert.rejects(publishRelease(request, mock.api), /Could not read package.json/);
    assert.deepEqual(writes(mock.calls), []);
  }
});

test('published releases are refused without modification', async () => {
  const mock = fixture({ existingRelease: { id: 42, tag_name: inputs.tag, draft: false } });
  await assert.rejects(publishRelease(request, mock.api), /release already exists/);
  assert.deepEqual(writes(mock.calls), []);
});

test('a draft hidden from the tag endpoint is refused even on the second listing page', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ tag_name: `v0.1.${index}`, draft: false }));
  const mock = fixture({ pages: [firstPage, [{ id: 43, tag_name: inputs.tag, draft: true }]] });
  await assert.rejects(publishRelease(request, mock.api), /release or draft already exists/);
  assert(mock.calls.some((call) => call.path === '/releases?per_page=100&page=2'));
  assert.deepEqual(writes(mock.calls), []);
});

test('malformed release lists and permission failures are never treated as absent releases', async () => {
  const malformed = fixture({ override: ({ path }) => path.startsWith('/releases?') ? {} : undefined });
  await assert.rejects(publishRelease(request, malformed.api), /Could not list existing releases/);
  assert.deepEqual(writes(malformed.calls), []);
  const denied = fixture({ override: ({ path }) => {
    if (path.startsWith('/releases/tags/')) throw new Error('HTTP 403');
  } });
  await assert.rejects(publishRelease(request, denied.api), /HTTP 403/);
  assert.deepEqual(writes(denied.calls), []);
});

test('existing lightweight and annotated tags pointing at another commit are never moved', async () => {
  const mocks = [
    fixture({ reference: { object: { type: 'commit', sha: otherSha } } }),
    fixture({ reference: { object: { type: 'tag', sha: annotationSha } },
      annotations: new Map([[annotationSha, { object: { type: 'commit', sha: otherSha } }]]) }),
  ];
  for (const mock of mocks) {
    await assert.rejects(publishRelease(request, mock.api), /will not be moved or reused/);
    assert.deepEqual(writes(mock.calls), []);
  }
});

test('new releases create an annotated tag, then its reference, then the exact reviewed SHA release', async () => {
  const mock = fixture();
  const result = await publishRelease(request, mock.api);
  const changes = writes(mock.calls);
  assert.deepEqual(changes.map(({ method, path }) => [method, path]), [
    ['POST', '/git/tags'], ['POST', '/git/refs'], ['POST', '/releases'],
  ]);
  assert.deepEqual(changes[0].body, {
    tag: inputs.tag, message: `Context OS ${inputs.tag}\nReviewed and approved by NoraJing.\nCommit: ${sha}`,
    object: sha, type: 'commit',
  });
  assert.deepEqual(changes[1].body, { ref: `refs/tags/${inputs.tag}`, sha: annotationSha });
  assert.equal(changes[2].body?.target_commitish, sha);
  assert.equal(changes[2].body?.tag_name, inputs.tag);
  assert.equal(changes[2].body?.draft, false);
  assert.equal(changes[2].body?.prerelease, false);
  assert.match(String(result.html_url), /\/releases\/tag\/v0\.3\.2$/);
  assert(mock.calls.at(-1)?.path === `/git/tags/${annotationSha}`);
});

test('existing same-SHA lightweight and nested annotated tags are reused without touching the tag', async () => {
  for (const mock of [
    fixture({ reference: { object: { type: 'commit', sha } } }),
    fixture({ reference: { object: { type: 'tag', sha: annotationSha } }, annotations: new Map([
      [annotationSha, { object: { type: 'tag', sha: otherSha } }],
      [otherSha, { object: { type: 'commit', sha } }],
    ]) }),
  ]) {
    await publishRelease(request, mock.api);
    assert.deepEqual(writes(mock.calls).map(({ method, path }) => [method, path]), [['POST', '/releases']]);
    assert.equal(writes(mock.calls)[0].body?.target_commitish, sha);
  }
});

test('publish repeats the checks and refuses an unexpected existing draft before its first write', async () => {
  const readOnly = fixture();
  await verifyRelease(request, readOnly.api);
  const publisher = fixture({ pages: [[{ tag_name: inputs.tag, draft: true }]] });
  await assert.rejects(publishRelease(request, publisher.api), /release or draft already exists/);
  assert.deepEqual(writes(readOnly.calls), []);
  assert.deepEqual(writes(publisher.calls), []);
});

test('a failed tag-reference creation never overwrites the tag or proceeds to publication', async () => {
  const mock = fixture({ override: ({ method, path }) => {
    if (method === 'POST' && path === '/git/refs') throw new Error('HTTP 422: tag exists');
  } });
  await assert.rejects(publishRelease(request, mock.api), /HTTP 422/);
  assert.deepEqual(writes(mock.calls).map(({ method, path }) => [method, path]), [
    ['POST', '/git/tags'], ['POST', '/git/refs'],
  ]);
});

test('an HTTP publication failure leaves the pinned tag intact and never deletes or overwrites anything', async () => {
  const mock = fixture({ override: ({ method, path }) => {
    if (method === 'POST' && path === '/releases') throw new Error('HTTP 403: publishing refused');
  } });
  await assert.rejects(publishRelease(request, mock.api), /HTTP 403/);
  assert.deepEqual(mock.reference(), { object: { type: 'tag', sha: annotationSha } });
  assert.deepEqual(writes(mock.calls).map(({ method, path }) => [method, path]), [
    ['POST', '/git/tags'], ['POST', '/git/refs'], ['POST', '/releases'],
  ]);
});

test('a competing tag change detected immediately before publication prevents a Release', async () => {
  let tagReads = 0;
  const mock = fixture({ reference: { object: { type: 'commit', sha } }, override: ({ method, path }) => {
    if (method === 'GET' && path === tagPath && ++tagReads === 2) return { object: { type: 'commit', sha: otherSha } };
  } });
  await assert.rejects(publishRelease(request, mock.api), /will not be moved or reused/);
  assert.deepEqual(writes(mock.calls), []);
});

test('workflow grants only read during verification and write only to guarded Nora publication', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')) as {
    on: Record<string, unknown>; permissions: Body;
    jobs: { verify: { permissions: Body }; publish: { needs: string; if: string; permissions: Body } };
  };
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.verify.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'write' });
  assert.equal(workflow.jobs.publish.needs, 'verify');
  for (const condition of ["github.actor == 'NoraJing'", "github.actor_id == '46467776'",
    "github.triggering_actor == 'NoraJing'", "github.ref == 'refs/heads/main'",
    "github.repository == 'BizAgentOS/context-os'", "github.event_name == 'workflow_dispatch'"]) {
    assert(workflow.jobs.publish.if.includes(condition), condition);
  }
});

test('CLI rejects the wrong actor before token or network access, and rejects missing tokens for Nora', () => {
  const directory = mkdtempSync(join(tmpdir(), 'context-os-release-gate-'));
  const eventPath = join(directory, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ inputs }));
  const noNetwork = 'data:text/javascript,' + encodeURIComponent(
    'globalThis.fetch = () => { process.stderr.write("NETWORK_ATTEMPT\\n"); process.exit(99); };',
  );
  try {
    const run = (overrides: NodeJS.ProcessEnv) => spawnSync(process.execPath,
      ['--import', noNetwork, fileURLToPath(moduleUrl), 'publish'], {
        env: { ...process.env, ...environment, GITHUB_EVENT_PATH: eventPath, GH_TOKEN: '', ...overrides },
        encoding: 'utf8', timeout: 5_000,
      });
    const refused = run({ GITHUB_ACTOR: 'poppersamhar', GITHUB_ACTOR_ID: '1' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Only NoraJing/);
    assert.doesNotMatch(refused.stderr, /NETWORK_ATTEMPT|token is missing/);
    const missingToken = run({});
    assert.equal(missingToken.status, 1);
    assert.match(missingToken.stderr, /workflow token is missing/);
    assert.doesNotMatch(missingToken.stderr, /NETWORK_ATTEMPT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI treats HTTP 403 as a failure rather than missing data, using a mocked fetch only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'context-os-release-gate-'));
  const eventPath = join(directory, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ inputs }));
  const deniedFetch = 'data:text/javascript,' + encodeURIComponent(
    'globalThis.fetch = async () => new Response("{}", { status: 403 });',
  );
  try {
    const result = spawnSync(process.execPath, ['--import', deniedFetch, fileURLToPath(moduleUrl), 'verify'], {
      env: { ...process.env, ...environment, GITHUB_EVENT_PATH: eventPath, GH_TOKEN: 'synthetic-test-token' },
      encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HTTP 403/);
    assert.doesNotMatch(result.stdout, /Verified|Published/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
