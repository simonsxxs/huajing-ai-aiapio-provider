const ORIGIN = 'https://aiapio.com';
const INVOKE = '/api/v1/model-runtime/invoke';
const MATERIALS = { images: '参考图', videos: '参考视频', audios: '参考音频' };
const PENDING = new Set(['pending', 'processing', 'needs_review']);

/** Convert a canvas input into a supported option with the API's original casing. */
function option(field, value, label) {
  if (value == null || value === '') return field.default;
  const requested = String(value).trim().toLowerCase();
  const candidates = field.enum ?? [];
  const match = candidates.find(candidate => String(candidate).toLowerCase() === requested);
  if (match !== undefined) return match;
  throw new Error(`所选模型不支持此${label}，请重新选择。`);
}

/** Accept media URLs suitable for remote processing without local paths or credentials. */
function mediaAddress(value, label) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) {
    throw new Error(`${label}需要公网 HTTP 或 HTTPS 地址。请重新添加素材。`);
  }
  let address;
  try {
    address = new URL(value);
  } catch {
    throw new Error(`${label}地址无效，请重新添加素材。`);
  }
  const hostname = address.hostname.toLowerCase().replace(/\.$/, '');
  const localAddress = !hostname.includes('.') || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    /^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(hostname);
  if (address.username || address.password || localAddress) {
    throw new Error(`${label}需要公网地址，请重新添加素材。`);
  }
  return value;
}

/** Read reference fields as arrays and validate their addresses before submission. */
function referenceList(values, label) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error(`${label}格式有误，请重新添加素材。`);
  return values.map(value => mediaAddress(value, label));
}

/** Derive modality mode from the selected model, reference media and frame preference. */
function selectMode(model, materials, preference) {
  const choices = model.fields.mode?.enum;
  if (!choices) return undefined;
  const { images, videos, audios } = materials;
  const hasReferences = images.length || videos.length || audios.length;
  if (model.kind === 'image') {
    if (images.length === 1 && choices.includes('image-edit')) return 'image-edit';
    if (images.length >= 1 && choices.includes('multi-reference')) return 'multi-reference';
    if (images.length >= 1 && choices.includes('image-edit')) return 'image-edit';
    if (!hasReferences && choices.includes('text-to-image')) return 'text-to-image';
    return model.fields.mode.default;
  }
  const frameChoices = choices.some(choice => ['first-frame', 'first-last', 'reference'].includes(choice));
  if (!frameChoices) return model.fields.mode.default;
  if (images.length && preference && preference !== 'auto' && preference !== 'reference' && (videos.length || audios.length)) {
    throw new Error('首帧或首尾帧用法不能同时添加参考视频或音频，请改用多素材参考或自动。');
  }
  if (!hasReferences) {
    if (choices.includes('text-to-video')) return 'text-to-video';
    throw new Error('此模型需要参考素材。请添加素材，或选择支持文生视频的模型。');
  }
  if (images.length && !videos.length && !audios.length && preference && preference !== 'auto') {
    if (!choices.includes(preference)) throw new Error('此模型不支持设置中的视频参考图用法，请改为「自动」或更换模型。');
    if (preference === 'first-frame' && images.length !== 1) throw new Error('首帧模式需要一张参考图。');
    if (preference === 'first-last' && images.length !== 2) throw new Error('首尾帧模式需要两张图，请按首帧、尾帧的顺序添加。');
    return preference;
  }
  if (videos.length || audios.length) {
    if (choices.includes('reference') && (!videos.length || model.fields.videos) && (!audios.length || model.fields.audios)) return 'reference';
    if (videos.length && choices.includes('edit')) return 'edit';
    throw new Error('此模型的生成模式不接受当前参考视频或参考音频。');
  }
  if (images.length === 1 && choices.includes('first-frame')) return 'first-frame';
  if (choices.includes('reference')) return 'reference';
  if (images.length === 2 && choices.includes('first-last')) return 'first-last';
  throw new Error('参考图数量不适用于此模型，请调整张数。');
}

