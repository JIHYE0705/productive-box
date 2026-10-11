const assert = require('assert').strict;
const { readFileSync } = require('fs');
const { resolve } = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const ts = require('typescript');

function load(name, context) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(resolve(__dirname, '../src', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  }).outputText;
  const completion = vm.runInNewContext(code, { ...context, exports, __dirname });
  return { exports, completion };
}

async function run(options = {}) {
  const updates = [];
  const errors = [];
  const logs = [];
  const process = { env: { GH_TOKEN: 'test-token', GIST_ID: 'test-gist', TIMEZONE: 'Asia/Seoul', ...options.env } };
  const context = { process, console: { log: message => logs.push(message), error: message => errors.push(message) } };
  context.require = name => {
    if (name === 'path') return require('path');
    if (name === 'dotenv') return { config() {} };
    if (name === 'node-fetch') return { default: async (_url, request) => {
      const { query } = JSON.parse(request.body);
      let data;
      if (query.includes('viewer')) data = { viewer: { login: 'tester', id: 'user-id' } };
      else if (query.includes('repositoriesContributedTo')) {
        assert(query.includes('includeUserRepositories: true'));
        data = { user: { repositoriesContributedTo: { nodes: ['main', 'master', 'empty'].map(name => ({ name, isFork: false, owner: { login: 'tester' } })) } } };
      } else {
        assert(query.includes('defaultBranchRef'));
        assert(!query.includes('qualifiedName: "master"'));
        data = { repository: { defaultBranchRef: options.zero || query.includes('name: "empty"') ? null : {
          target: { history: { edges: [{ node: { committedDate: query.includes('name: "main"') ? '2026-10-10T03:06:56Z' : '2026-10-10T12:00:00Z' } }] } },
        } } };
      }
      if (options.network) throw new Error('Network unavailable');
      return { ok: !options.http, status: 401, json: async () => options.graphql ? { errors: [{ message: 'Access denied' }], data } : { data } };
    } };
    if (name === '@octokit/rest') return { Octokit: class {
      constructor() {
        this.gists = {
          get: async () => {
            if (options.getError) throw new Error('Gist read failed');
            return { data: { files: options.emptyGist ? {} : { stats: {} } } };
          },
          update: async update => {
            if (options.updateError) throw new Error('Gist write failed');
            updates.push(update);
          },
        };
      }
    } };
    if (name.startsWith('./')) return load(name.slice(2), context).exports;
    throw new Error('Unexpected import: ' + name);
  };
  await load('index', context).completion;
  return { updates, errors, logs, process };
}

(async () => {
  const success = await run();
  assert.equal(success.process.exitCode, undefined, success.errors.join('; '));
  assert.equal(success.updates.length, 1);
  const content = success.updates[0].files.stats.content;
  assert.match(content, /Daytime\s+1 commits.*50\.0%/);
  assert.match(content, /Evening\s+1 commits.*50\.0%/);
  assert(success.logs.includes('Gist updated successfully'));

  for (const [options, message] of [
    [{ http: true }, 'HTTP 401'],
    [{ graphql: true }, 'Access denied'],
    [{ network: true }, 'Network unavailable'],
    [{ zero: true }, 'No commits found'],
    [{ getError: true }, 'Gist read failed'],
    [{ updateError: true }, 'Gist write failed'],
    [{ emptyGist: true }, 'Gist has no files'],
    [{ env: { GH_TOKEN: '' } }, 'GH_TOKEN and GIST_ID are required'],
    [{ env: { GIST_ID: '' } }, 'GH_TOKEN and GIST_ID are required'],
  ]) {
    const failed = await run(options);
    assert.equal(failed.process.exitCode, 1);
    assert.equal(failed.updates.length, 0);
    assert(failed.errors.some(error => error.includes(message)), message);
    assert(!failed.logs.includes('Gist updated successfully'));
  }

  const bundle = readFileSync(resolve(__dirname, '../dist/index.js'), 'utf8');
  assert(bundle.startsWith('module.exports='), 'Actions requires the bundled dependencies');
  assert(bundle.includes('defaultBranchRef'), 'Rebuild the Actions bundle');
  assert(!bundle.includes('ref(qualifiedName: "master")'), 'Bundle still queries master');
  const smoke = spawnSync(process.execPath, [resolve(__dirname, '../dist/index.js')], {
    env: { ...process.env, GH_TOKEN: '', GIST_ID: '' }, encoding: 'utf8',
  });
  assert.equal(smoke.status, 1, smoke.stderr);
  assert.match(smoke.stderr, /GH_TOKEN and GIST_ID are required/);
  console.log('Passed: default-branch aggregation, empty repository, failure handling, and bundle checks');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
