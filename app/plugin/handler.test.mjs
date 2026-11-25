import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginZip = fileURLToPath(new URL('../dist/aiapio-provider-0.1.0.zip', import.meta.url));
const manifest = JSON.parse(execFileSync('unzip', ['-p', pluginZip, 'aiapio-provider/manifest.json']));
const handler = execFileSync('unzip', ['-p', pluginZip, 'aiapio-provider/handler.js']);
const { generate } = await import(`data:text/javascript;base64,${handler.toString('base64')}`);
const { models } = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url)));
const SOURCE = 'https://example.com/material.png';
const VIDEO = 'https://example.com/material.mp4';
const AUDIO = 'https://example.com/material.wav';

/** Provide a mock of the documented host interfaces and record calls for assertions. */
function harness(input, replies, config = {}, signal) {
  const calls = [];
  const downloads = [];
  const tasks = [];
  const ctx = {
    input, config: { api_key: 'test-key', ...config }, signal,
    async fetch(url, options) {
      calls.push({ url: new URL(url), options, payload: options.body && JSON.parse(options.body) });
      const response = replies.shift();
      assert.ok(response, 'unexpected API request');
      if (response.throw) throw Error(response.throw);
      if (response.abort) response.abort();
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
    },
    onTaskCreated(id) { tasks.push(id); },
    async downloadToFile(...args) {
      downloads.push(args);
      return `local-media://generated.${args[1]}`;
    },
  };
  return { ctx, calls, downloads, tasks };
}

/** Build mocked submit and final status responses using the official runtime shapes. */
function success(kind) {
  return [
    { body: { task_id: 'task-sample', status: 'pending' } },
    { body: { type: kind, status: 'completed', is_final: true, output_url: kind === 'video' ? 'https://example.com/out.mp4' : 'https://example.com/out.jpg' } },
  ];
}

/** Choose a minimal supported example from a logical model's declared inputs. */
function sampleInput(model) {
  const modes = model.fields.mode?.enum ?? [];
  const required = Object.fromEntries(Object.entries(model.fields).map(([key, field]) => [key, field.required ? 1 : 0]));
  if (model.source_url) required[`${model.source_url}s`] = 1;
  if (model.kind === 'video' && !modes.includes('text-to-video') && modes.includes('reference') && !required.images && !required.videos) {
    required.images = 1;
  }
  return {
    model: model.id, type: model.kind, prompt: 'A paper sailboat against a plain background',
    referenceImages: Array(required.images ?? 0).fill(SOURCE),
    referenceVideos: Array(required.videos ?? 0).fill(VIDEO),
    referenceAudios: Array(required.audios ?? 0).fill(AUDIO),
  };
}

test('catalog models round-trip from plug-in ZIP to the documented host interfaces', async () => {
  assert.equal(manifest.kind, 'mixed');
  const checked = models.filter(model => !model.blocked);
  assert.deepEqual(new Set(manifest.models.map(model => model.id)), new Set(checked.map(model => model.id)));
  for (const model of checked) {
    const h = harness(sampleInput(model), success(model.kind));
    const result = await generate(h.ctx).catch(error => { throw new Error(`${model.id}: ${error.message}`); });
    assert.equal(result.taskId, 'task-sample');
    assert.equal(h.calls[0].payload.model_id, model.id);
    assert.equal(h.calls[0].url.pathname, '/api/v1/model-runtime/invoke');
    assert.equal(h.calls[1].url.pathname, '/v1/tasks/task-sample');
    assert.equal(h.calls[0].options.headers.Authorization, 'Bearer test-key');
    assert.equal(h.calls[0].options.redirect, 'error');
    assert.deepEqual(h.tasks, ['task-sample']);
    assert.equal(h.downloads[0].length, 2);
  }
});