/** Populate reference fields from the catalog, including single-source utility models. */
function applyMaterials(params, model, materials) {
  const { fields, source_url: sourceType } = model;
  if (sourceType) {
    const sources = materials[`${sourceType}s`];
    if (sources.length !== 1) throw new Error(`此处理模型需要一份${MATERIALS[`${sourceType}s`]}作为源文件。`);
    params.url = sources[0];
  }
  if (model.audio_requires_visual && materials.audios.length && !materials.images.length && !materials.videos.length) {
    throw new Error('此模型的参考音频需要搭配参考图或参考视频。');
  }
  for (const [name, values] of Object.entries(materials)) {
    if (sourceType && name === `${sourceType}s`) continue;
    const field = fields[name];
    if (!field) {
      if (values.length) throw new Error(`此模型不支持${MATERIALS[name]}。`);
      continue;
    }
    const min = field.min_items_by_mode?.[params.mode] ?? field.min_items ?? (field.required ? 1 : 0);
    const max = field.max_items_by_mode?.[params.mode] ?? field.max_items ?? Infinity;
    if (values.length < min) throw new Error(`此模式至少需要 ${min} 份${MATERIALS[name]}。`);
    if (values.length > max) throw new Error(`此模式最多接受 ${max} 份${MATERIALS[name]}。`);
    if (values.length) params[name] = values;
  }
}

/** Match a pixel size to an exact aspect ratio when the API offers only fixed sizes. */
function matchPixelSize(sizes, ratio) {
  const [horizontal, vertical] = String(ratio).split(':').map(Number);
  return sizes.find(size => {
    const [width, height] = size.split('x').map(Number);
    return width * vertical === height * horizontal;
  });
}

/** Translate independent canvas aspect ratio, resolution and duration into model fields. */
function applyDimensions(params, fields, input) {
  if (fields.aspect_ratio) params.aspect_ratio = option(fields.aspect_ratio, input.aspectRatio, '画幅');
  if (fields.resolution) params.resolution = option(fields.resolution, input.resolution, '分辨率');
  if (fields.duration && params.mode !== 'edit') params.duration = option(fields.duration, input.duration, '视频时长');
  if (!fields.size) return;
  const sizes = fields.size.enum ?? [];
  if (sizes.some(value => value.includes(':'))) {
    params.size = option(fields.size, input.aspectRatio, '画幅');
  } else if (sizes.some(value => /^\d+x\d+$/.test(value))) {
    params.size = input.aspectRatio ? matchPixelSize(sizes, input.aspectRatio) : fields.size.default;
    if (!params.size) throw new Error('此模型的固定像素尺寸不支持所选画幅，请重新选择。');
  } else if (sizes.some(value => /^[\d.]+k$/i.test(value))) {
    const requested = !fields.resolution || sizes.some(value => String(value).toLowerCase() === String(input.resolution).toLowerCase());
    params.size = option(fields.size, requested ? input.resolution : undefined, '尺寸');
  } else {
    params.size = fields.size.default;
  }
  if (fields.resolution && sizes.some(value => /^[\d.]+k$/i.test(value)) && !fields.size.required) {
    delete params.size;
  }
}

/** Construct the documented unified invocation for one canvas result. */
function invocation(model, input, config) {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new Error('请填写提示词，描述需要生成或处理的内容。');
  if ((model.max_prompt_chars && Array.from(prompt).length > model.max_prompt_chars) ||
      (model.max_prompt_bytes && new TextEncoder().encode(prompt).length > model.max_prompt_bytes)) {
    throw new Error('提示词超过此模型的长度限制，请缩短后重试。');
  }
  const materials = {
    images: referenceList(input.referenceImages, MATERIALS.images),
    videos: referenceList(input.referenceVideos, MATERIALS.videos),
    audios: referenceList(input.referenceAudios, MATERIALS.audios),
  };
  const params = { ...model.defaults, prompt };
  const mode = selectMode(model, materials, config.video_image_mode);
  if (mode) params.mode = mode;
  if (model.fields.count) params.count = 1;
  applyMaterials(params, model, materials);
  applyDimensions(params, model.fields, input);
  const payload = { model_id: model.id, modality: model.kind, params };
  if (model.kind === 'image') {
    payload.operation = mode === 'image-edit' || (!mode && materials.images.length) ? 'edit' : 'generate';
  }
  const requestId = globalThis.crypto?.randomUUID?.();
  if (requestId) payload.client_request_id = requestId;
  return payload;
}

