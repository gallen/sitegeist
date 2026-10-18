import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { extractPage, FetchPageClient } from "./fetch-page-content.js";

const dom = new JSDOM();
const originalDocument = globalThis.document;
const originalFetch = globalThis.fetch;
globalThis.document = dom.window.document;
afterEach(() => {
	globalThis.fetch = originalFetch;
});
after(() => {
	globalThis.document = originalDocument;
	dom.window.close();
});

const paragraph =
	"This is a detailed research article with useful findings, supporting evidence, and explanations for the reader. ".repeat(
		10,
	);

test("extracts readable text, preserves paragraph breaks, resolves and deduplicates safe links", () => {
	const page = extractPage(
		`<html><head><title>Research</title><base href="/docs/"></head><body><nav>Navigation junk</nav><article><h1>Research</h1><p>${paragraph}</p><p>Second paragraph.</p><a href="next#one">Next</a><a href="next#two">Duplicate</a><a href="javascript:alert(1)">Unsafe</a><script>evil()</script><div hidden>Hidden text</div></article></body></html>`,
		"https://example.com/start",
	);
	assert.equal(page.title, "Research");
	assert.ok(page.text.includes(paragraph.trim()));
	assert.match(page.text, /\n\nSecond paragraph/);
	assert.ok(!page.text.includes("evil()"));
	assert.ok(!page.text.includes("Hidden text"));
	assert.deepEqual(page.links, [{ text: "Next", url: "https://example.com/docs/next" }]);
});

test("bounds links and falls back for short HTML", () => {
	const page = extractPage(
		`<p>Hello world</p>${Array.from({ length: 101 }, (_, i) => `<a href="/${i}">Link</a>`).join("")}`,
		"https://example.com/",
	);
	assert.ok(page.text.includes("Hello world"));
	assert.equal(page.links.length, 100);
	assert.equal(page.linksTruncated, true);
});

test("fetches without cookies, reports final URL, and truncates plain text", async () => {
	globalThis.fetch = async (_url, init) => {
		assert.equal(init?.credentials, "omit");
		assert.equal(init?.redirect, "follow");
		const response = new Response("abcdef", { headers: { "content-type": "text/plain" } });
		Object.defineProperty(response, "url", { value: "https://example.com/final" });
		return response;
	};
	const result = await new FetchPageClient().fetchPage({ url: "https://example.com/", maxChars: 3 });
	assert.equal(result.finalUrl, "https://example.com/final");
	assert.equal(result.text, "abc");
	assert.equal(result.truncated, true);
	assert.equal(result.requiresBrowser, false);
});

test("flags HTTP failures and JavaScript shells for browser fallback", async () => {
	globalThis.fetch = async () =>
		new Response("<html><body>Please sign in</body></html>", {
			status: 403,
			headers: { "content-type": "text/html" },
		});
	const result = await new FetchPageClient().fetchPage({ url: "https://example.com/" });
	assert.equal(result.status, 403);
	assert.equal(result.requiresBrowser, true);
	assert.equal(result.warnings.length, 2);
	globalThis.fetch = async () =>
		new Response("<html><body><script>loadApp()</script></body></html>", {
			headers: { "content-type": "text/html" },
		});
	assert.equal((await new FetchPageClient().fetchPage({ url: "https://example.com/" })).requiresBrowser, true);
});

test("rejects unsafe URLs, invalid limits, binary content, and oversized responses", async () => {
	const client = new FetchPageClient();
	for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:password@example.com/"]) {
		await assert.rejects(client.fetchPage({ url }), /Only HTTP/);
	}
	await assert.rejects(client.fetchPage({ url: "https://example.com/", maxChars: 0 }), /maxChars/);
	globalThis.fetch = async () => new Response("pdf", { headers: { "content-type": "application/pdf" } });
	await assert.rejects(client.fetchPage({ url: "https://example.com/" }), /extract_document/);
	globalThis.fetch = async () =>
		new Response("a".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "text/plain" } });
	await assert.rejects(client.fetchPage({ url: "https://example.com/" }), /download limit/);
});

test("limits concurrency to three, cancels queued requests, and releases slots after errors", async () => {
	const releases: Array<() => void> = [];
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		await new Promise<void>((resolve) => releases.push(resolve));
		throw new Error("Network failure");
	};
	const client = new FetchPageClient();
	const controller = new AbortController();
	const active = Array.from({ length: 3 }, () => client.fetchPage({ url: "https://example.com/" }));
	const queued = client.fetchPage({ url: "https://example.com/cancel" }, controller.signal);
	const next = client.fetchPage({ url: "https://example.com/next" });
	const settled = Promise.allSettled([...active, queued, next]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(calls, 3);
	controller.abort();
	releases.shift()?.();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(calls, 4);
	for (const release of releases) release();
	const results = await settled;
	assert.ok(results.every((result) => result.status === "rejected"));
	globalThis.fetch = async () => new Response("Recovered", { headers: { "content-type": "text/plain" } });
	assert.equal((await client.fetchPage({ url: "https://example.com/" })).text, "Recovered");
});

test("propagates cancellation to active requests", async () => {
	globalThis.fetch = async (_url, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		});
	const controller = new AbortController();
	const request = new FetchPageClient().fetchPage({ url: "https://example.com/" }, controller.signal);
	await new Promise<void>((resolve) => setImmediate(resolve));
	controller.abort();
	await assert.rejects(request, { name: "AbortError" });
});
