import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as plugin from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Build a fake DSH host context exercising the real registered route handler. */
async function makeHost({ live = false, idleNeedsChain = false, entered = true } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsd-test-"));
	const sessionsRoot = path.join(root, "sessions");
	const slug = "--proj--";
	const id = "session-test-0001";
	const dir = path.join(sessionsRoot, slug, id);
	await fs.mkdir(dir, { recursive: true });
	const logFile = path.join(dir, "session.v4.jsonl.zstd");
	await fs.writeFile(logFile, "log");

	const events = [];
	const order = [];
	let state = { workspaceIds: ["w1"], archivedSessionIds: [id], pinnedSessionIds: [id] };
	const entity = {
		path: "/proj",
		sessionIds: [id],
		async detachSession(sid) { this.sessionIds = this.sessionIds.filter((x) => x !== sid); events.push(["detachSession", sid]); }
	};

	// Serialized registry operation chain (like the real enqueueOperation).
	let tail = Promise.resolve();
	const registry = {
		async sessionKnown(sid) { return sid === id; },
		enqueueOperation(op) {
			const run = tail.then(() => op());
			tail = run.then(() => {}, () => {});
			return run;
		},
		list() { return [entity]; },
		requireState() { return state; },
		async setState(s) { state = s; }
	};

	const sessionEntry = { id, session: {} };
	const agentEntry = { id, agent: null, announced: true };
	const sessionsStore = entered ? new Map([[id, sessionEntry]]) : new Map();
	const agentsStore = new Map();
	const sessions = {
		store: sessionsStore,
		get: (sid) => sessionsStore.get(sid)?.session,
		detachEntered(entry) { sessionsStore.delete(entry.id); order.push("session/disposed"); events.push(["session/disposed", entry.id]); }
	};
	const agents = {
		store: agentsStore,
		get: (sid) => agentsStore.get(sid)?.agent,
		detachEntered(entry) { agentsStore.delete(entry.id); order.push("agent/disposed"); events.push(["agent/disposed", entry.id]); }
	};

	let liveAgent;
	if (live) {
		agentsStore.set(id, agentEntry);
		let idleResolve;
		const idlePromise = new Promise((r) => { idleResolve = r; });
		liveAgent = {
			status: "running",
			cancel(cause) { events.push(["cancel", cause.kind]); },
			whenIdle() {
				if (idleNeedsChain) {
					// Simulate an idle checkpoint that must run through the registry chain.
					registry.enqueueOperation(async () => { events.push(["idle-checkpoint"]); }).then(() => idleResolve());
				} else {
					queueMicrotask(() => idleResolve());
				}
				return idlePromise;
			},
			scope: { dispose() { events.push(["scope.dispose"]); return Promise.resolve(); } }
		};
		agentEntry.agent = liveAgent;
	}

	let handler;
	const ctx = {
		workspaceRegistry: registry,
		sessionPersistence: { async list() { return [{ header: { id, title: "T", cwd: "/proj" }, location: { path: logFile }, sizeBytes: 3 }]; } },
		webServer: { register(route) { handler = route.handler; return () => {}; } },
		get(name) { return name === "sessions" ? sessions : name === "agents" ? agents : undefined; },
		async parallel(event, payload) { events.push([event, payload.sessionId]); },
		emit(event, sid) { events.push([event, sid]); },
		effect(fn) { fn(); return () => {}; },
		logger: { info() {}, warn() {} }
	};

	plugin.apply(ctx);

	function req(method, url, body) {
		const buf = body === undefined ? null : Buffer.from(JSON.stringify(body));
		return {
			method, url, headers: { host: "127.0.0.1", origin: "http://127.0.0.1" }, socket: { remoteAddress: "127.0.0.1" },
			async *[Symbol.asyncIterator]() { if (buf) yield buf; }
		};
	}
	function res() {
		const r = { status: 0, headers: null, body: "" };
		r.writeHead = (s, h) => { r.status = s; r.headers = h; };
		r.end = (b) => { r.body = b ? b.toString() : ""; };
		return r;
	}
	async function call(method, url, body) {
		const r = res();
		await handler(req(method, url, body), r);
		return { status: r.status, json: r.body ? JSON.parse(r.body) : null };
	}

	return { root, sessionsRoot, dir, id, events, order, call, getState: () => state, liveAgent };
}

