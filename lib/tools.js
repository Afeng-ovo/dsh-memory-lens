// 给 agent 用的三个记忆工具。
//
// 设计立场：**记忆由 agent 自己判断要不要记**，不搞「后台自动抽取每轮对话」。
// 自动抽取看起来省事，实际是往库里灌噪音 —— 用户说「嗯」「好的」不是事实，
// 「我看看」不是约定。噪音多了以后检索质量断崖式下跌，用户就会把整个功能关掉。
// 让 agent 显式调用，代价是它得多想一步，好处是库里每一条都有人为它负责。
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  KINDS,
  looksSensitive,
  pinLongMemory,
  removeLongMemory,
  resolveLongMemory,
  selectLongMemories,
  upsertLongMemory
} from './core/long-memory.js';

const KIND_HINT = 'fact=稳定事实（职业/住址/家人/设备）· pref=偏好（喜欢什么、讨厌什么）· promise=约定或待办（答应的事、有期限的事）· event=发生过的事件';

/** 工具返回值统一成 {ok, ...}，失败也不抛栈给模型看。 */
function ok(data) {
  return { ok: true, ...data };
}

function fail(message) {
  return { ok: false, error: message };
}

/** dueAt 是 {when, date, ts} 结构，回给模型时取最可读的那个。 */
function dueText(dueAt) {
  if (!dueAt) return undefined;
  return dueAt.when || dueAt.date || (dueAt.ts ? new Date(dueAt.ts).toISOString().slice(0, 10) : undefined);
}

/**
 * 把 `undefined` 字段从对象里剔掉。
 *
 * 宿主对工具返回值的要求是 **lossless JSON**：`JSON.stringify` 一趟下来不能丢东西。
 * 而 `{ dueAt: undefined }` 恰恰会被 stringify 丢掉 —— 于是宿主判定「值不是无损 JSON」，
 * 整次调用报 `value is not lossless JSON`，尽管 execute 本身跑得好好的。
 * 所以「这个字段可能没有」必须用条件展开表达，不能靠写一个 undefined 占位。
 */
function dropUndefined(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * 宿主渲染契约：`output.render` 必须返回**内容块数组**，不是字符串。
 *
 * 少写这个函数的后果不是「显示得难看」，是整次调用直接失败 ——
 * `@deepseek-ai/dsh-tools` 的 `defineTool` 里 `const userRender = options.output.render;`
 * 会把 undefined 抓进去，等真去渲染时抛 `output.render failed: userRender is not a function`。
 * 更糟的是 execute 已经执行完了、记忆已经落盘，用户却收到一个错误 ——
 * 他会以为没记住，于是再说一遍，库里就多一条重复。
 */
function textBlocks(text) {
  return [{ type: 'text', text }];
}

/** 读配置裸值（`.extra('volatile', true)` 的字段是访问器对象，不能直接当值用）。 */
function setting(config, key, fallback) {
  const raw = config?.[key];
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      const value = raw.get();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }
  return raw === undefined ? fallback : raw;
}

/**
 * 注册一个工具，但先看这个名字有没有被别的插件占了。
 *
 * 为什么要这一步：DSH 的工具注册是**全局按名字唯一**的（`dsh-tools` 的
 * `register()` 里 `NamedEntries.insert` 遇到重名会抛 `tool "x" is already registered`）。
 * 记忆插件用的是最通用的三个名字 `remember` / `recall` / `forget`，
 * 而市面上做记忆的插件不止一个 —— 用户实测过：`dsh-fish-memory` 也在注册 `remember`，
 * 谁先装上谁占坑，后装的那个**写入通道从第一天就是哑的**，工具列表里看着有，
 * 调下去记的却是别人家的库。这种失败不报错、不崩、只是「记得不对」，
 * 是最难查的那一类。
 *
 * 所以：名字被占时**不抛异常**（抛了会连累整个插件起不来，连面板和注入一起丢），
 * 而是跳过注册、打一条明确的告警，让用户在日志和面板里看得见「你的写入通道没接上」。
 * 其余两个工具照常注册 —— 只丢一个，比全丢好。
 */
function registerToolSafely(ctx, definition) {
  const name = definition?.name;
  let taken;
  try {
    taken = ctx.tools.get?.(name);
  } catch {
    // get 不存在（老版本宿主）或抛错：当作没被占，直接注册。
    taken = undefined;
  }
  if (taken) {
    ctx.logger?.warn?.(
      `memory-lens: 工具名 "${name}" 已被其他插件占用，本插件的 "${name}" 没有注册。` +
        '这通常意味着另一个记忆插件也在用同一个名字（例如 dsh-fish-memory）。' +
        '两个都装着的话，只有先注册的那个能真正写库 —— 建议只留一个记忆插件。'
    );
    return null;
  }
  try {
    return ctx.tools.register(definition);
  } catch (error) {
    // 竞态：检查和注册之间被别的插件抢先（插件加载顺序不保证）。
    // 同样不抛 —— 一个工具注册不上不该让整个插件起不来。
    ctx.logger?.warn?.(`memory-lens: 工具 "${name}" 注册失败（可能被其他插件抢占）：${error?.message ?? error}`);
    return null;
  }
}

