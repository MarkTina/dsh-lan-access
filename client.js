/**
 * @local/lan-access — Client half.
 *
 * 全部 UI 由本文件渲染：左侧栏一个入口图标 + 一个中央面板。
 * 面板数据来自 Host 半注册的同源路由 `GET /lan-access/info`（见 index.js）。
 *
 * 遵守宿主约定：整个 factory 包在 try/catch 里，任何异常都只让插件“不显示”，
 * 绝不向 boot 闸门抛错；资源都在 apply 里注册并在清理函数里释放。
 */

window.__ModuleLoader__.load({
  id: '@local/lan-access',
  factory(require) {
    'use strict';
    try {
      return build(require);
    } catch (error) {
      try {
        console.error('[lan-access] factory failed, plugin disabled:', error && (error.stack || error.message));
      } catch (ignored) {
        /* ignore */
      }
      return { apply: function noop() {} };
    }
  },
});

function build(require) {
  var React;
  try {
    React = require('react');
  } catch (error) {
    return { apply: function noop() {} };
  }
  var h = React.createElement;
  var NS = '@local/lan-access';

  /* ===== 界面字典（与 locale/*.json 的文案一致；meta 只给插件管理页用） ===== */
  var ZH = {
    nav: '局域网访问',
    panel: {
      title: '局域网访问',
      subtitle: '把本机 dsh Web 界面分享给同一局域网内的其他设备',
      statusTitle: '运行状态',
      enabled: '已启用',
      disabled: '已禁用',
      listening: '监听中',
      stopped: '未监听',
      listenAddr: '监听地址',
      port: '端口',
      configuredPort: '配置端口',
      upstream: '上游地址（本机）',
      localUrl: '本机地址',
      addresses: '本机 IP 地址',
      noAddress: '未发现可用的局域网 IPv4 地址。',
      unreachable: '虚拟网卡 · 一般不可达',
      iface: '网卡',
      address: 'IP 地址',
      open: '打开',
      copy: '复制链接',
      copied: '已复制',
      refresh: '刷新',
      loading: '加载中…',
      error: '读取失败',
      errDisabled: '插件已在配置中禁用，代理未启动。',
      errPort: '端口 {port} 监听失败：{error}。请换一个端口后重启 dsh。',
      warn: '按当前设置，同一局域网内任何设备都能打开并使用这个 dsh。请只在可信网络中开启，并注意本机权限较高。',
      hint: '修改端口或开关：在 profile 的 cordis.patch.yml 里覆盖同名 id「lan-access」的 config，然后重启 dsh。',
      footer: '点击侧栏图标可随时回到这里。',
      linkHint: '链接内含一次性登录凭证，只分享给需要访问的人。',
    },
  };
  var EN = {
    nav: 'LAN Access',
    panel: {
      title: 'LAN Access',
      subtitle: 'Share this machine’s dsh Web UI with other devices on the same LAN',
      statusTitle: 'Status',
      enabled: 'Enabled',
      disabled: 'Disabled',
      listening: 'Listening',
      stopped: 'Not listening',
      listenAddr: 'Listen address',
      port: 'Port',
      configuredPort: 'Configured port',
      upstream: 'Upstream (local)',
      localUrl: 'Local URL',
      addresses: 'Local IP addresses',
      noAddress: 'No usable LAN IPv4 address found.',
      unreachable: 'Virtual NIC · likely unreachable',
      iface: 'Interface',
      address: 'IP address',
      open: 'Open',
      copy: 'Copy link',
      copied: 'Copied',
      refresh: 'Refresh',
      loading: 'Loading…',
      error: 'Failed to load',
      errDisabled: 'The plugin is disabled in config; the proxy is not running.',
      errPort: 'Port {port} could not be bound: {error}. Change the port and restart dsh.',
      warn: 'With these settings, any device on the same LAN can open and use this dsh. Enable it only on a trusted network; local permissions are strong.',
      hint: 'To change the port or toggle: override the config of the row id “lan-access” in your profile cordis.patch.yml, then restart dsh.',
      footer: 'Click the sidebar icon to come back here any time.',
      linkHint: 'Links carry a one-time login token; share them only with people who should have access.',
    },
  };

  function flatten(source, prefix, out) {
    var result = out || {};
    var head = prefix ? prefix + '.' : '';
    for (var key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      var value = source[key];
      var path = head + key;
      if (value && typeof value === 'object') flatten(value, path, result);
      else result[path] = value;
    }
    return result;
  }

  var FLAT_ZH = flatten(ZH, '', {});
  var activeT = null;

  function fmt(text, params) {
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, function (match, keyName) {
      return Object.prototype.hasOwnProperty.call(params, keyName) ? String(params[keyName]) : match;
    });
  }

  function tt(key, params) {
    if (activeT) {
      try {
        var translated = activeT(key, params);
        if (translated !== undefined && translated !== null && translated !== key) return translated;
      } catch (ignored) {
        /* fall through */
      }
    }
    var fallback = Object.prototype.hasOwnProperty.call(FLAT_ZH, key) ? FLAT_ZH[key] : key;
    return fmt(fallback, params);
  }

  /* ===== 配色（只走宿主主题令牌，带回退） ===== */
  var C = {
    text: 'var(--dsw-alias-label-primary, #1f2328)',
    text2: 'var(--dsw-alias-label-secondary, #545557)',
    text3: 'var(--dsw-alias-label-tertiary, #7f8287)',
    border: 'color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,127,.32)) 92%, transparent)',
    card: 'var(--dsw-alias-bg-base, #ffffff)',
    soft: 'color-mix(in srgb, var(--dsw-specific-menu, rgba(127,127,127,.08)) 62%, transparent)',
    blue: 'var(--color-blue-500, #3b82f6)',
    green: 'var(--color-green-500, #22c55e)',
    red: 'var(--color-red-500, #ef4444)',
    amber: 'var(--color-amber-500, #f59e0b)',
  };

  var styles = {
    root: {
      height: '100%',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '26px 30px 40px',
      color: C.text,
      fontSize: 14,
      lineHeight: 1.5,
    },
    wrap: { maxWidth: 900, margin: '0 auto' },
    header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20 },
    h1: { margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: 0.2 },
    subtitle: { margin: '6px 0 0', color: C.text3, fontSize: 13 },
    card: {
      border: '1px solid ' + C.border,
      borderRadius: 12,
      background: C.card,
      padding: '6px 18px',
      marginBottom: 16,
    },
    cardTitle: { fontSize: 12, fontWeight: 600, color: C.text3, letterSpacing: 0.4, margin: '14px 0 4px', textTransform: 'uppercase' },
    row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderTop: '1px solid ' + C.border },
    rowFirst: { borderTop: 'none' },
    k: { color: C.text3, fontSize: 13 },
    v: { color: C.text, fontSize: 13, fontVariantNumeric: 'tabular-nums', textAlign: 'right', wordBreak: 'break-all' },
    mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
    badge: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600 },
    dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
    banner: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 10, fontSize: 13, marginBottom: 16, border: '1px solid ' + C.border },
    btn: {
      font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer',
      padding: '5px 12px', borderRadius: 8,
      border: '1px solid ' + C.border, background: C.soft, color: C.text2,
    },
    btnPrimary: {
      font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer',
      padding: '5px 14px', borderRadius: 8,
      border: '1px solid color-mix(in srgb, ' + C.blue + ' 45%, transparent)',
      background: 'color-mix(in srgb, ' + C.blue + ' 12%, transparent)',
      color: C.blue, textDecoration: 'none',
    },
    sectionTitle: { fontSize: 13, fontWeight: 600, color: C.text2, margin: '22px 0 10px' },
    item: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14,
      padding: '12px 16px', border: '1px solid ' + C.border, borderRadius: 10,
      background: C.card, marginBottom: 10,
    },
    itemMain: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
    iface: { fontSize: 12, color: C.text3 },
    url: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5, color: C.text, wordBreak: 'break-all' },
    actions: { display: 'flex', gap: 8, flexShrink: 0 },
    hint: { color: C.text3, fontSize: 12.5, margin: '18px 0 0', lineHeight: 1.6 },
    empty: { color: C.text3, fontSize: 13, padding: '14px 2px' },
  };

  function LanIcon(props) {
    var size = (props && props.size) || 20;
    var active = !!(props && props.active);
    return h(
      'svg',
      { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block', opacity: active ? 1 : 0.82 } },
      h(
        'g',
        { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('circle', { cx: 12, cy: 12, r: 8.2 }),
        h('path', { d: 'M3.9 12h16.2' }),
        h('path', { d: 'M12 3.8c2.6 2.35 4 5 4 8.2s-1.4 5.85-4 8.2c-2.6-2.35-4-5-4-8.2s1.4-5.85 4-8.2z' }),
      ),
    );
  }

  function StatusBadge(props) {
    var ok = props.ok;
    var color = ok ? C.green : C.text3;
    return h(
      'span',
      { style: Object.assign({}, styles.badge, { color: color, background: 'color-mix(in srgb, ' + color + ' 14%, transparent)' }) },
      h('span', { style: Object.assign({}, styles.dot, { background: color }) }),
      props.text,
    );
  }

  function Row(props) {
    return h(
      'div',
      { style: props.first ? Object.assign({}, styles.row, styles.rowFirst) : styles.row },
      h('span', { style: styles.k }, props.label),
      h('span', { style: props.mono ? Object.assign({}, styles.v, styles.mono) : styles.v }, props.children),
    );
  }

  function CopyButton(props) {
    var pair = React.useState(false);
    var done = pair[0];
    var setDone = pair[1];
    function onCopy() {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(props.text).then(
            function () {
              setDone(true);
              setTimeout(function () {
                setDone(false);
              }, 1200);
            },
            function () {},
          );
          return;
        }
      } catch (ignored) {
        /* ignore */
      }
      try {
        var el = document.createElement('textarea');
        el.value = props.text;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        setDone(true);
        setTimeout(function () {
          setDone(false);
        }, 1200);
      } catch (ignored) {
        /* ignore */
      }
    }
    return h('button', { type: 'button', onClick: onCopy, style: styles.btn }, done ? tt('panel.copied') : tt('panel.copy'));
  }

  function LanPanel() {
    var stateHook = React.useState({ loading: true, data: null, error: null });
    var state = stateHook[0];
    var setState = stateHook[1];
    var tickHook = React.useState(0);
    var tick = tickHook[0];
    var setTick = tickHook[1];

    React.useEffect(function () {
      var alive = true;
      setState(function (prev) {
        return { loading: true, data: prev.data, error: null };
      });
      fetch('/lan-access/info', { headers: { accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (data) {
          if (alive) setState({ loading: false, data: data, error: null });
        })
        .catch(function (error) {
          if (alive) setState({ loading: false, data: null, error: String(error && error.message ? error.message : error) });
        });
      return function () {
        alive = false;
      };
    }, [tick]);

    var data = state.data;
    var listening = !!(data && data.listening);
    var enabled = data ? data.enabled !== false : true;
    var showError = !!(data && !listening && data.error);
    var links = ((data && data.links) || []).slice().sort(function (a, b) {
      return (b.reachable === false ? 0 : 1) - (a.reachable === false ? 0 : 1);
    });

    return h(
      'div',
      { style: styles.root },
      h(
        'div',
        { style: styles.wrap },
        h(
          'div',
          { style: styles.header },
          h(
            'div',
            null,
            h('h1', { style: styles.h1 }, tt('panel.title')),
            h('p', { style: styles.subtitle }, tt('panel.subtitle')),
          ),
          h('button', { type: 'button', style: styles.btn, onClick: function () { setTick(tick + 1); } }, tt('panel.refresh')),
        ),

        state.loading && !data
          ? h('div', { style: styles.empty }, tt('panel.loading'))
          : state.error && !data
            ? h('div', { style: Object.assign({}, styles.banner, { color: C.red }) }, tt('panel.error') + ': ' + state.error)
            : null,

        data
          ? h(
              'div',
              { style: styles.card },
              h('div', { style: styles.cardTitle }, tt('panel.statusTitle')),
              h(
                Row,
                { label: tt('panel.enabled'), first: true },
                h(StatusBadge, { ok: enabled, text: enabled ? tt('panel.enabled') : tt('panel.disabled') }),
              ),
              h(
                Row,
                { label: tt('panel.listening') },
                h(StatusBadge, { ok: listening, text: listening ? tt('panel.listening') : tt('panel.stopped') }),
              ),
              h(Row, { label: tt('panel.listenAddr'), mono: true }, (data.listenHost || '0.0.0.0') + ':' + String(data.port)),
              h(Row, { label: tt('panel.configuredPort'), mono: true }, String(data.configuredPort)),
              h(Row, { label: tt('panel.upstream'), mono: true }, data.upstreamPort ? '127.0.0.1:' + String(data.upstreamPort) : '—'),
            )
          : null,

        data && !enabled
          ? h('div', { style: Object.assign({}, styles.banner, { color: C.text2, background: C.soft }) }, tt('panel.errDisabled'))
          : null,

        showError
          ? h(
              'div',
              { style: Object.assign({}, styles.banner, { color: C.red, background: 'color-mix(in srgb, ' + C.red + ' 10%, transparent)' }) },
              tt('panel.errPort', { port: data.configuredPort, error: data.error }),
            )
          : null,

        data && enabled
          ? h('div', { style: Object.assign({}, styles.banner, { color: C.text2, background: 'color-mix(in srgb, ' + C.amber + ' 12%, transparent)', borderColor: 'color-mix(in srgb, ' + C.amber + ' 40%, transparent)' }) }, tt('panel.warn'))
          : null,

        data
          ? h(
              'div',
              null,
              h('div', { style: styles.sectionTitle }, tt('panel.addresses')),
              links.length === 0
                ? h('div', { style: styles.empty }, tt('panel.noAddress'))
                : links.map(function (item) {
                    return h(
                      'div',
                      { key: item.iface + '|' + item.address, style: item.reachable === false ? Object.assign({}, styles.item, { opacity: 0.72 }) : styles.item },
                      h(
                        'div',
                        { style: styles.itemMain },
                        h('span', { style: styles.iface }, (item.iface || '') + ' · ' + item.address + (item.reachable === false ? ' · ' + tt('panel.unreachable') : '')),
                        h('a', { href: item.url, target: '_blank', rel: 'noreferrer', style: styles.url }, item.url),
                      ),
                      h(
                        'div',
                        { style: styles.actions },
                        h('a', { href: item.url, target: '_blank', rel: 'noreferrer', style: styles.btnPrimary }, tt('panel.open')),
                        h(CopyButton, { text: item.url }),
                      ),
                    );
                  }),
              h('p', { style: styles.hint }, tt('panel.linkHint')),
            )
          : null,

        h('p', { style: styles.hint }, tt('panel.hint')),
        h('p', { style: styles.hint }, tt('panel.footer')),
      ),
    );
  }

  return {
    inject: ['slots'],
    apply: function apply(ctx) {
      try {
        /* locale：宿主可用时注册并绑定；缺失时 tt() 退回内置中文。 */
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['locale'], function (scope) {
              try {
                var locale = scope && (scope.locale || (typeof scope.get === 'function' ? scope.get('locale') : undefined));
                if (!locale || typeof locale.register !== 'function') return;
                var register = function () {
                  return locale.register(NS, { zh: ZH, en: EN });
                };
                if (typeof ctx.effect === 'function') ctx.effect(register, 'lan-access: locale');
                else register();
                if (typeof locale.bind === 'function') activeT = locale.bind(NS);
              } catch (ignored) {
                /* ignore */
              }
            });
          }
        } catch (ignored) {
          /* ignore */
        }

        var slots = typeof ctx.get === 'function' ? ctx.get('slots') : ctx.slots;
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;

        var injectProps = function () {
          return { ctx: ctx };
        };

        function safeRegister(slotName, factory) {
          try {
            slots.inject(slotName, function () {
              try {
                return factory();
              } catch (error) {
                try {
                  console.error('[lan-access] seat "' + slotName + '" failed:', error && (error.stack || error.message));
                } catch (ignored) {
                  /* ignore */
                }
                return undefined;
              }
            });
          } catch (error) {
            try {
              console.error('[lan-access] slots.inject("' + slotName + '") failed:', error && error.message);
            } catch (ignored) {
              /* ignore */
            }
          }
        }

        safeRegister('sidebar.panellist', function () {
          return slots.register(
            {
              name: 'sidebar.panellist',
              id: 'lan-access',
              order: 60,
              locale: NS,
              label: function () {
                return tt('nav');
              },
              inject: injectProps,
            },
            LanIcon,
          );
        });

        safeRegister('main', function () {
          return slots.register({ name: 'main', key: 'lan-access', inject: injectProps }, LanPanel);
        });
      } catch (error) {
        try {
          console.error('[lan-access] apply failed:', error && (error.stack || error.message));
        } catch (ignored) {
          /* ignore */
        }
      }
    },
  };
}
