window.__ModuleLoader__.load({
  id: 'dsh-memory-lens',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    // ────────────────────────────────────────────────────────────────────────
    // 与宿主通信
    //
    // 必须相对**页面 base**解析路由（document.baseURI），不能用注入的
    // __DSH_TRANSPORT__.streamBaseUrl：桌面端页面是 dsh-app://app/，shell 的
    // protocol handler 会把非静态路径转发给 Host，同源；而 streamBaseUrl 是 Host
    // 真实 origin，属于**跨源**，插件路由又不带 CORS 头 —— 每个请求都会
    // "Failed to fetch"。去掉前导斜杠是为了保留反向代理的目录前缀。
    // ────────────────────────────────────────────────────────────────────────
    const API = 'dsh-memory-lens/api';

    function directoryBase(baseUrl) {
      const url = new URL(baseUrl === '' ? 'http://dsh.internal/' : baseUrl, 'http://dsh.internal/');
      url.search = '';
      url.hash = '';
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return url.href;
    }

    function apiUrl(path) {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : '';
      return new URL(path.replace(/^\/+/, ''), directoryBase(base)).href;
    }

    async function api(path, options) {
      const response = await fetch(apiUrl(`${API}/${path}`), {
        headers: { 'content-type': 'application/json' },
        ...options
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error ?? `请求失败（HTTP ${response.status}）`);
      }
      return body;
    }

    // ────────────────────────────────────────────────────────────────────────
    // 样式。只用 --dsw-alias-* 主题 token，这样亮/暗主题切换自动跟随；
    // 类名全部挂在 memlens- 前缀下，不和宿主或其他插件撞车。
    // ────────────────────────────────────────────────────────────────────────
    const CSS = `
.memlens-root { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px 32px;
  container-type: inline-size; container-name: memlens; }
.memlens-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.memlens-title { margin: 0; font-size: 17px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.memlens-sub { margin: 4px 0 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); max-width: 640px; }
.memlens-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.memlens-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px;
  font-size: 12px; font-family: inherit; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); transition: background-color .15s ease, border-color .15s ease; }
.memlens-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.memlens-btn:disabled { opacity: .5; cursor: not-allowed; }
.memlens-btn.primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent;
  color: var(--dsw-alias-button-primary-label, #fff); }
.memlens-btn.primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill)); }
.memlens-btn.danger { color: var(--dsw-alias-label-tertiary); border-color: var(--dsw-alias-border-l1); }
.memlens-btn.danger:hover { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.memlens-btn.tiny { height: 24px; padding: 0 8px; font-size: 11px; border-radius: 6px; }
.memlens-btn.armed { background: var(--dsw-alias-state-error-primary); border-color: transparent; color: #fff; }

.memlens-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 10px; }
.memlens-kpi { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); }
.memlens-kpi-v { font-size: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.memlens-kpi-k { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.memlens-kpi.over .memlens-kpi-v { color: var(--dsw-alias-state-error-primary); }

.memlens-tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 0; }
.memlens-tab { height: 32px; padding: 0 12px; font-size: 12px; font-family: inherit; cursor: pointer;
  border: none; border-bottom: 2px solid transparent; background: transparent;
  color: var(--dsw-alias-label-tertiary); transition: color .15s ease; }
.memlens-tab:hover { color: var(--dsw-alias-label-secondary); }
.memlens-tab.active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }

.memlens-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.memlens-input { flex: 1 1 220px; min-width: 160px; height: 30px; padding: 0 10px; font-size: 12px;
  font-family: inherit; border-radius: 8px; outline: none;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); }
.memlens-input:focus { border-color: var(--dsw-alias-brand-primary); }
.memlens-select { height: 30px; padding: 0 8px; font-size: 12px; font-family: inherit; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); }

.memlens-list { display: flex; flex-direction: column; gap: 8px; }
.memlens-item { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); }
.memlens-item.dim { opacity: .62; }
.memlens-item-text { font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-primary); word-break: break-word; }
.memlens-item-meta { margin-top: 6px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.memlens-tag { padding: 1px 6px; border-radius: 999px; font-size: 10px;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); }
.memlens-status { padding: 1px 6px; border-radius: 4px; font-size: 10px; }
.memlens-status.active { color: var(--dsw-alias-state-success-primary); border: 1px solid currentColor; }
.memlens-status.resolved { color: var(--dsw-alias-state-business-primary); border: 1px solid currentColor; }
.memlens-status.archived, .memlens-status.superseded { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary)); border: 1px solid currentColor; }
.memlens-item-acts { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }

.memlens-block { padding: 12px; border-radius: 10px; border: 1px dashed var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
  color: var(--dsw-alias-label-secondary); max-height: 380px; overflow: auto; }
.memlens-block.empty { font-family: inherit; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

.memlens-empty { padding: 32px 16px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.memlens-error { padding: 10px 12px; border-radius: 8px; font-size: 12px;
  border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }

.memlens-note { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.memlens-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* 记忆图 */
/* 面板宽度用 minmax：设置面板本身就只有 700px 左右，320px 的固定侧栏会把图画布挤成一条。
   图是这块的主角，侧栏够用就行。 */
.memlens-map { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 300px); gap: 12px; }
.memlens-stage { position: relative; min-width: 0; }
/* 高度跟着视口走：设置面板上方还有 KPI 卡和标签栏，固定 520px 会让图的下半截掉到可视区外。
   clamp 下限保证小屏也看得见图形，上限保证大屏不会撑爆。 */
.memlens-canvas { display: block; width: 100%; height: clamp(260px, 38vh, 520px); border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1); background: #070b14; cursor: grab; touch-action: none; }
.memlens-panel { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; overflow: auto;
  max-height: clamp(260px, 38vh, 520px); }
/* 关键：判断依据必须是「这块内容有多宽」，不是「窗口有多宽」。
   设置面板开在 1570px 的窗口里却只有 555px 宽，@media 永远不触发，两栏就一直挤着画布。
   这段必须写在上面那些基础规则之后 —— 容器查询和普通规则优先级相同，靠书写顺序决定胜负。

   窄的时候详情面板改成浮在画布右侧的浮层，而不是掉到画布下面：
   设置面板可视高度只剩 400px 出头，画布 + 下方面板叠起来必然被截断，
   而「点一个点看不到它的详情」比「详情挡住一点画布」糟得多。 */
@container memlens (max-width: 720px) {
  .memlens-map { grid-template-columns: 1fr; position: relative; }
  .memlens-panel { position: absolute; right: 8px; top: 8px; bottom: 8px; width: min(212px, 54%);
    z-index: 3; background: var(--dsw-alias-bg-layer-2, #1b2233);
    box-shadow: 0 8px 28px rgba(0, 0, 0, .45); max-height: none; }
  /* 没选中任何点时不该常驻一大块面板 —— 它会把画布压掉一半，而这时里面只有一句说明。
     收成右下角的小条，只留计数和两个按钮；选中点之后才展开成浮层。 */
  .memlens-panel[data-empty='1'] { top: auto; bottom: 8px; width: auto; max-width: 72%;
    padding: 5px 8px; border-radius: 9px; }
  .memlens-panel[data-empty='1'] .memlens-panel-head { padding-bottom: 0; border-bottom: 0; margin-bottom: 0; }
  .memlens-panel[data-empty='1'] .memlens-note { display: none; }
  /* 浮层占了右上角，图例挪到左上，两个都不挡画布中心。 */
  .memlens-legend { right: auto; left: 10px; }
}
.memlens-hint { position: absolute; left: 10px; bottom: 10px; font-size: 10.5px; padding: 4px 8px;
  border-radius: 6px; color: #cbd5e1; background: rgba(10, 15, 28, .55); opacity: .55;
  pointer-events: none; transition: opacity .2s ease; }
.memlens-stage:hover .memlens-hint { opacity: .95; }
.memlens-legend { position: absolute; right: 10px; top: 10px; display: flex; flex-direction: column; gap: 5px;
  padding: 7px 9px; border-radius: 8px; font-size: 10.5px; color: #cbd5e1;
  background: rgba(10, 15, 28, .6); backdrop-filter: blur(6px); pointer-events: none; }
.memlens-legend > span { display: inline-flex; align-items: center; gap: 6px; }
.memlens-dot { width: 7px; height: 7px; border-radius: 50%; }
.memlens-dot.red { background: #ff5a3c; box-shadow: 0 0 6px #ff5a3c; }
.memlens-dot.green { background: #3ce07a; box-shadow: 0 0 6px #3ce07a; }
.memlens-dot.tag { background: #6b7280; box-shadow: 0 0 6px #6b7280; }

.memlens-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 11px; color: var(--dsw-alias-label-tertiary); padding-bottom: 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); margin-bottom: 10px; }
.memlens-detail-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); margin-bottom: 6px; }
.memlens-detail-text { font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-primary); word-break: break-word; }
.memlens-facts { margin-top: 10px; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 11px; }
.memlens-facts dt { color: var(--dsw-alias-label-tertiary); }
.memlens-facts dd { margin: 0; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.memlens-rel { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.memlens-rel-item { font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.4; }
.memlens-rel-bar { height: 3px; border-radius: 2px; margin-top: 3px; background: var(--dsw-alias-brand-primary); opacity: .5; }

/* 弹窗 */
.memlens-mask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center;
  justify-content: center; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.5)); }
.memlens-dlg { width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow: auto;
  border-radius: 14px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.memlens-dlg h3 { margin: 0; font-size: 14px; color: var(--dsw-alias-label-primary); }
.memlens-field { display: flex; flex-direction: column; gap: 4px; }
.memlens-field > label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.memlens-textarea { min-height: 76px; padding: 8px 10px; font-size: 12.5px; font-family: inherit;
  border-radius: 8px; resize: vertical; outline: none; line-height: 1.55;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); }
.memlens-textarea:focus { border-color: var(--dsw-alias-brand-primary); }
.memlens-dlg-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
`;

    function StyleSheet() {
      useEffect(() => {
        const style = document.createElement('style');
        style.dataset.dshMemoryLens = 'true';
        style.textContent = CSS;
        document.head.append(style);
        return () => style.remove();
      }, []);
      return null;
    }

    // ── 展示用的小工具 ────────────────────────────────────────────────────
    const KIND_LABEL = { fact: '事实', pref: '偏好', promise: '约定', event: '事件' };
    const STATUS_LABEL = { active: '生效', resolved: '已结案', archived: '已归档', superseded: '已取代' };

    function fmtDate(value) {
      if (!value) return '—';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '—';
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${mm}-${dd}`;
    }

    function fmtFull(value) {
      if (!value) return '—';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '—';
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function Button({ children, onClick, variant, disabled, title }) {
      const cls = `memlens-btn${variant ? ' ' + variant : ''}`;
      return h('button', { type: 'button', className: cls, onClick, disabled, title }, children);
    }

    // ── 单条记忆卡片 ──────────────────────────────────────────────────────
    function ItemCard({ item, busy, onAction, onEdit, armed }) {
      const dim = item.status !== 'active';
      return h('div', { className: `memlens-item${dim ? ' dim' : ''}` },
        h('div', { className: 'memlens-item-text' }, item.text),
        h('div', { className: 'memlens-item-meta' },
          h('span', { className: `memlens-status ${item.status}` }, STATUS_LABEL[item.status] ?? item.status),
          h('span', null, KIND_LABEL[item.kind] ?? item.kind),
          item.tags.length > 0 ? item.tags.map((t) => h('span', { className: 'memlens-tag', key: t }, t)) : null,
          h('span', null, `想起 ${item.hits} 次`),
          h('span', null, `更新 ${fmtDate(item.updatedAt)}`),
          item.dueAt ? h('span', null, `到期 ${item.dueAt}`) : null
        ),
        h('div', { className: 'memlens-item-acts' },
          item.status === 'active'
            ? [
                h(Button, { key: 'hit', variant: 'tiny', disabled: busy, onClick: () => onAction(item.id, 'hit') }, '续命'),
                h(Button, { key: 'resolve', variant: 'tiny', disabled: busy, onClick: () => onAction(item.id, 'resolve') }, '结案'),
                h(Button, { key: 'archive', variant: 'tiny', disabled: busy, onClick: () => onAction(item.id, 'archive') }, '归档')
              ]
            : h(Button, { key: 'revive', variant: 'tiny', disabled: busy, onClick: () => onAction(item.id, 'revive') }, '↩ 撤销'),
          h(Button, { key: 'edit', variant: 'tiny', disabled: busy, onClick: () => onEdit(item) }, '✎ 编辑'),
          h(Button, {
            key: 'del',
            variant: `tiny danger${armed ? ' armed' : ''}`,
            disabled: busy,
            onClick: () => onAction(item.id, 'delete')
          }, armed ? '真的删？' : '✕ 删除')
        )
      );
    }

    // ── 记忆图（力导向 + 自算三维投影）──────────────────────────────────────
    //
    // 为什么手写投影而不是 three.js：这个面板要能在离线/受限环境里跑，多一个外部
    // 依赖就多一个「打不开」的理由；几十个点的透视投影自己算只要几十行。
    //
    // 图的语义：记忆是点，标签也是点，边表示「这条记忆挂在这个标签下」。
    // 记忆点的颜色按「还有多久淡忘」渐变（红=快忘了，绿=记得很牢），大小按强度。
    // 所以这张图回答的是「她现在到底还牢牢记得什么」，不是「有多少条记录」。
    function MemoryMap({ items, onAction, onEdit }) {
      const canvasRef = useRef(null);
      const stateRef = useRef(null);
      // 绘制循环只建一次（依赖 graph），所以循环里必须通过 ref 读最新状态；
      // 否则选中/高亮变化时闭包里拿到的还是建循环那一刻的旧值。
      const spinRef = useRef(true);
      const selRef = useRef(null);
      const hotRef = useRef(null);
      const posRef = useRef(new Map());
      const [selected, setSelected] = useState(null);
      const [spin, setSpin] = useState(true);

      // 建图：只在数据真的变了才重建（按 id+updatedAt+status+tags 算指纹），
      // 否则每次刷新都会把用户拖好的位置打散。
      const graph = useMemo(() => {
        const nodes = [];
        const byId = new Map();
        const tagNodes = new Map();
        const links = [];

        const live = items.filter((m) => m.status === 'active' || m.status === 'resolved');
        for (const m of live) {
          const node = {
            id: `m:${m.id}`,
            kind: 'memory',
            item: m,
            r: 4.5 + Math.min(5, m.strength ?? 3) * 1.5,
            x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
            ph: Math.random() * Math.PI * 2
          };
          nodes.push(node);
          byId.set(node.id, node);
        }
        for (const m of live) {
          for (const tag of m.tags ?? []) {
            let tagNode = tagNodes.get(tag);
            if (!tagNode) {
              tagNode = {
                id: `t:${tag}`, kind: 'tag', tag, count: 0,
                r: 3.5, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
                ph: Math.random() * Math.PI * 2
              };
              tagNodes.set(tag, tagNode);
              nodes.push(tagNode);
              byId.set(tagNode.id, tagNode);
            }
            tagNode.count += 1;
            links.push({ a: byId.get(`m:${m.id}`), b: tagNode });
          }
        }
        for (const tagNode of tagNodes.values()) tagNode.r = 3.5 + Math.sqrt(tagNode.count) * 1.9;

        // 初始位置：优先复用上一张图里的坐标（用户可能已经拖到顺手的位置），
        // 新点用球面均匀分布（斐波那契式）铺开，比随机撒点更快收敛、不堆在中心。
        const prev = posRef.current;
        const n = nodes.length || 1;
        nodes.forEach((node, i) => {
          const saved = prev.get(node.id);
          if (saved) {
            node.x = saved.x;
            node.y = saved.y;
            node.z = saved.z;
            return;
          }
          const b = Math.acos(1 - (2 * (i + 0.5)) / n);
          const a = Math.PI * (1 + Math.sqrt(5)) * (i + 0.5);
          const rad = 260 + (i % 5) * 40;
          node.x = Math.sin(b) * Math.cos(a) * rad;
          node.y = Math.cos(b) * rad;
          node.z = Math.sin(b) * Math.sin(a) * rad;
        });
        return { nodes, byId, links, tagNodes };
      }, [items]);

      // 选中态的邻居集合：高亮「自己 + 直接邻居」，其余淡出。
      const hot = useMemo(() => {
        if (!selected) return null;
        const set = new Set([selected]);
        for (const link of graph.links) {
          if (link.a.id === selected) set.add(link.b.id);
          if (link.b.id === selected) set.add(link.a.id);
        }
        return set;
      }, [selected, graph]);

      const relate = useMemo(() => {
        const node = selected ? graph.byId.get(selected) : null;
        if (!node || node.kind !== 'memory') return [];
        const tags = new Set(node.item.tags ?? []);
        const shared = new Map();
        for (const other of graph.nodes) {
          if (other.kind !== 'memory' || other.id === node.id) continue;
          let count = 0;
          for (const tag of other.item.tags ?? []) if (tags.has(tag)) count += 1;
          if (count > 0) shared.set(other, count);
        }
        return [...shared.entries()]
          .sort((a, b) => b[1] - a[1] || (b[0].item.hits ?? 0) - (a[0].item.hits ?? 0))
          .slice(0, 8)
          .map(([other, count]) => ({ item: other.item, shared: count }));
      }, [selected, graph]);

      // 颜色：按「还有多久淡忘」上色。除以 90 天而不是最大值 —— 真实分布是双峰
      // （一半 20~40 天、一半近千天），按最大值归一会让快到期的全挤成同一色。
      const colorOf = useCallback((node) => {
        if (node.kind === 'tag') return '#6b7280';
        if (node.item.status === 'resolved') return '#4b8bf5';
        const days = node.item.falloutInDays;
        const t = Math.max(0, Math.min(1, Number.isFinite(days) ? days / 90 : 0));
        return `hsl(${(4 + t * 136).toFixed(0)}, 72%, 52%)`;
      }, []);

      // 主循环：力学迭代 + 绘制。
      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;

        const P = {
          canvas, ctx, w: 0, h: 0, dpr: 1,
          nodes: graph.nodes, links: graph.links, byId: graph.byId,
          alpha: 1.6, frames: 0, t: 0,
          yaw: -0.55, pitch: 0.3, dist: 1, camDist: 2200, fov: 640, fit: 600,
          drag: null, orbit: null, raf: 0, bg: null, bgKey: '', sprites: new Map()
        };
        stateRef.current = P;

        const project = (node) => {
          const cy = Math.cos(P.yaw);
          const sy = Math.sin(P.yaw);
          const cp = Math.cos(P.pitch);
          const sp = Math.sin(P.pitch);
          const x1 = node.x * cy - node.z * sy;
          const z1 = node.x * sy + node.z * cy;
          const y1 = node.y * cp - z1 * sp;
          const z2 = node.y * sp + z1 * cp;
          const zc = z2 + P.camDist;
          const k = P.fov / Math.max(140, zc);
          return { x: P.w / 2 + x1 * k, y: P.h / 2 + y1 * k, k, zc };
        };

        const fog = (zc) => {
          const t = (zc - P.camDist + P.fit) / (P.fit * 2);
          return Math.max(0.12, Math.min(1, 0.5 + t * 0.5));
        };

        // 光晕精灵：预渲染一次、按颜色缓存。每帧给几十个点各 createRadialGradient 是真正的性能杀手。
        const sprite = (color) => {
          let cached = P.sprites.get(color);
          if (cached) return cached;
          const size = 96;
          const c = document.createElement('canvas');
          c.width = size;
          c.height = size;
          const g = c.getContext('2d');
          if (g) {
            // 先算出色相的透明版本。直接渐变到 'rgba(0,0,0,0)'（透明黑）会在边缘压出一圈脏灰，
            // 因为插值过程中黑色被混进去了 —— 光晕应该是「这个颜色渐渐变淡」，不是「渐渐变黑」。
            const m = /^hsl\((\d+(?:\.\d+)?),\s*([\d.]+)%,\s*([\d.]+)%\)$/.exec(String(color));
            const clear = m
              ? `hsla(${m[1]}, ${m[2]}%, ${m[3]}%, 0)`
              : 'rgba(0,0,0,0)';
            const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
            // 实心核只占 18%：核心太大就成了硬边圆盘，看不出「光」。
            grad.addColorStop(0, color);
            grad.addColorStop(0.18, color);
            grad.addColorStop(0.55, clear);
            grad.addColorStop(1, clear);
            g.fillStyle = grad;
            g.fillRect(0, 0, size, size);
          }
          P.sprites.set(color, c);
          return c;
        };

        const buildBg = () => {
          const key = `${P.w}x${P.h}@${P.dpr}`;
          if (P.bgKey === key && P.bg) return;
          P.bgKey = key;
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(P.w * P.dpr));
          c.height = Math.max(1, Math.round(P.h * P.dpr));
          const g = c.getContext('2d');
          if (!g) return;
          g.scale(P.dpr, P.dpr);
          const grad = g.createRadialGradient(P.w / 2, P.h / 2, 0, P.w / 2, P.h / 2, Math.max(P.w, P.h) * 0.72);
          grad.addColorStop(0, '#0d1526');
          grad.addColorStop(0.55, '#080d18');
          grad.addColorStop(1, '#04060c');
          g.fillStyle = grad;
          g.fillRect(0, 0, P.w, P.h);
          // 星尘用固定种子：会闪的星点看着像 bug，不像星空。
          let seed = 20261028;
          const rnd = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
          };
          for (let i = 0; i < 180; i += 1) {
            const x = rnd() * P.w;
            const y = rnd() * P.h;
            const r = rnd() * 1.1 + 0.2;
            g.globalAlpha = 0.12 + rnd() * 0.4;
            g.fillStyle = '#cfe0ff';
            g.beginPath();
            g.arc(x, y, r, 0, Math.PI * 2);
            g.fill();
          }
          g.globalAlpha = 1;
          P.bg = c;
        };

        const tick = () => {
          if (P.alpha <= 0.004) return;
          const { nodes, links } = P;
          for (let i = 0; i < nodes.length; i += 1) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j += 1) {
              const b = nodes[j];
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const dz = b.z - a.z;
              const d2 = dx * dx + dy * dy + dz * dz + 1;
              const rep = 2600 * P.alpha;
              const f = rep / d2;
              a.vx -= dx * f * 0.001;
              a.vy -= dy * f * 0.001;
              a.vz -= dz * f * 0.001;
              b.vx += dx * f * 0.001;
              b.vy += dy * f * 0.001;
              b.vz += dz * f * 0.001;
            }
          }
          for (const link of links) {
            const dx = link.b.x - link.a.x;
            const dy = link.b.y - link.a.y;
            const dz = link.b.z - link.a.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            const f = (d - (link.a.r + link.b.r + 34)) * 0.055 * P.alpha;
            link.a.vx += (dx / d) * f;
            link.a.vy += (dy / d) * f;
            link.a.vz += (dz / d) * f;
            link.b.vx -= (dx / d) * f;
            link.b.vy -= (dy / d) * f;
            link.b.vz -= (dz / d) * f;
          }
          for (const n of nodes) {
            // z 方向向心力更强：压成扁球。纯球体在屏幕上和平面图一样糊。
            n.vx -= n.x * 0.004 * P.alpha;
            n.vy -= n.y * 0.004 * P.alpha;
            n.vz -= n.z * 0.0075 * P.alpha;
            n.vx *= 0.85;
            n.vy *= 0.85;
            n.vz *= 0.85;
            n.x += n.vx;
            n.y += n.vy;
            n.z += n.vz;
            n.x = Math.max(-1200, Math.min(1200, n.x));
            n.y = Math.max(-1200, Math.min(1200, n.y));
            n.z = Math.max(-1200, Math.min(1200, n.z));
          }
          P.alpha -= 0.009;
        };

        const draw = () => {
          const ctx2 = P.ctx;
          const hot = hotRef.current;
          const selected = selRef.current;
          buildBg();
          if (P.bg) {
            ctx2.setTransform(1, 0, 0, 1, 0, 0);
            ctx2.clearRect(0, 0, P.canvas.width, P.canvas.height);
            ctx2.drawImage(P.bg, 0, 0);
            ctx2.setTransform(P.dpr, 0, 0, P.dpr, 0, 0);
          } else {
            ctx2.fillStyle = '#070b14';
            ctx2.fillRect(0, 0, P.w, P.h);
          }

          const proj = new Map();
          let maxR = 1;
          let sumR = 0;
          for (const n of P.nodes) {
            const p = project(n);
            proj.set(n.id, p);
            const d = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
            if (d > maxR) maxR = d;
            sumR += n.r;
          }
          // 包围半径要把节点自身的大小算进去：只有 3 条记忆时点很少、坐标也挤，
          // 光看坐标距离会得出「图很小」→ 相机贴到脸上 → 几个大光斑占满屏幕。
          // 取「坐标跨度」与「所有点半径之和」中更大的那个当包围半径，稀疏图才不会被放大。
          P.fit = Math.max(maxR, sumR * 0.75, 120);
          const target = P.fit * 2.6 * P.dist;
          P.camDist += (target - P.camDist) * 0.12;

          // 连线：远→近排序，远的先画（近的盖在上面才符合透视直觉）
          const edges = P.links
            .map((link) => ({ l: link, pa: proj.get(link.a.id), pb: proj.get(link.b.id) }))
            .sort((x, y) => (y.pa.zc + y.pb.zc) - (x.pa.zc + x.pb.zc));
          for (let i = 0; i < edges.length; i += 1) {
            const { l, pa, pb } = edges[i];
            const zc = (pa.zc + pb.zc) / 2;
            const f = fog(zc);
            const dimmed = hot && !hot.has(l.a.id) && !hot.has(l.b.id);
            ctx2.strokeStyle = dimmed ? 'rgba(120,140,190,0.05)' : `rgba(120,150,220,${(0.16 * f).toFixed(3)})`;
            ctx2.lineWidth = 0.9 + Math.min(1.5, (l.b.count ?? 1) * 0.15);
            ctx2.beginPath();
            ctx2.moveTo(pa.x, pa.y);
            ctx2.lineTo(pb.x, pb.y);
            ctx2.stroke();

            // 沿边流动的光点：静止的线只说明「有关联」，有东西流过的线才像关联正在发生。
            if (!dimmed) {
              const seed = l.b.id.length + i;
              const spd = 0.09 + (seed % 5) * 0.018;
              const tt = ((P.t * spd + i * 0.5 + seed * 0.017) % 1);
              const px = pa.x + (pb.x - pa.x) * tt;
              const py = pa.y + (pb.y - pa.y) * tt;
              ctx2.fillStyle = `rgba(150,190,255,${(0.5 * f).toFixed(3)})`;
              ctx2.beginPath();
              ctx2.arc(px, py, 1.4, 0, Math.PI * 2);
              ctx2.fill();
            }
          }

          // 节点：同样远→近
          const ordered = P.nodes
            .map((n) => ({ n, p: proj.get(n.id) }))
            .sort((a, b) => b.p.zc - a.p.zc);
          for (const { n, p } of ordered) {
            const f = fog(p.zc);
            const dimmed = hot && !hot.has(n.id);
            const color = colorOf(n);
            const breath = 1 + Math.sin(P.t * 1.6 + n.ph) * 0.05;
            const radius = Math.max(1.6, n.r * p.k * breath);

            ctx2.globalAlpha = dimmed ? 0.16 : f;
            if (n.kind === 'memory') {
              const sp = sprite(color);
              // 光晕比实心点大一圈即可。放大倍数过大时低分辨率精灵会露出锯齿边。
              const size = radius * 4.2;
              ctx2.globalCompositeOperation = 'lighter';
              ctx2.globalAlpha = (dimmed ? 0.16 : f) * 0.5;
              ctx2.drawImage(sp, p.x - size / 2, p.y - size / 2, size, size);
              ctx2.globalCompositeOperation = 'source-over';
              ctx2.globalAlpha = dimmed ? 0.16 : f;
            }
            ctx2.fillStyle = color;
            ctx2.beginPath();
            ctx2.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx2.fill();

            // 选中点的扩散涟漪
            if (selected === n.id) {
              const ph = (P.t * 0.5) % 1;
              ctx2.globalAlpha = (1 - ph) * 0.55;
              ctx2.strokeStyle = color;
              ctx2.lineWidth = 1.4;
              ctx2.beginPath();
              ctx2.arc(p.x, p.y, radius + ph * 26, 0, Math.PI * 2);
              ctx2.stroke();
            }

            // 标签文字：太远的不画（糊成一团反而挡路）
            if (n.kind === 'tag' && !dimmed && f > 0.42) {
              ctx2.globalAlpha = f * 0.85;
              ctx2.fillStyle = '#9fb3d1';
              ctx2.font = `${Math.max(8, 11 * Math.min(1.4, p.k))}px system-ui, sans-serif`;
              ctx2.textAlign = 'center';
              ctx2.fillText(n.tag, p.x, p.y + radius + 11);
            }
            ctx2.globalAlpha = 1;
          }
        };

        const frame = () => {
          P.raf = 0;
          P.frames += 1;
          P.t += 0.016;
          if (spinRef.current && !P.orbit && !P.drag) P.yaw += 0.0016;
          tick();
          draw();
          P.raf = requestAnimationFrame(frame);
        };

        const resize = () => {
          const rect = canvas.getBoundingClientRect();
          P.w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 800));
          P.h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 520));
          P.dpr = Math.min(2, window.devicePixelRatio || 1);
          // 焦距跟画布走，不能写死。写死 640 时，设置面板里只有 220px 宽的画布会把
          // 每个点放大到铺满屏幕 —— 图还在，但看不出是张图。取短边，宽窄两种容器都装得下。
          P.fov = Math.max(220, Math.min(P.w, P.h) * 1.2);
          canvas.width = Math.round(P.w * P.dpr);
          canvas.height = Math.round(P.h * P.dpr);
          P.bgKey = '';
        };

        // 设置面板会伸缩，window resize 事件收不到；ResizeObserver 才是这块画布的真实尺寸来源。
        let ro = null;
        if (typeof ResizeObserver === 'function') {
          ro = new ResizeObserver(() => { resize(); });
          ro.observe(canvas);
        }

        const hit = (sx, sy) => {
          let best = null;
          let bestD = Infinity;
          for (const n of P.nodes) {
            const p = project(n);
            const d = Math.hypot(p.x - sx, p.y - sy);
            // 远处的点半径只有 3px，没有下限就点不中
            const pad = Math.max(7, n.r * p.k + 6);
            if (d <= pad && d < bestD) {
              best = n;
              bestD = d;
            }
          }
          return best;
        };

        const screenDelta = (dsx, dsy, k) => {
          // 屏幕位移反旋回世界位移，否则视角一转，鼠标往右拖点却往左上跑。
          const cy = Math.cos(P.yaw);
          const sy2 = Math.sin(P.yaw);
          const cp = Math.cos(P.pitch);
          const sp = Math.sin(P.pitch);
          const x1 = dsx / k;
          const y1 = dsy / k;
          const y0 = y1 * cp + 0 * sp;
          const z0 = -y1 * sp;
          const wx = x1 * cy + z0 * sy2;
          const wz = -x1 * sy2 + z0 * cy;
          return { x: wx, y: y0, z: wz };
        };

        const onDown = (event) => {
          const rect = canvas.getBoundingClientRect();
          const sx = event.clientX - rect.left;
          const sy = event.clientY - rect.top;
          const node = hit(sx, sy);
          P.alpha = Math.max(P.alpha, 0.05);
          if (node) {
            P.drag = { node, lx: sx, ly: sy, moved: 0 };
            node.fixed = true;
            canvas.style.cursor = 'grabbing';
          } else {
            P.orbit = { x: sx, y: sy, yaw: P.yaw, pitch: P.pitch, moved: 0 };
            canvas.style.cursor = 'grabbing';
          }
          canvas.setPointerCapture?.(event.pointerId);
        };

        const onMove = (event) => {
          const rect = canvas.getBoundingClientRect();
          const sx = event.clientX - rect.left;
          const sy = event.clientY - rect.top;
          if (P.drag) {
            const p = project(P.drag.node);
            const dx = sx - P.drag.lx;
            const dy = sy - P.drag.ly;
            const k = Math.max(0.05, p.k);
            const d = screenDelta(dx, dy, k);
            P.drag.node.x += d.x;
            P.drag.node.y += d.y;
            P.drag.node.z += d.z;
            P.drag.lx = sx;
            P.drag.ly = sy;
            P.drag.moved += Math.abs(dx) + Math.abs(dy);
          } else if (P.orbit) {
            const dx = sx - P.orbit.x;
            const dy = sy - P.orbit.y;
            P.yaw = P.orbit.yaw + dx * 0.006;
            // 俯仰必须夹住：翻过头会看到上下颠倒的图，那不是视角自由，是坏了。
            P.pitch = Math.max(-1.25, Math.min(1.25, P.orbit.pitch - dy * 0.006));
            P.orbit.moved += Math.abs(dx) + Math.abs(dy);
          } else {
            // 悬停只改光标，不改 React 状态 —— 每次 mousemove 都 setState 会让
            // 整棵树重渲染，鼠标划过一遍就是几十次无谓渲染。
            const node = hit(sx, sy);
            canvas.style.cursor = node ? 'pointer' : 'grab';
          }
        };

        const onUp = (event) => {
          if (P.drag) {
            const moved = P.drag.moved;
            const id = P.drag.node.id;
            P.drag.node.fixed = false;
            P.drag = null;
            if (moved < 3) setSelected(id);
          } else if (P.orbit) {
            const moved = P.orbit.moved;
            P.orbit = null;
            if (moved < 3) setSelected(null);
          }
          canvas.style.cursor = 'grab';
          canvas.releasePointerCapture?.(event.pointerId);
        };

        const onWheel = (event) => {
          event.preventDefault();
          // 滚轮改「相机距离」而不是缩放画布：透视跟着变，才像在看一张立体图。
          P.dist = Math.max(0.45, Math.min(2.6, P.dist * Math.exp(event.deltaY * 0.0012)));
        };

        const onDouble = () => {
          P.yaw = -0.55;
          P.pitch = 0.3;
          P.dist = 1;
        };

        resize();
        buildBg();
        draw();
        P.raf = requestAnimationFrame(frame);

        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('dblclick', onDouble);
        window.addEventListener('resize', resize);

        return () => {
          if (P.raf) cancelAnimationFrame(P.raf);
          if (ro) ro.disconnect();
          // 记下当前坐标，下次重建图时复用（否则每次刷新都重排，用户拖好的位置白费）。
          for (const node of P.nodes) {
            posRef.current.set(node.id, { x: node.x, y: node.y, z: node.z });
          }
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerup', onUp);
          canvas.removeEventListener('pointercancel', onUp);
          canvas.removeEventListener('wheel', onWheel);
          canvas.removeEventListener('dblclick', onDouble);
          window.removeEventListener('resize', resize);
        };
        // selected 变化只影响绘制高亮，不需要重建循环；用 ref 传递避免重跑 effect。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [graph]);

      // 循环里的闭包要读到最新值，用 ref 同步（重建循环代价太大）。
      spinRef.current = spin;
      selRef.current = selected;
      hotRef.current = hot;

      const node = selected ? graph.byId.get(selected) : null;

      return h('div', { className: 'memlens-map' },
        h('div', { className: 'memlens-stage' },
          h('canvas', { ref: canvasRef, className: 'memlens-canvas' }),
          h('div', { className: 'memlens-hint' }, '拖动旋转 · 滚轮推拉 · 点一下看关联'),
          h('div', { className: 'memlens-legend' },
            h('span', null, h('i', { className: 'memlens-dot red' }), '快淡忘了'),
            h('span', null, h('i', { className: 'memlens-dot green' }), '记得很牢'),
            h('span', null, h('i', { className: 'memlens-dot tag' }), '标签')
          )
        ),
        h('aside', { className: 'memlens-panel', 'data-empty': node ? '0' : '1' },
          h('div', { className: 'memlens-panel-head' },
            h('span', null, `${graph.nodes.filter((n) => n.kind === 'memory').length} 条记忆 · ${graph.tagNodes.size} 个标签`),
            h('span', { className: 'memlens-row' },
              h(Button, { variant: `tiny${spin ? ' primary' : ''}`, onClick: () => setSpin((v) => !v) }, spin ? '暂停旋转' : '自动旋转'),
              h(Button, { variant: 'tiny', onClick: () => {
                const P = stateRef.current;
                if (P) {
                  P.yaw = -0.55;
                  P.pitch = 0.3;
                  P.dist = 1;
                }
                setSelected(null);
              } }, '复位')
            )
          ),
          !node
            ? h('div', { className: 'memlens-note' }, '点图上的一个点。红色＝快淡忘了，绿色＝记得很牢；灰点是你给她打过的标签，一个标签连着的记忆越多，说明那件事在她心里越成体系。')
            : node.kind === 'tag'
              ? h('div', null,
                  h('div', { className: 'memlens-detail-title' }, `标签 · ${node.tag}`),
                  h('div', { className: 'memlens-note', style: { marginBottom: '8px' } }, `${node.count} 条记忆挂在这个标签下`),
                  h('div', { className: 'memlens-list' },
                    graph.links
                      .filter((l) => l.b.id === node.id)
                      .map((l) => h('div', { key: l.a.id, className: 'memlens-rel-item' }, l.a.item.text))
                  )
                )
              : h('div', null,
                  h('div', { className: 'memlens-detail-title' }, KIND_LABEL[node.item.kind] ?? node.item.kind),
                  h('div', { className: 'memlens-detail-text' }, node.item.text),
                  h('dl', { className: 'memlens-facts' },
                    h('dt', null, '强度'),
                    h('dd', null, String(node.item.strength ?? '—')),
                    h('dt', null, '预计淡忘'),
                    h('dd', null, node.item.falloutInDays == null ? '—' : `${node.item.falloutInDays} 天后`),
                    h('dt', null, '想起次数'),
                    h('dd', null, String(node.item.hits ?? 0)),
                    h('dt', null, '权重'),
                    h('dd', null, String(node.item.weight ?? '—')),
                    h('dt', null, '创建'),
                    h('dd', null, fmtFull(node.item.createdAt))
                  ),
                  node.item.tags.length > 0
                    ? h('div', { className: 'memlens-item-meta', style: { marginTop: '10px' } },
                        node.item.tags.map((t) => h('span', { key: t, className: 'memlens-tag' }, t)))
                    : null,
                  h('div', { className: 'memlens-item-acts' },
                    node.item.status === 'active'
                      ? [
                          h(Button, { key: 'hit', variant: 'tiny', onClick: () => onAction(node.item.id, 'hit') }, '续命'),
                          h(Button, { key: 'res', variant: 'tiny', onClick: () => onAction(node.item.id, 'resolve') }, '结案')
                        ]
                      : h(Button, { key: 'rev', variant: 'tiny', onClick: () => onAction(node.item.id, 'revive') }, '↩ 撤销'),
                    h(Button, { key: 'edit', variant: 'tiny', onClick: () => onEdit(node.item) }, '✎ 编辑')
                  ),
                  relate.length > 0
                    ? h('div', { className: 'memlens-rel' },
                        h('div', { className: 'memlens-detail-title', style: { fontSize: '11px' } }, '和这些记忆有关'),
                        relate.map((r) => h('div', { key: r.item.id, className: 'memlens-rel-item' },
                          r.item.text,
                          h('div', { className: 'memlens-rel-bar', style: { width: `${Math.min(100, r.shared * 34)}%` } })
                        ))
                      )
                    : null
                )
        )
      );
    }

    // ── 主分区组件 ────────────────────────────────────────────────────────
    const VIEWS = [
      { key: 'list', label: '记忆列表' },
      { key: 'inject', label: '她会想起什么' },
      { key: 'map', label: '记忆图' },
      { key: 'health', label: '体检' }
    ];

    function MemoryLensSection() {
      const [snap, setSnap] = useState(null);
      const [view, setView] = useState('list');
      const [query, setQuery] = useState('');
      const [statusFilter, setStatusFilter] = useState('all');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [dialog, setDialog] = useState(null);
      const [armed, setArmed] = useState(null);
      const armTimer = useRef(0);

      const load = useCallback(async () => {
        try {
          const data = await api('snapshot');
          setSnap(data);
          setError('');
        } catch (err) {
          setError(String(err?.message ?? err));
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const runAction = useCallback(async (id, action) => {
        if (action === 'delete' && armed !== id) {
          // 删除不可逆：先要求再点一次，3 秒后自动复位（防止用户忘了自己点过）。
          setArmed(id);
          window.clearTimeout(armTimer.current);
          armTimer.current = window.setTimeout(() => setArmed(null), 3000);
          return;
        }
        setBusy(true);
        try {
          await api('action', { method: 'POST', body: JSON.stringify({ id, action }) });
          setArmed(null);
          await load();
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy(false);
        }
      }, [armed, load]);

      const openDialog = useCallback((item) => {
        setDialog(item
          ? { mode: 'edit', id: item.id, text: item.text, kind: item.kind, tags: (item.tags ?? []).join(', '), weight: item.weight }
          : { mode: 'add', id: null, text: '', kind: 'fact', tags: '', weight: 3 });
      }, []);

      const saveDialog = useCallback(async () => {
        if (!dialog) return;
        const text = dialog.text.trim();
        if (!text) {
          setError('正文不能为空');
          return;
        }
        setBusy(true);
        try {
          const body = {
            text,
            kind: dialog.kind,
            weight: Number(dialog.weight) || 3,
            tags: dialog.tags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean)
          };
          if (dialog.id) body.id = dialog.id;
          await api('item', { method: 'POST', body: JSON.stringify(body) });
          setDialog(null);
          await load();
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy(false);
        }
      }, [dialog, load]);

      const items = snap?.items ?? [];
      const filtered = useMemo(() => {
        let list = items;
        if (statusFilter !== 'all') list = list.filter((m) => m.status === statusFilter);
        const q = query.trim().toLowerCase();
        if (q) {
          list = list.filter((m) =>
            m.text.toLowerCase().includes(q) ||
            (m.tags ?? []).some((t) => t.toLowerCase().includes(q))
          );
        }
        return [...list].sort((a, b) => {
          const rank = { active: 0, resolved: 1, archived: 2, superseded: 3 };
          return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
            String(b.updatedAt).localeCompare(String(a.updatedAt));
        });
      }, [items, statusFilter, query]);

      const counts = snap?.counts ?? { total: 0, active: 0, resolved: 0, archived: 0, superseded: 0 };
      const injected = snap?.injected;

      return h('div', { className: 'memlens-root' },
        h(StyleSheet),
        h('div', { className: 'memlens-head' },
          h('div', null,
            h('h2', { className: 'memlens-title' }, '记忆透镜'),
            h('p', { className: 'memlens-sub' },
              '她跨会话记得的事。下面「她会想起什么」展示的正是每轮真正注入的那段文字 —— 不是估算，是和注入共用一个函数算出来的。')
          ),
          h('div', { className: 'memlens-actions' },
            h(Button, { variant: 'primary', disabled: busy, onClick: () => openDialog(null) }, '＋ 记一条'),
            h(Button, { disabled: busy, onClick: load }, '刷新')
          )
        ),

        error ? h('div', { className: 'memlens-error' }, error) : null,

        h('div', { className: 'memlens-kpis' },
          h('div', { className: 'memlens-kpi' },
            h('div', { className: 'memlens-kpi-v' }, String(counts.active)),
            h('div', { className: 'memlens-kpi-k' }, '生效中')),
          h('div', { className: 'memlens-kpi' },
            h('div', { className: 'memlens-kpi-v' }, String(counts.resolved)),
            h('div', { className: 'memlens-kpi-k' }, '已结案')),
          h('div', { className: 'memlens-kpi' },
            h('div', { className: 'memlens-kpi-v' }, String(counts.archived)),
            h('div', { className: 'memlens-kpi-k' }, '已归档')),
          h('div', { className: `memlens-kpi${injected?.over > 0 ? ' over' : ''}` },
            h('div', { className: 'memlens-kpi-v' }, injected ? `${injected.count}条/${injected.chars}字` : '—'),
            h('div', { className: 'memlens-kpi-k' }, injected?.over > 0 ? `超出预算 ${injected.over} 字` : '本轮注入'))
        ),

        h('div', { className: 'memlens-tabs' },
          VIEWS.map((v) => h('button', {
            key: v.key,
            type: 'button',
            className: `memlens-tab${view === v.key ? ' active' : ''}`,
            'aria-selected': view === v.key,
            onClick: () => setView(v.key)
          }, v.label))
        ),

        view === 'list'
          ? h('div', null,
              h('div', { className: 'memlens-toolbar', style: { marginBottom: '10px' } },
                h('input', {
                  className: 'memlens-input',
                  placeholder: '搜正文或标签…',
                  value: query,
                  onChange: (e) => setQuery(e.target.value)
                }),
                h('select', {
                  className: 'memlens-select',
                  value: statusFilter,
                  onChange: (e) => setStatusFilter(e.target.value)
                },
                  h('option', { value: 'all' }, `全部（${counts.total}）`),
                  h('option', { value: 'active' }, `生效（${counts.active}）`),
                  h('option', { value: 'resolved' }, `已结案（${counts.resolved}）`),
                  h('option', { value: 'archived' }, `已归档（${counts.archived}）`),
                  h('option', { value: 'superseded' }, `已取代（${counts.superseded}）`)
                )
              ),
              filtered.length === 0
                ? h('div', { className: 'memlens-empty' },
                    items.length === 0
                      ? '还是空的。让 agent 用 remember 工具记一条，或者点右上角「记一条」。'
                      : '没有符合条件的结果。')
                : h('div', { className: 'memlens-list' },
                    filtered.map((m) => h(ItemCard, {
                      key: m.id,
                      item: m,
                      busy,
                      armed: armed === m.id,
                      onAction: runAction,
                      onEdit: openDialog
                    })))
            )
          : view === 'inject'
            ? h('div', null,
                h('p', { className: 'memlens-note', style: { marginBottom: '8px' } },
                  `每轮对话开始时，这段文字会被插进系统提示（预算 ${injected?.budget ?? 0} 字）。`),
                injected && injected.count > 0
                  ? h('div', { className: 'memlens-block' }, injected.block)
                  : h('div', { className: 'memlens-block empty' }, '目前不会注入任何内容 —— 没有生效中的记忆。')
              )
            : view === 'map'
              ? h(MemoryMap, { items: filtered, onAction: runAction, onEdit: openDialog })
              : h('div', null,
                  h('div', { className: 'memlens-note', style: { marginBottom: '8px' } },
                    '体检不是打分，是找「看着不对」的地方：太长的正文、快淡忘却很重要的条目、长期没被想起的约定。'),
                  h('div', { className: 'memlens-list' },
                    items.filter((m) => m.status === 'active').map((m) => {
                      const issues = [];
                      if (m.text.length > 110) issues.push(`正文 ${m.text.length} 字，偏长（注入时会挤占预算）`);
                      if ((m.hits ?? 0) === 0 && m.kind === 'promise') issues.push('约定从没被想起来过');
                      if (issues.length === 0) return null;
                      return h('div', { key: m.id, className: 'memlens-item' },
                        h('div', { className: 'memlens-item-text' }, m.text),
                        h('div', { className: 'memlens-item-meta' }, issues.join(' · '))
                      );
                    }).filter(Boolean)
                  )
                ),

        dialog
          ? h('div', {
              className: 'memlens-mask',
              onMouseDown: (e) => { if (e.target === e.currentTarget) setDialog(null); }
            },
              h('div', { className: 'memlens-dlg' },
                h('h3', null, dialog.mode === 'edit' ? '编辑记忆' : '记一条'),
                h('div', { className: 'memlens-field' },
                  h('label', null, `正文（${dialog.text.length}/120）`),
                  h('textarea', {
                    className: 'memlens-textarea',
                    maxLength: 120,
                    value: dialog.text,
                    onChange: (e) => setDialog({ ...dialog, text: e.target.value })
                  })
                ),
                h('div', { className: 'memlens-row' },
                  h('div', { className: 'memlens-field', style: { flex: '1 1 120px' } },
                    h('label', null, '类型'),
                    h('select', {
                      className: 'memlens-select',
                      value: dialog.kind,
                      onChange: (e) => setDialog({ ...dialog, kind: e.target.value })
                    },
                      Object.entries(KIND_LABEL).map(([k, v]) => h('option', { key: k, value: k }, v))
                    )
                  ),
                  h('div', { className: 'memlens-field', style: { flex: '1 1 120px' } },
                    h('label', null, '权重（1-5）'),
                    h('select', {
                      className: 'memlens-select',
                      value: String(dialog.weight),
                      onChange: (e) => setDialog({ ...dialog, weight: Number(e.target.value) })
                    },
                      [1, 2, 3, 4, 5].map((n) => h('option', { key: n, value: String(n) }, String(n)))
                    )
                  )
                ),
                h('div', { className: 'memlens-field' },
                  h('label', null, '标签（逗号分隔，最多 6 个）'),
                  h('input', {
                    className: 'memlens-input',
                    value: dialog.tags,
                    onChange: (e) => setDialog({ ...dialog, tags: e.target.value })
                  })
                ),
                h('div', { className: 'memlens-dlg-foot' },
                  h(Button, { onClick: () => setDialog(null) }, '取消'),
                  h(Button, { variant: 'primary', disabled: busy, onClick: saveDialog }, '保存')
                )
              )
            )
          : null
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'memory-lens',
          order: 60,
          label: () => '记忆'
        }, MemoryLensSection));
      }
    };
  }
});