/** Extract a non-secret task identifier suitable for a URL path and user feedback. */
function taskIdentifier(value) {
  return typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value) ? value : '';
}

/** Translate published error codes and HTTP status without echoing raw upstream data. */
function explainError(status, error) {
  const code = String(error?.code ?? error?.type ?? '').toLowerCase();
  if (status === 401 || /api_key|unauthorized|invalid_token/.test(code)) return 'API Key 无效或已失效，请在插件设置核对。';
  if (status === 402 || /balance|insufficient_quota|insufficient_credit/.test(code)) return 'AIAPIO 账户额度或余额不足，请检查账户。';
  if (status === 403 || /forbidden|permission|not_allowed/.test(code)) return '当前 AIAPIO 账户无此模型或渠道的权限。';
  if (status === 429 || /rate_limit/.test(code)) return 'AIAPIO 当前请求过多，请稍后再试。';
  if (status === 410 || /task_expired/.test(code)) return '任务记录已过保留期，请在 AIAPIO 作品库查看。';
  if (status === 404) return 'AIAPIO 查不到该模型或任务，请核对账户和任务记录。';
  if (/content|moderation|safety/.test(code)) return '上游拒绝了当前内容，请调整提示词或参考素材。';
  if (/channel|lane|route/.test(code)) return '该模型暂无适用渠道，请换个规格或模型。';
  if (status === 400 || status === 422 || /invalid_request|invalid_param/.test(code)) return 'AIAPIO 拒绝了当前参数，请核对规格、素材限制或模型。';
  return 'AIAPIO 处理失败，请在 AIAPIO 调用记录中查看原因。';
}

