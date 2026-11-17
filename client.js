/* DSH Session Manager · Client 半边
 * ============================================================================
 * 动态 Client 模块：侧栏图标（sidebar.panellist）+ 主页面（main）。
 * 只 require('react')，全部样式走 inline style + 主题 token，不依赖第三方包。
 *
 * 数据来自 Host 半边的 HTTP API：POST <base>session-manager/api/<method>，
 * 响应包封 { ok, value } / { ok, error }。支持多选 → 批量归档 / 批量删除，
 * 归档区支持批量恢复。删除为不可恢复操作，确认时列表项标红。
 * Host 未安装时（404 / 网络失败）页面骨架照常渲染，并提示重启。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useMemo } = React;

    const NS = 'dshSessionManager';
    const PANEL_ID = 'dsh-session-manager';
    const POLL_MS = 30000;

    /* ------------------------------------------------------------------ */
    /* 主题 token                                                          */
    /* ------------------------------------------------------------------ */
    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      sidebar: 'var(--dsw-specific-sidebar-fill)',
    };

    /* ------------------------------------------------------------------ */
    /* 文案：locale 可用则注册，否则内置回落。                              */
    /* ------------------------------------------------------------------ */
    const ZH = {
      nav: '会话管理',
      title: '历史会话管理',
      subtitle: '多选 · 归档 · 删除 · 恢复',
      loading: '正在加载…',
      ready: '就绪',
      refresh: '刷新',
      selectAll: '全选',
      clearSel: '清空',
      archive: '归档',
      delete: '删除',
      restore: '恢复',
      sessions: '会话',
      archived: '归档',
      empty: '没有历史会话',
      emptyHint: '当前工作区还没有历史会话记录。',
      emptyArchived: '归档区为空',
      emptyArchivedHint: '归档的会话会出现在这里，可随时恢复。',
      confirmArchive: '确认归档选中的 N 个会话？归档后从列表移除，但数据保留，可随时恢复。',
      confirmDelete: '确认永久删除选中的 N 个会话？此操作不可恢复，删除后数据无法找回。',
      confirmRestore: '确认恢复选中的 N 个会话？',
      running: '运行中',
      hostMissing: '未连接宿主服务，请确认插件已安装并重启。',
      irrecoverable: '不可恢复',
      selected: '已选 N 个',
      updatedAt: '更新',
      size: '大小',
      cwd: '工作目录',
      total: '共 N 个会话',
      archivedCount: 'M 个已归档',
    };

    const EN = {
      nav: 'Sessions',
      title: 'Session Manager',
      subtitle: 'Multi-select · archive · delete · restore',
      loading: 'Loading…',
      ready: 'Ready',
      refresh: 'Refresh',
      selectAll: 'Select all',
      clearSel: 'Clear',
      archive: 'Archive',
      delete: 'Delete',
      restore: 'Restore',
      sessions: 'Sessions',
      archived: 'Archived',
      empty: 'No sessions',
      emptyHint: 'No history sessions in this workspace yet.',
      emptyArchived: 'Archive is empty',
      emptyArchivedHint: 'Archived sessions appear here and can be restored anytime.',
      confirmArchive: 'Archive the N selected sessions? They leave the list but data is kept and can be restored.',
      confirmDelete: 'Permanently delete the N selected sessions? This cannot be undone.',
      confirmRestore: 'Restore the N selected sessions?',
      running: 'Running',
      hostMissing: 'Host service unreachable. Ensure the plugin is installed and restart.',
      irrecoverable: 'Irreversible',
      selected: 'N selected',
      updatedAt: 'Updated',
      size: 'Size',
      cwd: 'Working dir',
      total: 'N sessions',
      archivedCount: 'M archived',
    };

    /* ------------------------------------------------------------------ */
    /* 小工具                                                              */
    /* ------------------------------------------------------------------ */
    function fmtBytes(n) {
      if (!n && n !== 0) return '—';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    function fmtDate(iso) {
      if (!iso) return '—';
      try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit',
        });
      } catch {
        return iso;
      }
    }

    function shortId(id) {
      return id && id.length > 10 ? id.slice(0, 10) + '…' : id || '—';
    }

    function interp(text, vars) {
      let out = text;
      for (const k of Object.keys(vars)) out = out.split('N').join(String(vars[k]));
      return out;
    }

    /* ------------------------------------------------------------------ */
    /* API base                                                            */
    /* ------------------------------------------------------------------ */
    function apiBase() {
      try {
        if (typeof document !== 'undefined' && document && document.baseURI) return document.baseURI;
      } catch (e) {
        /* ignore */
      }
      return 'http://dsh.internal/';
    }

    async function api(method, payload) {
      const url = new URL('session-manager/api/' + method, apiBase());
      let res = null;
      try {
        res = await fetch(url.href, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        });
      } catch (cause) {
        const err = new Error('无法连接宿主服务');
        err.hostMissing = true;
        err.cause = cause;
        throw err;
      }
      let json = null;
      try {
        json = await res.json();
      } catch (e) {
        json = null;
      }
      if (!json || typeof json !== 'object') {
        const status = (res && res.status) || 0;
        const err = new Error('HTTP ' + (status || '?'));
        if (status === 404) err.hostMissing = true;
        throw err;
      }
      if (!json.ok) {
        const detail = json.error && typeof json.error === 'object' ? json.error : {};
        const status = (res && res.status) || 0;
        const err = new Error(String(detail.message) || ('HTTP ' + (status || '?')));
        err.code = String(detail.code);
        if (status === 404) err.hostMissing = true;
        throw err;
      }
      return json.value;
    }

    /* ------------------------------------------------------------------ */
    /* 图标组件                                                            */
    /* ------------------------------------------------------------------ */
    function PanelIcon(props) {
      const size = (props && props.size) || 18;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', style: props && props.style },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3, stroke: 'currentColor', strokeWidth: 2 }),
        h('path', { d: 'M8 8h8M8 12h8M8 16h5', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 页面                                                                */
    /* ------------------------------------------------------------------ */
    function SessionPage(props) {
      const t = props && props.t ? props.t : (k) => k;
      const [state, setState] = useState(null);
      const [hostMissing, setHostMissing] = useState(false);
      const [busy, setBusy] = useState(false);
      const [selSessions, setSelSessions] = useState({});
      const [selArchived, setSelArchived] = useState({});
      const [view, setView] = useState('sessions'); // 'sessions' | 'archived'
      const [errorMsg, setErrorMsg] = useState('');

      async function load() {
        try {
          const value = await api('list');
          setState(value);
          setHostMissing(false);
          setErrorMsg('');
        } catch (e) {
          if (e && e.hostMissing) setHostMissing(true);
          else setErrorMsg(String(e && e.message ? e.message : e));
        }
      }

      useEffect(() => {
        load();
        const timer = setInterval(load, POLL_MS);
        return () => clearInterval(timer);
      }, []);

      const sessions = (state && state.sessions) || [];
      const archived = (state && state.archived) || [];

      const toggleSession = (id) => {
        setSelSessions((prev) => {
          const next = Object.assign({}, prev);
          if (next[id]) delete next[id];
          else next[id] = true;
          return next;
        });
      };
      const toggleArchived = (id) => {
        setSelArchived((prev) => {
          const next = Object.assign({}, prev);
          if (next[id]) delete next[id];
          else next[id] = true;
          return next;
        });
      };

      const selCount = Object.keys(selSessions).length;
      const selArchCount = Object.keys(selArchived).length;

      const allSelected = sessions.length > 0 && selCount === sessions.length;
      const toggleAll = () => {
        if (allSelected) setSelSessions({});
        else {
          const next = {};
          for (const s of sessions) next[s.id] = true;
          setSelSessions(next);
        }
      };

      async function run(method, payload, successCb) {
        setBusy(true);
        setErrorMsg('');
        try {
          const value = await api(method, payload);
          if (successCb) successCb(value);
          await load();
        } catch (e) {
          setErrorMsg(String(e && e.message ? e.message : e));
        } finally {
          setBusy(false);
        }
      }

      function doArchive() {
        const ids = Object.keys(selSessions);
        if (ids.length === 0) return;
        const msg = interp(t('confirmArchive'), { N: ids.length });
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(msg)) return;
        run('archive', { ids }, () => setSelSessions({}));
      }

      function doDelete() {
        const ids = Object.keys(selSessions);
        if (ids.length === 0) return;
        const msg = interp(t('confirmDelete'), { N: ids.length });
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(msg)) return;
        run('delete', { ids }, () => setSelSessions({}));
      }

      function doRestore() {
        const ids = Object.keys(selArchived);
        if (ids.length === 0) return;
        const msg = interp(t('confirmRestore'), { N: ids.length });
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(msg)) return;
        run('restore', { ids }, () => setSelArchived({}));
      }

      /* ---------- shared styles ---------- */
      const btn = (kind) => ({
        padding: '6px 12px',
        fontSize: 13,
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid ' + C.border2,
        background: kind === 'danger' ? C.error : kind === 'primary' ? C.brand : C.layer1,
        color: kind === 'danger' || kind === 'primary' ? '#fff' : C.label1,
        opacity: busy ? 0.5 : 1,
      });

      const rowStyle = (running) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderBottom: '1px solid ' + C.border1,
        background: running ? C.layer1 : C.bg,
      });

      const checkbox = (checked, onClick, label) =>
        h('input', {
          type: 'checkbox',
          checked,
          onChange: onClick,
          style: { cursor: 'pointer' },
          'aria-label': label,
        });

      /* ---------- render sessions list ---------- */
      function renderSessionRow(s) {
        const running = !!s.running;
        return h(
          'div',
          { key: s.id, style: rowStyle(running) },
          checkbox(!!selSessions[s.id], () => toggleSession(s.id), s.id),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 13, color: C.label1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, shortId(s.id)),
            h('div', { style: { fontSize: 11, color: C.label2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              t('cwd') + ': ' + (s.cwd || '—')),
          ),
          h('div', { style: { fontSize: 11, color: C.label2, textAlign: 'right', whiteSpace: 'nowrap' } },
            fmtDate(s.updatedAt),
            h('br'),
            fmtBytes(s.sizeBytes)),
          running ? h('span', { style: { fontSize: 11, color: C.success, whiteSpace: 'nowrap' } }, t('running')) : null,
        );
      }

      function renderArchivedRow(a) {
        return h(
          'div',
          { key: a.id, style: rowStyle(false) },
          checkbox(!!selArchived[a.id], () => toggleArchived(a.id), a.id),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 13, color: C.label1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, shortId(a.id)),
            h('div', { style: { fontSize: 11, color: C.label2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              t('cwd') + ': ' + (a.cwd || '—')),
          ),
          h('div', { style: { fontSize: 11, color: C.label2, textAlign: 'right', whiteSpace: 'nowrap' } },
            fmtDate(a.archivedAt),
            h('br'),
            fmtBytes(a.sizeBytes)),
        );
      }

      const headerText =
        view === 'sessions'
          ? interp(t('total'), { N: sessions.length }) + ' · ' + interp(t('archivedCount'), { M: archived.length })
          : t('archived') + ' · ' + archived.length;

      return h(
        'div',
        { style: { padding: 16, maxWidth: 860, margin: '0 auto', color: C.label1 } },
        /* header */
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' } },
          h('div', { style: { flex: 1 } },
            h('div', { style: { fontSize: 18, fontWeight: 600 } }, t('title')),
            h('div', { style: { fontSize: 12, color: C.label2 } }, t('subtitle'))),
          h('span', { style: { fontSize: 12, color: C.label2 } }, hostMissing ? t('hostMissing') : headerText),
          h('button', { type: 'button', style: btn('default'), onClick: () => load() }, t('refresh')),
        ),

        /* error banner */
        errorMsg
          ? h('div', { style: { color: C.error, fontSize: 12, marginBottom: 10 } }, errorMsg)
          : null,

        /* view tabs */
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
          h('button', {
            type: 'button',
            onClick: () => setView('sessions'),
            style: Object.assign({}, btn(view === 'sessions' ? 'primary' : 'default')),
          }, t('sessions') + ' (' + sessions.length + ')'),
          h('button', {
            type: 'button',
            onClick: () => setView('archived'),
            style: Object.assign({}, btn(view === 'archived' ? 'primary' : 'default')),
          }, t('archived') + ' (' + archived.length + ')'),
        ),

        /* toolbar for sessions view */
        view === 'sessions'
          ? h('div', { style: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { type: 'button', style: btn('default'), onClick: toggleAll }, allSelected ? t('clearSel') : t('selectAll')),
              selCount > 0 ? h('span', { style: { fontSize: 12, color: C.label2 } }, interp(t('selected'), { N: selCount })) : null,
              h('span', { style: { flex: 1 } }),
              h('button', { type: 'button', style: btn('default'), onClick: doArchive, disabled: selCount === 0 || busy }, t('archive')),
              h('button', { type: 'button', style: btn('danger'), onClick: doDelete, disabled: selCount === 0 || busy }, t('delete')),
            )
          : h('div', { style: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' } },
              selArchCount > 0 ? h('span', { style: { fontSize: 12, color: C.label2 } }, interp(t('selected'), { N: selArchCount })) : null,
              h('span', { style: { flex: 1 } }),
              h('button', { type: 'button', style: btn('default'), onClick: doRestore, disabled: selArchCount === 0 || busy }, t('restore')),
            ),

        /* delete irrecoverable hint */
        view === 'sessions' && selCount > 0
          ? h('div', { style: { fontSize: 11, color: C.error, marginBottom: 8 } }, '⚠ ' + t('irrecoverable'))
          : null,

        /* list */
        h('div', { style: { border: '1px solid ' + C.border1, borderRadius: 8, overflow: 'hidden' } },
          view === 'sessions'
            ? sessions.length === 0
              ? h('div', { style: { padding: 24, textAlign: 'center', color: C.label2 } },
                  h('div', { style: { fontSize: 14, color: C.label1, marginBottom: 6 } }, t('empty')),
                  h('div', { style: { fontSize: 12 } }, t('emptyHint')))
              : sessions.map(renderSessionRow)
            : archived.length === 0
              ? h('div', { style: { padding: 24, textAlign: 'center', color: C.label2 } },
                  h('div', { style: { fontSize: 14, color: C.label1, marginBottom: 6 } }, t('emptyArchived')),
                  h('div', { style: { fontSize: 12 } }, t('emptyArchivedHint')))
              : archived.map(renderArchivedRow),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 注册：2 处 slot，独立 try/catch。                                    */
    /* ------------------------------------------------------------------ */
    function safeInject(ctx, slotName, factoryFn) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;
        ctx.slots.inject(slotName, () => {
          try {
            return factoryFn();
          } catch (e) {
            return undefined;
          }
        });
      } catch (e) {
        /* 单个 slot 注册失败不影响其余 */
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const makeT = (c) => {
          let bind = null;
          try {
            if (c && c.locale && typeof c.locale.register === 'function' && typeof c.locale.bind === 'function') {
              c.locale.register(NS, { zh: ZH, en: EN });
              bind = c.locale.bind(NS);
            }
          } catch (e) {
            /* ignore */
          }
          return (k) => (bind ? bind(k) : (ZH[k] !== undefined ? ZH[k] : k));
        };
        const t = makeT(ctx);

        safeInject(ctx, 'sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 22,
              label: () => t('nav'),
            },
            PanelIcon,
          ),
        );

        safeInject(ctx, 'main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            (props) => SessionPage(Object.assign({}, props || {}, { t })),
          ),
        );
      },
    };
  },
});
