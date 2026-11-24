/**
 * @baojun/dsh-session-delete — Host half.
 *
 * Really delete a DSH session, including the one currently open with a running
 * agent. The session directory is moved into `<sessions-root>-trash` (restorable
 * by hand), the row disappears without a page reload, and the main view falls
 * back to the empty state when the deleted session was on screen.
 *
 * Ordering (verified against DSH 0.2.2-rc.5 internals):
 *   - Stopping work and waiting for agent quiescence (`whenIdle`) happens OUTSIDE
 *     the workspace registry's operation chain. The agent's convergence to idle
 *     can itself schedule registry operations (idle checkpoints); awaiting
 *     `whenIdle()` from inside `registry.enqueueOperation` deadlocks the chain.
 *   - Activity is stopped the official way: the `workspace/session-stop` parallel
 *     event (agent turn cancel `{kind:'user'}`, jobs kill, subagent cancel,
 *     schedule stop), then a bounded `whenIdle()`.
 *   - Runtime entries are detached agent-first, then session: `agent/disposed`
 *     unwinds scoped registrations before `session/disposed`, which makes the
 *     JSONL persistence flush + close its write handle and the session controller
 *     broadcast `api-session/removed` so clients drop the row live.
 *   - Only bookkeeping + the directory move run inside the registry operation
 *     chain (no `whenIdle` in there), serialized against other registry writes.
 *
 * Routes (self-prefixed; the browser half calls them directly):
 *   GET  /dsh-session-delete            liveness
 *   GET  /dsh-session-delete/list       session inventory
 *   GET  /dsh-session-delete/diag       revision + internal-hook inventory + recent attempt traces
 *   POST /dsh-session-delete/delete     { sessionId } → { ok, sessionId, title, movedTo, wasLive }
 *
 * Every internal service is feature-detected; nothing in app.asar is touched.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const name = "dsh-session-delete";
export const inject = ["webServer", "workspaceRegistry", "sessionPersistence"];

const ROUTE = "/dsh-session-delete";
const BODY_LIMIT = 64 * 1024;
const REVISION = "1.0.0";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/** Ring buffer of recent delete attempts, exposed via /diag for troubleshooting. */
const recentAttempts = [];
function recordAttempt(attempt) {
	recentAttempts.push(attempt);
	if (recentAttempts.length > 12) recentAttempts.shift();
}
function step(attempt, name, detail) {
	attempt.steps.push({ step: name, detail: detail ?? null, at: Date.now() });
}

function sendJson(res, status, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.length),
		"cache-control": "no-store"
	});
	res.end(body);
}

async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > BODY_LIMIT) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("request body is not valid JSON");
	}
}

const message = (error) => (error instanceof Error ? error.message : String(error));

/** Resolve a session's on-disk directory `<root>/<projectSlug>/<id>/`. */
async function locateSession(ctx, sessionId) {
	const snapshots = await ctx.sessionPersistence.list();
	for (const snapshot of snapshots) {
		if (snapshot.header.id !== sessionId) continue;
		const file = snapshot.location?.path;
		if (typeof file !== "string" || file === "") return { snapshot, dir: undefined };
		const dir = path.dirname(file);
		return { snapshot, dir: path.basename(dir) === sessionId ? dir : undefined };
	}
	return { snapshot: undefined, dir: undefined };
}

/** Wait for a promise that may hang; on timeout carry on — cleanup must not block deletion. */
function settle(promise, ms) {
	if (typeof promise?.then !== "function") return Promise.resolve();
	return Promise.race([
		Promise.resolve(promise).catch(() => undefined),
		new Promise((resolve) => setTimeout(resolve, ms).unref?.())
	]);
}

/** SessionStore and AgentRegistry both keep `store: Map<id, entry>` of entered entries. */
function storeOf(service) {
	const store = service?.store;
	return store instanceof Map ? store : undefined;
}

/**
 * Drop an in-process entry the official way: `detachEntered(entry)` emits
 * `session/disposed` / `agent/disposed`. Returns whether the store emitted disposal.
 */