/** Use the host HTTP client exclusively against the official origin, with no credentialed redirects. */
async function request(ctx, path, key, payload) {
  const options = { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    redirect: 'error', signal: ctx.signal };
  if (payload) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload);
  }
  const response = await ctx.fetch(`${ORIGIN}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
}

/** Delay polling without retaining abort listeners after each interval. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new Error('已停止等待。已提交的任务可能仍在 AIAPIO 运行。'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** Return a single media file URL from the documented task result fields. */
function resultAddress(task) {
  return task.output_url || task.result_url || task.data?.[0]?.url ||
    task.result?.images?.[0]?.url || task.result?.videos?.[0]?.url;
}

/** Continue polling the original task. Transient query failures never trigger a new submission. */
async function poll(ctx, key, taskId, config) {
  const timeout = Number(config.poll_timeout) || 1800;
  const deadline = Date.now() + Math.min(3600, Math.max(30, timeout)) * 1000;
  let interval = 3000;
  while (Date.now() < deadline) {
    if (ctx.signal?.aborted) throw new Error(`已停止等待。任务 ${taskId} 可能仍在 AIAPIO 运行。`);
    let answer;
    try {
      answer = await request(ctx, `/v1/tasks/${encodeURIComponent(taskId)}`, key);
    } catch {
      if (ctx.signal?.aborted) throw new Error(`已停止等待。任务 ${taskId} 可能仍在 AIAPIO 运行。`);
    }
    if (!answer || [429, 502, 503, 504].includes(answer.status)) {
      interval = Math.min(interval * 2, 12000);
      ctx.onProgress?.(15, '任务暂时查不到，正在重试查询原任务');
    } else {
      const task = answer.body;
      if (!answer.ok || !task) throw new Error(`${explainError(answer.status, task?.error)} 任务 ${taskId}`);
      if (task.status === 'failed' || (task.is_final === true && task.error)) {
        throw new Error(`${explainError(answer.status, task.error ?? { code: task.error_class })} 任务 ${taskId}`);
      }
      if (task.is_final === true || (task.status === 'completed' && task.cdn_pending)) {
        if (task.status !== 'completed') throw new Error(`AIAPIO 已结束任务 ${taskId}，请在调用记录里检查状态。`);
        if (!task.cdn_pending && resultAddress(task)) return task;
        if (!task.cdn_pending) throw new Error(`任务 ${taskId} 完成但未返回媒体地址。请检查 AIAPIO 作品库。`);
      } else if (!PENDING.has(task.status)) {
        throw new Error(`AIAPIO 返回了未知任务状态。请查看任务 ${taskId}。`);
      }
      const progress = task.progress_available && Number.isFinite(task.progress) ? Math.min(90, Math.max(15, task.progress)) : 15;
      ctx.onProgress?.(progress, task.cdn_pending ? '生成已完成，等待结果转存' : 'AIAPIO 正在生成');
      interval = 4000;
    }
    await pause(Math.min(interval, Math.max(0, deadline - Date.now())), ctx.signal);
  }
  throw new Error(`查询超时。请在 AIAPIO 查看任务 ${taskId}，稍后继续查询。`);
}

/** Submit a new generation once, or resume its task, then return a local canvas media URL. */
export async function generate(ctx) {
  const { input = {}, config = {} } = ctx;
  const key = String(config.api_key ?? '').trim();
  if (!key) throw new Error('请先在「系统设置 → 插件 → AIAPIO」保存自己的 API Key。');
  if (ctx.signal?.aborted) throw new Error('已取消生成。');
  let taskId = taskIdentifier(input.resumeTaskId);
  const model = MODELS[input.model];
  if (input.resumeTaskId && !taskId) throw new Error('任务编号格式无效，请在 AIAPIO 调用记录中核对。');
  if (!taskId) {
    if (!model || (input.type && model.kind !== input.type)) throw new Error('请在当前节点选择可用的 AIAPIO 模型。');
    const payload = invocation(model, input, config);
    ctx.onProgress?.(5, '正在提交 AIAPIO 生成任务');
    let answer;
    try {
      answer = await request(ctx, INVOKE, key, payload);
    } catch {
      throw new Error('提交结果未知。请先到 AIAPIO 调用记录核对，再决定是否重新生成。');
    }
    const { body, status, ok } = answer;
    taskId = taskIdentifier(body?.task_id) || taskIdentifier(body?.result?.task_id) || taskIdentifier(body?.error?.task_id);
    if (!taskId && (status >= 500 || (ok && !body))) {
      throw new Error('提交结果未知。请先到 AIAPIO 调用记录核对，再决定是否重新生成。');
    }
    if (!taskId && (!ok || body?.error)) throw new Error(explainError(status, body?.error));
    if (!taskId) throw new Error('AIAPIO 未返回任务编号。请先到调用记录核对，再决定是否重新生成。');
    ctx.onTaskCreated?.(taskId);
  }
  const task = await poll(ctx, key, taskId, config);
  const kind = task.type ?? model?.kind ?? input.type;
  if (!['image', 'video'].includes(kind) || (model && model.kind !== kind)) {
    throw new Error(`任务 ${taskId} 返回的媒体类型与画布节点不符。`);
  }
  const address = mediaAddress(resultAddress(task), '结果文件');
  const suffix = new URL(address).pathname.match(/\.(png|jpe?g|webp|gif|avif|mp4|mov|webm)$/i)?.[1].toLowerCase();
  ctx.onProgress?.(95, '下载结果到画布');
  let mediaUrl;
  try {
    mediaUrl = await ctx.downloadToFile(address, suffix || (kind === 'video' ? 'mp4' : 'png'));
  } catch {
    throw new Error(`任务 ${taskId} 已完成，结果下载失败。请重试下载或在 AIAPIO 作品库查看。`);
  }
  if (!mediaUrl) throw new Error(`任务 ${taskId} 已完成，但未得到本地文件地址。`);
  ctx.onProgress?.(100, '完成');
  return { mediaUrl, taskId };
}