function withTimeout(promise, ms, label) {
	return Promise.race([
		promise,
		new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms).unref?.())
	]);
}

test("cold session (not entered): moved to trash, bookkeeping cleared, synthetic removed once", async () => {
	const h = await makeHost({ live: false, entered: false });
	const { status, json } = await withTimeout(h.call("POST", "/dsh-session-delete/delete", { sessionId: h.id }), 4000, "cold delete");
	assert.equal(status, 200);
	assert.equal(json.ok, true);
	assert.equal(json.wasLive, false);
	assert.ok(json.movedTo.includes("sessions-trash"));
	await assert.rejects(fs.access(h.dir)); // original gone
	await fs.access(json.movedTo); // present in trash
	assert.deepEqual(h.getState().archivedSessionIds, []);
	assert.deepEqual(h.getState().pinnedSessionIds, []);
	const removed = h.events.filter((e) => e[0] === "api-session/removed");
	assert.equal(removed.length, 1); // store did not dispose → one synthetic broadcast
	await fs.rm(h.root, { recursive: true, force: true });
});

test("live session: stops work, agent disposed before session, moved to trash", async () => {
	const h = await makeHost({ live: true });
	const { status, json } = await withTimeout(h.call("POST", "/dsh-session-delete/delete", { sessionId: h.id }), 6000, "live delete");
	assert.equal(status, 200);
	assert.equal(json.ok, true);
	assert.equal(json.wasLive, true);
	assert.ok(h.events.some((e) => e[0] === "workspace/session-stop"));
	assert.ok(h.events.some((e) => e[0] === "cancel" && e[1] === "user"));
	assert.ok(h.events.some((e) => e[0] === "scope.dispose"));
	// agent/disposed must precede session/disposed
	assert.ok(h.order.indexOf("agent/disposed") < h.order.indexOf("session/disposed"), `order: ${h.order.join(",")}`);
	await assert.rejects(fs.access(h.dir));
	await fs.access(json.movedTo);
	// store emitted session/disposed (the real controller broadcasts removal from it);
	// the plugin must NOT add a duplicate synthetic api-session/removed.
	assert.ok(h.order.includes("session/disposed"));
	const removed = h.events.filter((e) => e[0] === "api-session/removed");
	assert.equal(removed.length, 0);
	await fs.rm(h.root, { recursive: true, force: true });
});

test("live session whose idle checkpoint needs the registry chain does NOT deadlock", async () => {
	const h = await makeHost({ live: true, idleNeedsChain: true });
	const { json } = await withTimeout(h.call("POST", "/dsh-session-delete/delete", { sessionId: h.id }), 4000, "deadlock regression");
	assert.equal(json.ok, true);
	assert.ok(h.events.some((e) => e[0] === "idle-checkpoint")); // checkpoint ran (chain was free)
	await assert.rejects(fs.access(h.dir));
	await fs.rm(h.root, { recursive: true, force: true });
});

test("unknown session returns explicit error", async () => {
	const h = await makeHost({ live: false });
	const { json } = await h.call("POST", "/dsh-session-delete/delete", { sessionId: "nope" });
	assert.equal(json.ok, false);
	assert.match(json.error, /no such session/);
	await fs.rm(h.root, { recursive: true, force: true });
});

test("diag reports revision and supports flags", async () => {
	const h = await makeHost({ live: true });
	const { json } = await h.call("GET", "/dsh-session-delete/diag");
	assert.equal(json.ok, true);
	assert.equal(json.revision, "1.0.0");
	assert.equal(json.supports.sessionsDetachEntered, true);
	assert.equal(json.supports.agentsDetachEntered, true);
	await fs.rm(h.root, { recursive: true, force: true });
});