function detachEntered(service, id) {
	const store = storeOf(service);
	if (store === undefined) return false;
	const entry = store.get(id);
	if (entry === undefined) return false;
	if (typeof service.detachEntered === "function") {
		try {
			service.detachEntered(entry);
		} catch (error) {
			service.ctx?.logger?.warn?.(`dsh-session-delete: detachEntered failed: ${message(error)}`);
		}
		if (!store.has(id)) return true;
	}
	store.delete(id);
	return false;
}

/** Move with retries: a flush in flight or an indexer can briefly hold the directory. */
async function moveToTrash(from, to) {
	let last;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			last = error;
			const code = error?.code;
			if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES" && code !== "ENOTEMPTY") throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error(`session directory is still in use, cannot move it to the trash (${last?.code ?? "unknown"}): ${message(last)}`);
}

async function deleteSession(ctx, sessionId) {
	const attempt = { sessionId: typeof sessionId === "string" ? sessionId : null, startedAt: new Date().toISOString(), steps: [], ok: false };
	recordAttempt(attempt);
	try {
		if (typeof sessionId !== "string" || sessionId.trim() === "") throw new Error("missing sessionId");

		const registry = ctx.workspaceRegistry;
		step(attempt, "sessionKnown");
		if (!(await registry.sessionKnown(sessionId))) throw new Error("no such session — it may have been deleted already");

		const { snapshot, dir } = await locateSession(ctx, sessionId);
		step(attempt, "located", { dir: dir ?? null });

		const sessions = ctx.get?.("sessions");
		const agents = ctx.get?.("agents");
		const liveSession = sessions?.get?.(sessionId);
		const liveAgent = agents?.get?.(sessionId);
		const wasLive = liveSession !== undefined || liveAgent !== undefined;
		step(attempt, "live", { session: liveSession !== undefined, agent: liveAgent !== undefined });

		// 1) Stop work + wait for quiescence — OUTSIDE the registry operation chain.
		if (wasLive) {
			step(attempt, "stop-activity");
			try {
				await ctx.parallel?.("workspace/session-stop", { sessionId });
			} catch (error) {
				step(attempt, "stop-activity-error", message(error));
			}
			try {
				liveAgent?.cancel?.({ kind: "user" });
			} catch {
				/* already tearing down */
			}
			step(attempt, "whenIdle-wait");
			await settle(liveAgent?.whenIdle?.(), 8000);
			step(attempt, "whenIdle-done");
		}

		// 2) Detach runtime entries agent-first, then session — OUTSIDE the chain.
		step(attempt, "detach-agent");
		detachEntered(agents, sessionId);
		step(attempt, "scope-dispose");
		await settle(liveAgent?.scope?.dispose?.(), 3000);
		step(attempt, "detach-session");
		const disposedByStore = detachEntered(sessions, sessionId);
		step(attempt, "detached", { disposedByStore });

		// 3) Bookkeeping + directory move, serialized in the registry chain (no whenIdle here).
		const result = await registry.enqueueOperation(async () => {
			step(attempt, "bookkeeping");
			for (const entity of registry.list()) {
				if (entity.sessionIds.includes(sessionId)) await entity.detachSession(sessionId);
			}
			const state = registry.requireState();
			const archivedSessionIds = state.archivedSessionIds.filter((id) => id !== sessionId);
			const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId);
			if (
				archivedSessionIds.length !== state.archivedSessionIds.length ||
				pinnedSessionIds.length !== state.pinnedSessionIds.length
			) {
				await registry.setState({ ...state, archivedSessionIds, pinnedSessionIds });
			}

			let movedTo = null;
			if (dir !== undefined) {
				const root = path.dirname(path.dirname(dir));
				const trashRoot = `${root}-trash`;
				await fs.mkdir(trashRoot, { recursive: true });
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				movedTo = path.join(trashRoot, `${stamp}__${sessionId}`);
				step(attempt, "rename", { from: dir, to: movedTo });
				await moveToTrash(dir, movedTo);
			}

			try {
				await ctx.get?.("sessionProjectionCache")?.table?.delete?.(sessionId);
			} catch {
				/* purely derived data */
			}
			return { ok: true, sessionId, title: snapshot?.header?.title ?? null, movedTo, wasLive };
		});

		// 4) Broadcast removal only if the store did not already emit session/disposed.
		step(attempt, "broadcast", { disposedByStore });
		if (!disposedByStore) ctx.emit("api-session/removed", sessionId);

		attempt.ok = true;
		attempt.result = result;
		ctx.logger?.info?.(`dsh-session-delete: deleted ${sessionId} (${wasLive ? "live" : "idle"}) → ${result.movedTo ?? "(no file on disk)"}`);
		return result;
	} catch (error) {
		attempt.ok = false;
		attempt.error = message(error);
		attempt.stack = error instanceof Error ? error.stack : undefined;
		ctx.logger?.warn?.(`dsh-session-delete: delete failed: ${message(error)}`);
		throw error;
	}
}