test('normalizes canvas dimensions, preserves first and last frame order, and rejects mixed frame inputs', async () => {
  const input = { model: 'seedance-2-5', type: 'video', prompt: 'A sailboat moves', duration: 5,
    resolution: '480P', aspectRatio: '16:9', referenceImages: [SOURCE, 'https://example.com/end.png'] };
  const frames = harness(input, success('video'), { video_image_mode: 'first-last' });
  await generate(frames.ctx);
  assert.deepEqual(frames.calls[0].payload.params.images, input.referenceImages);
  assert.equal(frames.calls[0].payload.params.mode, 'first-last');
  assert.equal(frames.calls[0].payload.params.duration, '5');
  assert.equal(frames.calls[0].payload.params.resolution, '480p');
  const tooFew = harness({ ...input, referenceImages: [SOURCE] }, [], { video_image_mode: 'first-last' });
  await assert.rejects(generate(tooFew.ctx), /两张图/);
  const automatic = harness({ ...input, referenceVideos: [VIDEO] }, success('video'));
  await generate(automatic.ctx);
  assert.equal(automatic.calls[0].payload.params.mode, 'reference');
  const mixed = harness({ ...input, referenceVideos: [VIDEO] }, [], { video_image_mode: 'first-last' });
  await assert.rejects(generate(mixed.ctx), /不能同时添加/);
});

test('maps fixed image dimensions and denies unsupported sources before submission', async () => {
  const input = { model: 'gt-image-2-c', type: 'image', prompt: 'A boat', aspectRatio: '7:4' };
  const size = harness(input, success('image'));
  await generate(size.ctx);
  assert.equal(size.calls[0].payload.params.size, '1792x1024');
  const privateSource = harness({ ...input, referenceImages: ['http://127.0.0.1/private.png'] }, []);
  await assert.rejects(generate(privateSource.ctx), /公网/);
  assert.equal(privateSource.calls.length, 0);
});

test('resume and background handoff never submit a new generation', async () => {
  const resumed = harness({ type: 'image', resumeTaskId: 'task-sample' }, success('image').slice(1));
  await generate(resumed.ctx);
  assert.equal(resumed.calls.length, 1);
  assert.equal(resumed.calls[0].options.method, undefined);
  const background = harness({ model: 'gt-image-2-c', type: 'image', prompt: 'A boat' },
    [{ body: { error: { code: 'generation_continues_in_background', task_id: 'task-sample' } } }, ...success('image').slice(1)]);
  await generate(background.ctx);
  assert.equal(background.calls.filter(entry => entry.options.method === 'POST').length, 1);
});

test('unknown submission, account errors and download failure surface without secrets', async () => {
  const input = { model: 'gt-image-2-c', type: 'image', prompt: 'A boat' };
  const unknown = harness(input, [{ throw: 'private payload test-key' }]);
  await assert.rejects(generate(unknown.ctx), /^Error: 提交结果未知/);
  assert.equal(unknown.calls.length, 1);
  const noBalance = harness(input, [{ status: 402, body: { error: { message: 'test-key' } } }]);
  await assert.rejects(generate(noBalance.ctx), error => /余额不足/.test(error.message) && !error.message.includes('test-key'));
  const noAccess = harness(input, [{ status: 401, body: { error: { message: 'test-key' } } }]);
  await assert.rejects(generate(noAccess.ctx), /API Key 无效/);
  const download = harness(input, success('image'));
  download.ctx.downloadToFile = async () => { throw new Error('https://example.com/?signed=private'); };
  await assert.rejects(generate(download.ctx), error => /task-sample.*下载失败/.test(error.message) && !error.message.includes('signed='));
});

test('stopping a pending result keeps the upstream task and skips subsequent calls', async () => {
  const abort = new AbortController();
  const h = harness({ model: 'gk-imagine-1.5', type: 'video', prompt: 'A boat' }, [
    ...success('video').slice(0, 1), { abort: () => abort.abort(), body: { status: 'processing', is_final: false } },
  ], {}, abort.signal);
  await assert.rejects(generate(h.ctx), /已停止等待/);
  assert.deepEqual(h.tasks, ['task-sample']);
  assert.equal(h.calls.length, 2);
});

test('temporary polling failure and CDN transfer query the same generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ type: 'video', resumeTaskId: 'task-sample' }, [
    { status: 503, body: { error: { code: 'task_status_unavailable' } } },
    { body: { type: 'video', status: 'completed', is_final: true, cdn_pending: true } },
    ...success('video').slice(1),
  ]);
  const result = generate(h.ctx);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(6000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(4000);
  assert.equal((await result).taskId, 'task-sample');
  assert.deepEqual(h.calls.map(entry => entry.url.pathname), Array(3).fill('/v1/tasks/task-sample'));
});
