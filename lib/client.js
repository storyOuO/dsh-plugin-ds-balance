/**
 * ds-balance — client half (classic-script bundle).
 *
 * Served by dsh-client-modules under /plugins/ds-balance/client.js and
 * materialized by the shell's module loader. Registers one compact action in
 * `sidebar.footer.action`: account balance + today's estimated spend, fetched
 * from the host half's `/api/ds-balance` route (30 s polling, click to
 * refresh).
 */
window.__ModuleLoader__.load({
	id: 'ds-balance',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		var React = require('react');

		var CSS_ID = 'ds-balance/style';
		var css = [
			'.dsb-action{display:flex;flex-direction:column;gap:2px;width:100%;border:0;background:transparent;padding:6px 8px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit);font:inherit;text-align:left}',
			'.dsb-action:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}',
			'.dsb-wide{flex-direction:row;align-items:center;gap:4px;padding:4px 8px}',
			'.dsb-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;border:0;background:transparent;padding:2px 4px;border-radius:6px;cursor:pointer;color:inherit;font:inherit;text-align:left}',
			'.dsb-body:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}',
			'.dsb-refresh{flex:none;width:22px;height:22px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;border-radius:50%;font-size:13px;line-height:1}',
			'.dsb-refresh:hover{background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-primary,inherit)}',
			'.dsb-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;line-height:1.25}',
			'.dsb-label{font-size:11px;color:var(--dsw-alias-label-secondary,#888)}',
			'.dsb-num{font-size:12px;font-variant-numeric:tabular-nums;font-family:var(--ds-font-family-code,monospace)}',
			'.dsb-rail{font-size:10px;font-family:var(--ds-font-family-code,monospace);font-variant-numeric:tabular-nums;line-height:1;padding:2px 0}',
			'.dsb-err{color:var(--dsw-alias-danger,#c0392b)}',
		].join('\n');
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			var tag = document.createElement('style');
			tag.dataset.plugin = 'ds-balance';
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		function money(value) {
			if (value === null || value === undefined) return '--';
			var n = Number(value);
			if (!Number.isFinite(n)) return '--';
			return '\u00a5' + n.toFixed(2);
		}

		var USAGE_URL = 'https://platform.deepseek.com/usage';

		function openUsagePage() {
			var desktop = typeof window !== 'undefined' && window.dshDesktop;
			if (desktop !== undefined && typeof desktop.openExternal === 'function') {
				desktop.openExternal(USAGE_URL).catch(function () {
					window.open(USAGE_URL, '_blank', 'noopener');
				});
				return;
			}
			window.open(USAGE_URL, '_blank', 'noopener');
		}

		function BalanceAction(props) {
			var wide = props.wide;
			var dataRef = React.useRef(null);
			var [snapshot, setSnapshot] = React.useState(null);
			var [error, setError] = React.useState(null);

			var refresh = React.useCallback(function () {
				fetch('/api/ds-balance', { cache: 'no-store' })
					.then(function (res) {
						if (!res.ok) throw new Error('HTTP ' + res.status);
						return res.json();
					})
					.then(function (json) {
						dataRef.current = json;
						setSnapshot(json);
						setError(null);
					})
					.catch(function (err) {
						setError(String((err && err.message) || err));
					});
			}, []);

			React.useEffect(function () {
				refresh();
				var t = setInterval(refresh, 30000);
				return function () { clearInterval(t); };
			}, [refresh]);

			var balance = snapshot && snapshot.balance;
			var balanceText = balance && balance.total != null ? money(balance.total) : null;
			var today = snapshot ? snapshot.todayCost : null;
			var failed = error !== null && snapshot === null;

			if (!wide) {
				return React.createElement('button', {
					className: 'dsb-action',
					title: 'DeepSeek 余额 / 今日消耗（点击打开官方用量页，数据自动刷新）',
					onClick: openUsagePage,
				}, React.createElement('span', { className: 'dsb-rail' + (failed ? ' dsb-err' : '') }, failed ? '!' : money(today)));
			}
			return React.createElement('div', { className: 'dsb-action dsb-wide', title: '点击打开官方用量页（数据每分钟自动刷新）' },
				React.createElement('button', {
					className: 'dsb-body',
					onClick: openUsagePage,
					'aria-label': '打开 DeepSeek 官方用量页',
				},
					React.createElement('span', { className: 'dsb-row' },
						React.createElement('span', { className: 'dsb-label' }, '余额'),
						React.createElement('span', { className: 'dsb-num' + (failed ? ' dsb-err' : '') }, balanceText !== null ? balanceText : (failed ? '加载失败' : '\u2026'))),
					React.createElement('span', { className: 'dsb-row' },
						React.createElement('span', { className: 'dsb-label' }, '今日消耗'),
						React.createElement('span', { className: 'dsb-num' + (failed ? ' dsb-err' : '') }, failed ? '\u2014' : money(today)))),
				React.createElement('button', {
					className: 'dsb-refresh',
					title: '立即刷新',
					'aria-label': '立即刷新',
					onClick: refresh,
				}, '\u21bb'));
		}

		var inject = ['slots'];
		function apply(ctx) {
			var slots = ctx.get('slots');
			if (slots === undefined) return;
			slots.inject('sidebar.footer.action', function () {
				return slots.register(
					{ name: 'sidebar.footer.action', id: 'ds-balance-action' },
					function (props) { return React.createElement(BalanceAction, props); },
				);
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