async function listSessions(ctx) {
	const snapshots = await ctx.sessionPersistence.list();
	const registry = ctx.workspaceRegistry;
	const state = registry.requireState();
	const workspaceOf = new Map();
	for (const entity of registry.list()) for (const id of entity.sessionIds) workspaceOf.set(id, entity.path);
	const archived = new Set(state.archivedSessionIds);
	const pinned = new Set(state.pinnedSessionIds);
	return snapshots.map((snapshot) => ({
		id: snapshot.header.id,
		title: snapshot.header.title ?? null,
		cwd: snapshot.header.cwd ?? null,
		sizeBytes: snapshot.sizeBytes,
		workspace: workspaceOf.get(snapshot.header.id) ?? null,
		archived: archived.has(snapshot.header.id),
		pinned: pinned.has(snapshot.header.id),
		path: snapshot.location?.path ?? null
	}));
}

function checkOrigin(req) {
	const peer = req.socket?.remoteAddress;
	if (typeof peer === "string" && peer !== "" && !LOOPBACK.has(peer)) return "only local requests are allowed";
	const origin = req.headers?.origin;
	const host = req.headers?.host;
	if (typeof origin === "string" && origin !== "" && (typeof host !== "string" || !origin.endsWith(`//${host}`))) {
		return "cross-origin request rejected";
	}
	return undefined;
}

export function apply(ctx) {
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: ROUTE,
				handler: async (req, res) => {
					const action = new URL(req.url ?? "/", "http://localhost").pathname
						.slice(ROUTE.length)
						.replace(/^\/+/, "")
						.replace(/\/+$/, "");
					try {
						if (req.method === "GET" && action === "") {
							return sendJson(res, 200, { ok: true, service: "dsh-session-delete", revision: REVISION });
						}
						if (req.method === "GET" && action === "list") {
							return sendJson(res, 200, { ok: true, sessions: await listSessions(ctx) });
						}
						if (req.method === "GET" && action === "diag") {
							const sessions = ctx.get?.("sessions");
							const agents = ctx.get?.("agents");
							return sendJson(res, 200, {
								ok: true,
								revision: REVISION,
								live: {
									sessions: [...(storeOf(sessions)?.keys() ?? [])],
									agents: [...(storeOf(agents)?.keys() ?? [])]
								},
								supports: {
									sessionsDetachEntered: typeof sessions?.detachEntered === "function",
									agentsDetachEntered: typeof agents?.detachEntered === "function",
									parallel: typeof ctx.parallel === "function",
									registryEnqueue: typeof ctx.workspaceRegistry?.enqueueOperation === "function"
								},
								attempts: recentAttempts
							});
						}
						if (req.method !== "POST") {
							return sendJson(res, 405, { ok: false, error: `unsupported method ${req.method}` });
						}
						const denied = checkOrigin(req);
						if (denied !== undefined) return sendJson(res, 403, { ok: false, error: denied });

						const body = await readJson(req);
						if (action === "delete") {
							return sendJson(res, 200, await deleteSession(ctx, body.sessionId));
						}
						return sendJson(res, 404, { ok: false, error: `unknown action ${action}` });
					} catch (error) {
						ctx.logger?.warn?.(`dsh-session-delete: ${action || "(root)"} failed: ${message(error)}`);
						return sendJson(res, 200, { ok: false, error: message(error) });
					}
				}
			}),
		"dsh-session-delete: routes"
	);
}
