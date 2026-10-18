import { Readability } from "@mozilla/readability";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_LINKS = 100;
const MAX_CONCURRENT_REQUESTS = 3;
// Finish before the REPL message bridge's 30-second timeout.
const TIMEOUT_MS = 25_000;

export interface FetchPageParams {
	url: string;
	maxChars?: number;
}

export interface FetchPageResult {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	title: string;
	text: string;
	links: Array<{ text: string; url: string }>;
	truncated: boolean;
	linksTruncated: boolean;
	requiresBrowser: boolean;
	warnings: string[];
}

function httpUrl(value: string, base?: string): URL {
	const url = new URL(value, base);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("Only HTTP(S) URLs without embedded credentials are supported");
	}
	return url;
}

function readableText(root: Node): string {
	if (root.nodeType === 3) return root.textContent || "";
	const parts = Array.from(root.childNodes, readableText);
	const tag = root.nodeName.toLowerCase();
	const block = /^(p|div|section|article|main|h[1-6]|li|tr|pre|blockquote|br|hr)$/;
	return parts.join(tag === "tr" ? "\t" : "") + (block.test(tag) ? "\n\n" : "");
}

/** Parses detached HTML only: no page scripts, rendering, or subresource loading. */
export function extractPage(html: string, finalUrl: string) {
	const doc = document.implementation.createHTMLDocument("");
	doc.documentElement.innerHTML = html;
	let baseUrl = finalUrl;
	const base = doc.querySelector("base[href]")?.getAttribute("href");
	if (base) {
		try {
			baseUrl = httpUrl(base, finalUrl).href;
		} catch {
			// Ignore unsafe base URLs.
		}
	}
	const links: FetchPageResult["links"] = [];
	const seen = new Set<string>();
	for (const anchor of doc.querySelectorAll("a[href]")) {
		try {
			const url = httpUrl(anchor.getAttribute("href") || "", baseUrl);
			url.hash = "";
			if (seen.has(url.href)) continue;
			seen.add(url.href);
			links.push({ text: anchor.textContent?.replace(/\s+/g, " ").trim() || "", url: url.href });
		} catch {
			// Ignore non-web links and malformed URLs.
		}
	}
	const title = doc.title;
	for (const element of doc.querySelectorAll(
		'script, style, noscript, template, iframe, object, embed, svg, [hidden], [aria-hidden="true"]',
	)) {
		element.remove();
	}
	const article = new Readability(doc.cloneNode(true) as Document, {
		serializer: (node) => readableText(node),
		maxElemsToParse: 50_000,
	}).parse();
	const root = doc.querySelector('main, article, [role="main"]') || doc.body;
	const text = (article?.content || readableText(root))
		.replace(/[\t ]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		title: article?.title || title,
		text,
		links: links.slice(0, MAX_LINKS),
		linksTruncated: links.length > MAX_LINKS,
	};
}

async function readBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new Error("Response exceeds the 2 MiB download limit");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}

/** Shared limiter across tool calls and REPL batches. Waiting requests are cancellable. */
export class FetchPageClient {
	private active = 0;
	private waiting: Array<() => void> = [];

	private acquire(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const start = () => {
				signal.removeEventListener("abort", abort);
				this.active++;
				resolve();
			};
			const abort = () => {
				this.waiting = this.waiting.filter((item) => item !== start);
				reject(signal.reason);
			};
			if (this.active < MAX_CONCURRENT_REQUESTS) start();
			else {
				this.waiting.push(start);
				signal.addEventListener("abort", abort, { once: true });
			}
		});
	}

	async fetchPage(params: FetchPageParams, signal?: AbortSignal): Promise<FetchPageResult> {
		const url = httpUrl(params.url).href;
		const maxChars = params.maxChars ?? 20_000;
		if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 100_000) {
			throw new Error("maxChars must be an integer between 1 and 100000");
		}
		const requestSignal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
		await this.acquire(requestSignal);
		try {
			const response = await fetch(url, { signal: requestSignal, credentials: "omit", redirect: "follow" });
			const finalUrl = httpUrl(response.url || url).href;
			const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "";
			if (
				contentType &&
				!["text/html", "application/xhtml+xml", "application/json"].includes(contentType) &&
				!contentType.startsWith("text/")
			) {
				await response.body?.cancel();
				throw new Error(`Unsupported content type ${contentType}; use extract_document for documents`);
			}
			const body = await readBody(response);
			requestSignal.throwIfAborted();
			const isHtml =
				["text/html", "application/xhtml+xml"].includes(contentType) ||
				(!contentType && /^\s*(<!doctype html|<html)/i.test(body));
			const extracted = isHtml
				? extractPage(body, finalUrl)
				: { title: "", text: body.trim(), links: [], linksTruncated: false };
			const warnings: string[] = [];
			if (!response.ok)
				warnings.push(`HTTP ${response.status}; content may be an error, login, or bot-protection page.`);
			if (isHtml && extracted.text.length < 200)
				warnings.push("Little readable content; this page may require JavaScript or browser login.");
			const truncated = extracted.text.length > maxChars;
			if (truncated) warnings.push(`Text truncated to ${maxChars} characters; increase maxChars if needed.`);
			return {
				url,
				finalUrl,
				status: response.status,
				contentType,
				...extracted,
				text: extracted.text.slice(0, maxChars),
				truncated,
				requiresBrowser: !response.ok || (isHtml && extracted.text.length < 200),
				warnings,
			};
		} catch (error) {
			if (requestSignal.aborted) throw requestSignal.reason;
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}. Try navigate + browserjs if browser access is needed.`,
			);
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}
