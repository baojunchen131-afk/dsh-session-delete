/**
 * @baojun/dsh-session-delete — Client half.
 *
 * Adds "Delete session" to the session context menu. The confirmation dialog is
 * rendered as a React component in the app's `shell.overlay` slot (the frame-wide
 * overlay layer), so it is visible above the desktop app UI — unlike a plain
 * document.body overlay, which the app shell covers. A module-level store drives
 * the dialog; the menu click sets the pending request.
 *
 * On confirm it POSTs to /dsh-session-delete/delete; the Host broadcasts
 * api-session/removed so the sidebar row drops without a reload. If the deleted
 * session was on screen, the main view is cleared to the empty state.
 */
window.__ModuleLoader__.load({
	id: "@baojun/dsh-session-delete",
	factory: function factory(require) {
		"use strict";
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect } = React;

		const ROUTE = "/dsh-session-delete";
		const MENU_ID = "session.delete";

		const MESSAGES = {
			zh: {
				menuLabel: "删除会话",
				dialogTitle: "删除会话",
				description: (t) => (typeof t === "string" && t.trim() !== "" ? "将删除会话「" + t + "」及其全部对话记录。" : "将删除该会话及其全部对话记录。"),
				hint: "会话目录会被移动到 sessions-trash（可手工搬回），此操作在界面上不可撤销。",
				cancel: "取消",
				confirm: "删除",
				busy: "删除中…",
				failed: "删除失败"
			},
			en: {
				menuLabel: "Delete session",
				dialogTitle: "Delete session",
				description: (t) => (typeof t === "string" && t.trim() !== "" ? "Permanently delete “" + t + "” and its whole conversation." : "Permanently delete this session and its whole conversation."),
				hint: "The session directory is moved into sessions-trash (you can move it back by hand). There is no undo in the UI.",
				cancel: "Cancel",
				confirm: "Delete",
				busy: "Deleting…",
				failed: "Delete failed"
			}
		};

		function strings() {
			const tag = (document.documentElement.getAttribute("lang") || navigator.language || "en").toLowerCase();
			return tag.startsWith("zh") ? MESSAGES.zh : MESSAGES.en;
		}

		// ---- module-level dialog store ----
		let currentRequest = null;
		let appCtx = null;
		const listeners = new Set();
		function setRequest(request) {
			currentRequest = request;
			for (const listener of listeners) listener(request);
		}
		function subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}

		async function requestDelete(sessionId) {
			const text = strings();
			let response;
			try {
				response = await fetch(ROUTE + "/delete", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				});
			} catch (error) {
				throw new Error("网络请求失败 / network error：" + String(error?.message ?? error));
			}
			if (!response.ok) {
				const bodyText = await response.text().catch(() => "");
				throw new Error("HTTP " + response.status + (bodyText ? "：" + bodyText.slice(0, 200) : ""));
			}
			const payload = await response.json().catch(() => null);
			if (payload === null || typeof payload !== "object" || payload.ok !== true) {
				const reason = typeof payload?.error === "string" && payload.error !== "" ? payload.error : text.failed;
				throw new Error(reason);
			}
			return payload;
		}

		function leaveDeletedSession(sessionId) {
			try {
				const uiWorkspace = appCtx?.get?.("uiWorkspace");
				if (uiWorkspace === undefined) return;
				if (uiWorkspace.mainReference?.sessionId !== sessionId) return;
				uiWorkspace.clearMain?.();
			} catch (error) {
				console.warn("dsh-session-delete: could not leave the deleted session", error);
			}
		}

		const CSS = [
			".lsd-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);font:13px/1.5 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;}",
			".lsd-panel{min-width:320px;max-width:min(440px,92vw);padding:18px 18px 14px;border-radius:10px;border:1px solid rgba(0,0,0,.14);background:#ffffff;color:#1f2023;box-shadow:0 18px 48px rgba(0,0,0,.35);}",
			".lsd-title{font-size:14px;font-weight:600;margin:0 0 8px;}",
			".lsd-desc{margin:0 0 6px;opacity:.82;white-space:pre-wrap;word-break:break-word;}",
			".lsd-hint{margin:0;font-size:12px;opacity:.6;}",
			".lsd-error{margin:10px 0 0;color:#e5534b;font-size:12px;white-space:pre-wrap;word-break:break-word;}",
			".lsd-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}",
			".lsd-btn{font:inherit;padding:5px 14px;border-radius:6px;cursor:pointer;border:1px solid rgba(0,0,0,.14);background:transparent;color:inherit;}",
			".lsd-btn.lsd-confirm{border-color:transparent;background:#d0393b;color:#fff;}",
			".lsd-btn:disabled{opacity:.55;cursor:default;}",
			"@media (prefers-color-scheme: dark){.lsd-panel{background:#26272b;color:#e8e8ea;border-color:rgba(255,255,255,.16);}.lsd-btn{border-color:rgba(255,255,255,.16);}}"
		].join("");

		function DeleteDialog({ request, onClose }) {
			const [state, setState] = useState({ kind: "ready" });
			const text = strings();
			const saving = state.kind === "saving";
			const cancel = () => {
				if (saving) return;
				onClose();
			};
			const confirm = () => {
				if (saving) return;
				setState({ kind: "saving" });
				requestDelete(request.sessionId).then(
					() => {
						onClose();
						leaveDeletedSession(request.sessionId);
					},
					(reason) => {
						setState({ kind: "failed", message: reason instanceof Error ? reason.message : String(reason) });
					}
				);
			};
			return h(
				"div",
				{
					className: "lsd-backdrop",
					onClick: (event) => {
						if (event.target === event.currentTarget) cancel();
					}
				},
				h("style", null, CSS),
				h(
					"div",
					{ className: "lsd-panel", role: "dialog", "aria-modal": true, "aria-label": text.dialogTitle },
					h("div", { className: "lsd-title" }, text.dialogTitle),
					h("p", { className: "lsd-desc" }, text.description(request.displayTitle)),
					h("p", { className: "lsd-hint" }, text.hint),
					state.kind === "failed" ? h("div", { className: "lsd-error", role: "alert" }, state.message) : null,
					h(
						"div",
						{ className: "lsd-footer" },
						h("button", { type: "button", className: "lsd-btn", disabled: saving, onClick: cancel }, text.cancel),
						h("button", { type: "button", className: "lsd-btn lsd-confirm", disabled: saving, onClick: confirm }, saving ? text.busy : text.confirm)
					)
				)
			);
		}

		function DeleteOverlay() {
			const [request, setRequestState] = useState(currentRequest);
			useEffect(() => subscribe(setRequestState), []);
			if (request === null) return null;
			return h(DeleteDialog, { key: request.sessionId, request, onClose: () => setRequest(null) });
		}

		const name = "dsh-session-delete";
		const inject = ["slots", "contextMenus"];

		function apply(ctx) {
			appCtx = ctx;
			ctx.effect(
				() =>
					ctx.contextMenus.register({
						id: MENU_ID,
						target: "session",
						order: 700,
						resolve: (target) => {
							const sessionId = target === null || typeof target !== "object" ? undefined : target.sessionId;
							if (typeof sessionId !== "string" || sessionId === "") return [];
							return [
								{
									id: "delete",
									label: strings().menuLabel,
									separatorBefore: true,
									afterContent: true,
									danger: true,
									run: () => setRequest({ sessionId, displayTitle: target.displayTitle })
								}
							];
						}
					}),
				"dsh-session-delete: session menu"
			);
			ctx.effect(
				() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "dsh-session-delete" }, DeleteOverlay)),
				"dsh-session-delete: overlay"
			);
		}

		return { apply, inject, name };
	}
});