export function registerMemoryTools(ctx, { store, config, afterWrite }) {
  // 写完就跑一次衰减整理（由调用方注入）。为什么把整理挂在「写入之后」而不是定时器上：
  // 写入是最可能改变「该沉谁」的时刻，而一个后台定时器会悄悄改用户的记忆文件，
  // 用户既看不见也没法阻止 —— 这种事不该出现在别人的记忆里。
  //
  // 只在 remember 之后触发：recall 只更新「想起过」的时间戳，forget 只是结案或删除，
  // 两者都不改变「谁该淡出」的排序，顺带整理等于白跑一遍，还可能误沉别的条目。
  const touched = () => {
    try {
      afterWrite?.();
    } catch (error) {
      ctx.logger?.warn?.('memory-lens: 写入后整理失败', error);
    }
  };
  const maxEntries = Number(setting(config, 'maxEntries', 1000)) || 1000;
  registerToolSafely(ctx,
    defineTool({
      name: 'remember',
      description:
        '记住一件关于用户的事，跨会话、重启后仍然记得。' +
        '只在信息值得长期保留时调用：稳定事实、明确偏好、答应的约定、发生过的重要事件。' +
        '不要记客套话、临时情绪、一次性的小请求。' +
        '同一件事换个说法再说一遍时，传 supersedes 指向旧条目，旧条目会被标为「已取代」而不是删掉。',
      parameters: {
        text: {
          type: 'string',
          required: true,
          description: '要记住的内容，一句话说清楚，第三人称（"阿风在准备考研"而不是"我在准备考研"）。'
        },
        kind: {
          type: 'string',
          enum: KINDS,
          description: KIND_HINT
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '2~4 个短标签，方便以后检索和归类（如 ["学业","考研"]）。'
        },
        weight: {
          type: 'number',
          description: '重要度 1~5，5 最难被淘汰。默认 3。'
        },
        dueAt: {
          type: 'string',
          description: '如果这件事有个时间点要跟进，写 YYYY-MM-DD 或 ISO 时间。用来以后主动提起。'
        },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description: '被这条新信息取代的旧条目：填旧条目原文片段或 id。只在旧信息真的不再成立时填。'
        },
        pin: {
          type: 'boolean',
          description:
            '钉住这条，让它每一轮都进上下文（不看分数、不参与轮换）。' +
            '只在用户明确说过「这条一直记着」「别忘了」这类话时传 true —— ' +
            '固定层的名额是有限的，什么都说「一直记着」等于什么都没记。'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
            action: { type: 'string', description: 'created=新建 · updated=更新了同一条 · revived=复活了淡忘的旧条 · merged=并入了旧条' },
            id: { type: 'string' },
            text: { type: 'string' },
            pinned: { type: 'boolean' },
            superseded: { type: 'array', items: { type: 'string' } }
          }
        },
        render(args, value) {
          if (!value.ok) return textBlocks(`没记住：${value.error ?? '未知原因'}`);
          const ACTION_LABEL = {
            created: '记下了',
            updated: '更新了同一条',
            revived: '把淡忘的旧条重新拾起来了',
            merged: '并进了已有的一条'
          };
          const head = ACTION_LABEL[value.action] ?? `完成（${value.action ?? '未知动作'}）`;
          const lines = [`${head}：${value.text ?? ''}`, `id ${value.id ?? '?'}`];
          if (value.pinned) lines.push('已钉进固定层 —— 之后每一轮都会带上它。');
          if (value.superseded?.length) lines.push(`同时取代了 ${value.superseded.length} 条旧记忆：${value.superseded.join('、')}`);
          return textBlocks(lines.join('\n'));
        }
      },
      async execute(exec) {
        const args = exec?.args ?? exec ?? {};
        const text = String(args.text ?? '').trim();
        if (!text) return fail('text 不能为空');

        // 敏感信息在写入前拦掉。用户可能把手机号、卡号、token 顺口说出来，
        // 一旦被提炼进长期记忆，它就永远躺在那儿了 —— 事后清理没人会想起来做。
        if (looksSensitive(text)) {
          return fail('这段内容看起来含手机号/证件号/密钥，不写入长期记忆。如果确实需要，请先脱敏。');
        }

        const list = store.bucket('shared');
        const result = upsertLongMemory(
          list,
          {
            text,
            kind: args.kind,
            tags: args.tags,
            weight: args.weight,
            dueAt: args.dueAt,
            supersedes: args.supersedes
          },
          { maxEntries }
        );

        if (!result?.ok || !result.item) return fail(`写入失败：${result?.reason ?? '未知原因'}`);
        // pin 在写入成功**之后**才生效：写失败时不能留下一条「被钉住的半成品」。
        // 也不在这里拒绝非 recallable 的条目 —— upsert 出来的都是 active，必然可钉。
        if (args.pin === true) pinLongMemory(list, { id: result.item.id, now: Date.now() });
        store.save();
        touched();
        return ok({
          action: result.action,
          id: result.item.id,
          text: result.item.text,
          pinned: args.pin === true,
          superseded: (result.retired ?? []).map((m) => m.id)
        });
      }
    })
  );

  registerToolSafely(ctx,
    defineTool({
      name: 'recall',
      description:
        '按关键词检索长期记忆。不知道某事记没记过、或者需要确认细节时先查一下，' +
        '不要凭印象编。返回按相关度排序的条目。',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '检索词。可以是关键词组合，也可以是一句自然语言问句。'
        },
        limit: {
          type: 'number',
          description: '最多返回几条，默认 8，最大 30。'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
            count: { type: 'number' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  kind: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  status: { type: 'string' },
                  dueAt: { type: 'string' }
                }
              }
            }
          }
        },
        render(args, value) {
          if (!value.ok) return textBlocks(`没查到：${value.error ?? '未知原因'}`);
          const items = value.items ?? [];
          if (items.length === 0) return textBlocks(`没有关于「${args?.query ?? ''}」的记忆。`);
          const KIND_LABEL = { fact: '事实', pref: '偏好', promise: '约定', event: '事件' };
          const lines = items.map((m, i) => {
            const bits = [KIND_LABEL[m.kind] ?? m.kind, m.status];
            if (m.dueAt) bits.push(`期限 ${m.dueAt}`);
            if (m.tags?.length) bits.push(m.tags.join('、'));
            return `${i + 1}. ${m.text}\n   ${bits.filter(Boolean).join(' · ')}`;
          });
          return textBlocks(`查到 ${items.length} 条：\n${lines.join('\n')}`);
        }
      },
      async execute(exec) {
        const args = exec?.args ?? exec ?? {};
        const query = String(args.query ?? '').trim();
        if (!query) return fail('query 不能为空');
        const limit = Math.min(30, Math.max(1, Number(args.limit) || 8));

        const list = store.recallable('shared');
        // 和注入走同一个打分函数 —— 这样「查到的」和「真被想起的」不会分成两套逻辑。
        // 第 6 个参数 touch=true：检索即使用，会更新 lastUsedAt/hits，所以下面必须 save()。
        const picked = selectLongMemories(list, query, limit, 100000, Date.now(), true);
        store.save();

        return ok({
          count: picked.length,
          // dropUndefined 不是洁癖：没有 dueAt 的条目如果写成 { dueAt: undefined }，
          // JSON.stringify 会把这个键丢掉 → 宿主判定「不是无损 JSON」→ 整次调用报
          // `value is not lossless JSON`。而绝大多数记忆本来就没有期限。
          items: picked.map((m) =>
            dropUndefined({
              id: m.id,
              text: m.text,
              kind: m.kind,
              tags: m.tags ?? [],
              status: m.status,
              dueAt: dueText(m.dueAt)
            })
          )
        });
      }
    })
  );

  registerToolSafely(ctx,
    defineTool({
      name: 'forget',
      description:
        '忘掉一条记忆。两种用法：resolve=这件事有结果了（结案，仍然可以被提起）；' +
        'delete=这条信息错了/不该记（真正删掉）。' +
        '用户说「这事已经办完了」用 resolve，用户说「你记错了」用 delete。',
      parameters: {
        id: { type: 'string', description: '条目 id。和 text 二选一，id 更精确。' },
        text: { type: 'string', description: '条目原文片段，用来定位。' },
        mode: {
          type: 'string',
          enum: ['resolve', 'delete'],
          description: 'resolve=结案（默认）· delete=删除'
        },
        note: { type: 'string', description: '结案时的结果，如「过了」「看完了」。' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
            action: { type: 'string' },
            id: { type: 'string' },
            text: { type: 'string' }
          }
        },
        render(args, value) {
          if (!value.ok) return textBlocks(`没忘掉：${value.error ?? '未知原因'}`);
          if (value.action === 'deleted') return textBlocks(`删掉了：${value.text ?? ''}（id ${value.id ?? '?'}）`);
          return textBlocks(`结案了：${value.text ?? ''}（id ${value.id ?? '?'}）\n它还留着，只是不再当作「还没完的事」来惦记。`);
        }
      },
      async execute(exec) {
        const args = exec?.args ?? exec ?? {};
        const mode = args.mode === 'delete' ? 'delete' : 'resolve';
        const list = store.bucket('shared');

        if (mode === 'delete') {
          const removed = removeLongMemory(list, { id: args.id, text: args.text });
          if (!removed) return fail('没找到匹配的条目');
          store.save();
          return ok({ action: 'deleted', id: removed.id, text: removed.text });
        }

        const resolved = resolveLongMemory(list, {
          id: args.id,
          text: args.text,
          note: args.note
        });
        if (!resolved) return fail('没找到匹配的条目（可能已经结案、已取代或已归档）');
        store.save();
        return ok({ action: 'resolved', id: resolved.id, text: resolved.text });
      }
    })
  );
}
