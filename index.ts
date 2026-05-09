/**
 * pi-grok-search Extension (v2)
 *
 * 通过 Grok API + Tavily + Firecrawl 为 pi 提供完整的网络访问能力。
 * 参考: https://github.com/GuDaStudio/GrokSearch
 *
 * 双引擎架构:
 *   - Grok: AI 驱动的智能搜索
 *   - Tavily: 高保真网页抓取与站点映射
 *   - Firecrawl: Tavily 失败时自动托底
 *
 * 功能:
 *   - grok_search: AI 网络搜索（带信源缓存）
 *   - grok_sources: 获取搜索信源
 *   - web_fetch: 网页内容抓取（Tavily → Firecrawl 自动降级）
 *   - web_map: 站点结构映射
 *   - 搜索规划: 6 阶段结构化搜索规划
 *   - 配置诊断: 连接测试 + 模型发现
 *   - CLI 命令: /grok-search, /grok-config, /grok-model, /pi-ext-docs
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// =============================================================================
// Types
// =============================================================================

interface GrokConfigFile {
	apiUrl?: string;
	apiKey?: string;
	model?: string;
	tavilyApiKey?: string;
	tavilyApiUrl?: string;
	firecrawlApiKey?: string;
	firecrawlApiUrl?: string;
}

interface Source {
	url: string;
	title?: string;
	description?: string;
	provider?: string;
}

interface SearchResult {
	content: string;
	sources: Source[];
	sourcesCount: number;
	sessionId: string;
}

interface PlanningSession {
	sessionId: string;
	phases: Record<string, PhaseRecord>;
	complexityLevel: number | null;
}

interface PhaseRecord {
	phase: string;
	thought: string;
	data: unknown;
	confidence: number;
}

// =============================================================================
// Sources Cache
// =============================================================================

class SourcesCache {
	private maxSize: number;
	private cache: Map<string, Source[]>;

	constructor(maxSize = 256) {
		this.maxSize = maxSize;
		this.cache = new Map();
	}

	set(sessionId: string, sources: Source[]): void {
		this.cache.set(sessionId, sources);
		// LRU eviction
		if (this.cache.size > this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey) this.cache.delete(firstKey);
		}
	}

	get(sessionId: string): Source[] | undefined {
		const sources = this.cache.get(sessionId);
		if (sources) {
			// Move to end (most recently used)
			this.cache.delete(sessionId);
			this.cache.set(sessionId, sources);
		}
		return sources;
	}
}

const sourcesCache = new SourcesCache(256);

// =============================================================================
// Planning Engine
// =============================================================================

const PHASE_NAMES = [
	"intent_analysis",
	"complexity_assessment",
	"query_decomposition",
	"search_strategy",
	"tool_selection",
	"execution_order",
];

const REQUIRED_PHASES: Record<number, Set<string>> = {
	1: new Set([
		"intent_analysis",
		"complexity_assessment",
		"query_decomposition",
	]),
	2: new Set([
		"intent_analysis",
		"complexity_assessment",
		"query_decomposition",
		"search_strategy",
		"tool_selection",
	]),
	3: new Set(PHASE_NAMES),
};

class PlanningEngine {
	private sessions: Map<string, PlanningSession>;

	constructor() {
		this.sessions = new Map();
	}

	getSession(sessionId: string): PlanningSession | undefined {
		return this.sessions.get(sessionId);
	}

	processPhase(params: {
		phase: string;
		thought: string;
		sessionId?: string;
		isRevision?: boolean;
		confidence?: number;
		phaseData?: unknown;
	}): Record<string, unknown> {
		const {
			phase,
			thought,
			sessionId,
			isRevision = false,
			confidence = 1.0,
			phaseData,
		} = params;

		if (!PHASE_NAMES.includes(phase)) {
			return {
				error: `Unknown phase: ${phase}. Valid: ${PHASE_NAMES.join(", ")}`,
			};
		}

		let session: PlanningSession;
		if (sessionId && this.sessions.has(sessionId)) {
			session = this.sessions.get(sessionId)!;
		} else {
			const sid = sessionId || this.newSessionId();
			session = { sessionId: sid, phases: {}, complexityLevel: null };
			this.sessions.set(sid, session);
		}

		if (phase === "query_decomposition" || phase === "tool_selection") {
			if (isRevision) {
				session.phases[phase] = {
					phase,
					thought,
					data: Array.isArray(phaseData) ? phaseData : [phaseData],
					confidence,
				};
			} else if (
				session.phases[phase] &&
				Array.isArray(session.phases[phase].data)
			) {
				(session.phases[phase].data as unknown[]).push(phaseData);
				session.phases[phase].thought = thought;
				session.phases[phase].confidence = confidence;
			} else {
				session.phases[phase] = {
					phase,
					thought,
					data: [phaseData],
					confidence,
				};
			}
		} else if (phase === "search_strategy") {
			if (isRevision || !session.phases[phase]) {
				session.phases[phase] = { phase, thought, data: phaseData, confidence };
			} else {
				const existing = session.phases[phase];
				const existingData = existing.data as Record<string, unknown>;
				const newData = phaseData as Record<string, unknown>;
				if (existingData && newData) {
					const existingTerms = (existingData.search_terms as unknown[]) || [];
					const newTerms = (newData.search_terms as unknown[]) || [];
					existingData.search_terms = [...existingTerms, ...newTerms];
					if (newData.approach) existingData.approach = newData.approach;
					if (newData.fallback_plan)
						existingData.fallback_plan = newData.fallback_plan;
					existing.thought = thought;
					existing.confidence = confidence;
				}
			}
		} else {
			session.phases[phase] = { phase, thought, data: phaseData, confidence };
		}

		if (
			phase === "complexity_assessment" &&
			phaseData &&
			typeof phaseData === "object"
		) {
			const level = (phaseData as Record<string, unknown>).level;
			if (level === 1 || level === 2 || level === 3) {
				session.complexityLevel = level;
			}
		}

		const completedPhases = PHASE_NAMES.filter((p) => session.phases[p]);
		const requiredPhases =
			REQUIRED_PHASES[session.complexityLevel || 3] || REQUIRED_PHASES[3];
		const remaining = [...requiredPhases].filter((p) => !session.phases[p]);
		const isComplete =
			session.complexityLevel !== null && remaining.length === 0;

		const result: Record<string, unknown> = {
			session_id: session.sessionId,
			completed_phases: completedPhases,
			complexity_level: session.complexityLevel,
			plan_complete: isComplete,
		};

		if (remaining.length > 0) {
			result.phases_remaining = remaining;
		}

		if (isComplete) {
			const plan: Record<string, unknown> = {};
			for (const [name, record] of Object.entries(session.phases)) {
				plan[name] = record.data;
			}
			result.executable_plan = plan;
		}

		return result;
	}

	private newSessionId(): string {
		return Math.random().toString(36).slice(2, 14);
	}
}

const planningEngine = new PlanningEngine();

// =============================================================================
// Configuration Manager
// =============================================================================

class ConfigManager {
	private configPath: string;
	private configCache: GrokConfigFile | null = null;
	private modelsCache: { key: string; models: string[] } | null = null;

	constructor() {
		this.configPath = join(
			homedir(),
			".config",
			"pi-grok-search",
			"config.json",
		);
	}

	getConfigPath(): string {
		return this.configPath;
	}

	async loadFile(): Promise<GrokConfigFile> {
		try {
			const content = await readFile(this.configPath, "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	async saveFile(config: GrokConfigFile): Promise<void> {
		await mkdir(dirname(this.configPath), { recursive: true });
		await writeFile(this.configPath, JSON.stringify(config, null, 2), "utf-8");
		this.configCache = null;
		this.modelsCache = null;
	}

	async getFullConfig(): Promise<{
		grokApiUrl: string;
		grokApiKey: string;
		grokModel: string;
		tavilyApiUrl: string;
		tavilyApiKey: string;
		firecrawlApiUrl: string;
		firecrawlApiKey: string;
	}> {
		const file = await this.loadFile();
		return {
			grokApiUrl: process.env.GROK_API_URL || file.apiUrl || "",
			grokApiKey: process.env.GROK_API_KEY || file.apiKey || "",
			grokModel: process.env.GROK_MODEL || file.model || "grok-4-fast",
			tavilyApiUrl:
				process.env.TAVILY_API_URL ||
				file.tavilyApiUrl ||
				"https://api.tavily.com",
			tavilyApiKey: process.env.TAVILY_API_KEY || file.tavilyApiKey || "",
			firecrawlApiUrl:
				process.env.FIRECRAWL_API_URL ||
				file.firecrawlApiUrl ||
				"https://api.firecrawl.dev/v2",
			firecrawlApiKey:
				process.env.FIRECRAWL_API_KEY || file.firecrawlApiKey || "",
		};
	}

	async setModel(model: string): Promise<void> {
		const file = await this.loadFile();
		file.model = model;
		await this.saveFile(file);
	}

	async setGrokApi(url: string, key: string): Promise<void> {
		const file = await this.loadFile();
		file.apiUrl = url;
		file.apiKey = key;
		await this.saveFile(file);
	}

	async setTavily(key: string, url?: string): Promise<void> {
		const file = await this.loadFile();
		file.tavilyApiKey = key;
		if (url) file.tavilyApiUrl = url;
		await this.saveFile(file);
	}

	async setFirecrawl(key: string, url?: string): Promise<void> {
		const file = await this.loadFile();
		file.firecrawlApiKey = key;
		if (url) file.firecrawlApiUrl = url;
		await this.saveFile(file);
	}

	maskKey(key: string): string {
		if (!key || key.length <= 8) return "***";
		return `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`;
	}

	getModelsCacheKey(apiUrl: string, apiKey: string): string {
		return `${apiUrl}|${apiKey}`;
	}

	getCachedModels(apiUrl: string, apiKey: string): string[] | null {
		const key = this.getModelsCacheKey(apiUrl, apiKey);
		if (this.modelsCache && this.modelsCache.key === key) {
			return this.modelsCache.models;
		}
		return null;
	}

	setCachedModels(apiUrl: string, apiKey: string, models: string[]): void {
		this.modelsCache = { key: this.getModelsCacheKey(apiUrl, apiKey), models };
	}
}

const configManager = new ConfigManager();

// =============================================================================
// HTTP Utilities
// =============================================================================

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

async function fetchWithRetry(
	url: string,
	init: RequestInit,
	maxRetries = 3,
): Promise<Response> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetch(url, init);

			if (response.status === 429) {
				const retryAfter = response.headers.get("Retry-After");
				let waitMs: number;
				if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
					waitMs = parseInt(retryAfter, 10) * 1000;
				} else {
					waitMs = Math.min(1000 * 2 ** attempt + Math.random() * 1000, 10000);
				}
				await sleep(waitMs);
				continue;
			}

			if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
				await sleep(Math.min(1000 * 2 ** attempt, 10000));
				continue;
			}

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
			}

			return response;
		} catch (e) {
			lastError = e instanceof Error ? e : new Error(String(e));
			if (lastError.name === "AbortError") throw lastError;
			if (attempt < maxRetries) {
				await sleep(Math.min(1000 * 2 ** attempt, 10000));
			}
		}
	}

	throw lastError || new Error("Request failed");
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function newSessionId(): string {
	return Math.random().toString(36).slice(2, 14);
}

function getLocalTimeInfo(): string {
	const now = new Date();
	const weekdays = [
		"星期日",
		"星期一",
		"星期二",
		"星期三",
		"星期四",
		"星期五",
		"星期六",
	];
	const weekday = weekdays[now.getDay()];
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
	const pad = (n: number) => String(n).padStart(2, "0");

	return (
		`[Current Time Context]\n` +
		`- Date: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} (${weekday})\n` +
		`- Time: ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}\n` +
		`- Timezone: ${tz}\n\n`
	);
}

function needsTimeContext(query: string): boolean {
	const cnKeywords = [
		"当前",
		"现在",
		"今天",
		"明天",
		"昨天",
		"本周",
		"上周",
		"下周",
		"本月",
		"上月",
		"下月",
		"今年",
		"去年",
		"明年",
		"最新",
		"最近",
		"近期",
		"刚刚",
		"刚才",
		"实时",
		"目前",
	];
	const enKeywords = [
		"current",
		"now",
		"today",
		"tomorrow",
		"yesterday",
		"this week",
		"last week",
		"next week",
		"this month",
		"last month",
		"latest",
		"recent",
		"recently",
		"just now",
		"real-time",
		"up-to-date",
	];
	const lower = query.toLowerCase();
	return (
		cnKeywords.some((k) => query.includes(k)) ||
		enKeywords.some((k) => lower.includes(k))
	);
}

// =============================================================================
// Source Extraction Utilities
// =============================================================================

const URL_PATTERN = /https?:\/\/[^\s<>"'`，。、；：！？》）】)]+/g;
const MD_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

function extractUrls(text: string): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const m of text.matchAll(URL_PATTERN)) {
		const url = m[0].replace(/[.,;:!?]+$/, "");
		if (!seen.has(url)) {
			seen.add(url);
			urls.push(url);
		}
	}
	return urls;
}

function extractSourcesFromText(text: string): Source[] {
	const sources: Source[] = [];
	const seen = new Set<string>();

	for (const [, title, url] of text.matchAll(MD_LINK_PATTERN)) {
		const cleanUrl = url.trim();
		if (!cleanUrl || seen.has(cleanUrl)) continue;
		seen.add(cleanUrl);
		sources.push({ url: cleanUrl, title: title.trim() || undefined });
	}

	for (const url of extractUrls(text)) {
		if (!seen.has(url)) {
			seen.add(url);
			sources.push({ url });
		}
	}

	return sources;
}

function splitAnswerAndSources(text: string): {
	answer: string;
	sources: Source[];
} {
	const trimmed = text.trim();
	if (!trimmed) return { answer: "", sources: [] };

	// Try to find Sources/References/信源 heading
	const headingPattern =
		/(?:^|\n)(?:#{1,6}\s*)?(?:\*\*)?\s*(?:sources?|references?|citations?|信源|参考资料|参考|引用|来源)\s*(?:\*\*)?\s*[:：]?\s*$/im;
	const match = headingPattern.exec(trimmed);
	if (match) {
		const sourcesText = trimmed.slice(match.index);
		const sources = extractSourcesFromText(sourcesText);
		if (sources.length > 0) {
			return { answer: trimmed.slice(0, match.index).trim(), sources };
		}
	}

	// Try tail link block
	const lines = trimmed.split("\n");
	let tailStart = lines.length;
	let linkCount = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		if (/^https?:\/\//.test(line) || MD_LINK_PATTERN.test(line)) {
			linkCount++;
			tailStart = i;
		} else {
			break;
		}
	}
	if (linkCount >= 2) {
		const tailText = lines.slice(tailStart).join("\n");
		const sources = extractSourcesFromText(tailText);
		if (sources.length > 0) {
			return { answer: lines.slice(0, tailStart).join("\n").trim(), sources };
		}
	}

	return { answer: trimmed, sources: [] };
}

function mergeSources(...lists: Source[][]): Source[] {
	const seen = new Set<string>();
	const merged: Source[] = [];
	for (const list of lists) {
		for (const item of list) {
			if (!item.url || seen.has(item.url)) continue;
			seen.add(item.url);
			merged.push(item);
		}
	}
	return merged;
}

// =============================================================================
// Grok API Client
// =============================================================================

async function grokSearch(
	query: string,
	platform = "",
	signal?: AbortSignal,
): Promise<string> {
	const config = await configManager.getFullConfig();
	if (!config.grokApiUrl || !config.grokApiKey) {
		throw new Error("Grok API 未配置。请使用 /grok-config 命令配置。");
	}

	const timeContext = needsTimeContext(query) ? getLocalTimeInfo() : "";
	const platformPrompt = platform
		? `\n\nYou should search the web for the information you need, and focus on these platform: ${platform}\n`
		: "";

	const payload = {
		model: config.grokModel,
		messages: [
			{ role: "system", content: SEARCH_PROMPT },
			{ role: "user", content: timeContext + query + platformPrompt },
		],
		stream: true,
	};

	const response = await fetchWithRetry(
		`${config.grokApiUrl.replace(/\/+$/, "")}/chat/completions`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.grokApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
			signal,
		},
	);

	return parseStreamResponse(response);
}

async function grokFetch(url: string, signal?: AbortSignal): Promise<string> {
	const config = await configManager.getFullConfig();
	if (!config.grokApiUrl || !config.grokApiKey) {
		throw new Error("Grok API 未配置。");
	}

	const payload = {
		model: config.grokModel,
		messages: [
			{ role: "system", content: FETCH_PROMPT },
			{
				role: "user",
				content: `${url}\n获取该网页内容并返回其结构化Markdown格式`,
			},
		],
		stream: true,
	};

	const response = await fetchWithRetry(
		`${config.grokApiUrl.replace(/\/+$/, "")}/chat/completions`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.grokApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
			signal,
		},
	);

	return parseStreamResponse(response);
}

async function parseStreamResponse(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("无法读取响应流");

	const decoder = new TextDecoder();
	let content = "";
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith("data:")) continue;
				if (trimmed === "data: [DONE]" || trimmed === "data:[DONE]") continue;

				try {
					const data = JSON.parse(trimmed.slice(5).trim());
					const delta = data.choices?.[0]?.delta;
					if (delta?.content) content += delta.content;
				} catch {
					// skip malformed chunks
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Fallback: non-streaming
	if (!content) {
		try {
			const data = (await response.clone().json()) as Record<string, unknown>;
			const choices = data.choices as
				| Array<{ message?: { content?: string } }>
				| undefined;
			content = choices?.[0]?.message?.content || "";
		} catch {
			// ignore
		}
	}

	return content;
}

// =============================================================================
// Tavily API Client
// =============================================================================

async function tavilySearch(
	query: string,
	maxResults = 6,
	signal?: AbortSignal,
): Promise<Source[]> {
	const config = await configManager.getFullConfig();
	if (!config.tavilyApiKey) return [];

	const response = await fetchWithRetry(
		`${config.tavilyApiUrl.replace(/\/+$/, "")}/search`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.tavilyApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query,
				max_results: maxResults,
				search_depth: "advanced",
				include_raw_content: false,
				include_answer: false,
			}),
			signal,
		},
	);

	const data = (await response.json()) as {
		results?: Array<{
			title?: string;
			url: string;
			content?: string;
			score?: number;
		}>;
	};

	return (data.results || []).map((r) => ({
		url: r.url,
		title: r.title || undefined,
		description: r.content || undefined,
		provider: "tavily",
	}));
}

async function tavilyExtract(
	url: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const config = await configManager.getFullConfig();
	if (!config.tavilyApiKey) return null;

	try {
		const response = await fetch(
			`${config.tavilyApiUrl.replace(/\/+$/, "")}/extract`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.tavilyApiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ urls: [url], format: "markdown" }),
				signal,
			},
		);

		if (!response.ok) return null;

		const data = (await response.json()) as {
			results?: Array<{ raw_content?: string }>;
		};

		const content = data.results?.[0]?.raw_content;
		return content?.trim() || null;
	} catch {
		return null;
	}
}

async function tavilyMap(
	url: string,
	options: {
		instructions?: string;
		maxDepth?: number;
		maxBreadth?: number;
		limit?: number;
		timeout?: number;
	},
	signal?: AbortSignal,
): Promise<string> {
	const config = await configManager.getFullConfig();
	if (!config.tavilyApiKey) {
		return "配置错误: TAVILY_API_KEY 未配置，请使用 /grok-config 设置 Tavily API Key。";
	}

	const timeout = options.timeout || 150;

	try {
		const response = await fetch(
			`${config.tavilyApiUrl.replace(/\/+$/, "")}/map`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.tavilyApiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					url,
					max_depth: options.maxDepth || 1,
					max_breadth: options.maxBreadth || 20,
					limit: options.limit || 50,
					timeout,
					...(options.instructions
						? { instructions: options.instructions }
						: {}),
				}),
				signal: AbortSignal.timeout((timeout + 10) * 1000),
			},
		);

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return `映射失败: HTTP ${response.status} - ${text.slice(0, 200)}`;
		}

		const data = (await response.json()) as {
			base_url?: string;
			results?: string[];
			response_time?: number;
		};

		return JSON.stringify(
			{
				base_url: data.base_url || url,
				results: data.results || [],
				response_time: data.response_time || 0,
			},
			null,
			2,
		);
	} catch (e) {
		return `映射错误: ${e instanceof Error ? e.message : String(e)}`;
	}
}

// =============================================================================
// Firecrawl API Client
// =============================================================================

async function firecrawlSearch(
	query: string,
	limit = 14,
	signal?: AbortSignal,
): Promise<Source[]> {
	const config = await configManager.getFullConfig();
	if (!config.firecrawlApiKey) return [];

	try {
		const response = await fetch(
			`${config.firecrawlApiUrl.replace(/\/+$/, "")}/search`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.firecrawlApiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query, limit }),
				signal,
			},
		);

		if (!response.ok) return [];

		const data = (await response.json()) as {
			data?: {
				web?: Array<{ title?: string; url: string; description?: string }>;
			};
		};

		return (data.data?.web || []).map((r) => ({
			url: r.url,
			title: r.title || undefined,
			description: r.description || undefined,
			provider: "firecrawl",
		}));
	} catch {
		return [];
	}
}

async function firecrawlScrape(
	url: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const config = await configManager.getFullConfig();
	if (!config.firecrawlApiKey) return null;

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const response = await fetch(
				`${config.firecrawlApiUrl.replace(/\/+$/, "")}/scrape`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${config.firecrawlApiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						url,
						formats: ["markdown"],
						timeout: 60000,
						waitFor: (attempt + 1) * 1500,
					}),
					signal,
				},
			);

			if (!response.ok) return null;

			const data = (await response.json()) as {
				data?: { markdown?: string };
			};

			const md = data.data?.markdown;
			if (md?.trim()) return md;
		} catch {
			return null;
		}
	}

	return null;
}

// =============================================================================
// Prompts
// =============================================================================

const SEARCH_PROMPT = `# Core Instruction

1. User needs may be vague. Think divergently, infer intent from multiple angles, and leverage full conversation context to progressively clarify their true needs.
2. **Breadth-First Search**—Approach problems from multiple dimensions. Brainstorm 5+ perspectives and execute parallel searches for each. Consult as many high-quality sources as possible before responding.
3. **Depth-First Search**—After broad exploration, select ≥2 most relevant perspectives for deep investigation into specialized knowledge.
4. **Evidence-Based Reasoning & Traceable Sources**—Every claim must be followed by a citation (URL). More credible sources strengthen arguments. If no references exist, remain silent.
5. Before responding, ensure full execution of Steps 1–4.

# Search Instruction

1. Think carefully before responding—anticipate the user's true intent to ensure precision.
2. Verify every claim rigorously to avoid misinformation.
3. Follow problem logic—dig deeper until clues are exhaustively clear. If a question seems simple, still infer broader intent and search accordingly. Use multiple parallel tool calls per query and ensure answers are well-sourced.
4. Search in English first (prioritizing English resources for volume/quality), but switch to Chinese if context demands.
5. Prioritize authoritative sources: Wikipedia, academic databases, books, reputable media/journalism.
6. Favor sharing in-depth, specialized knowledge over generic or common-sense content.

# Output Style

0. **Be direct—no unnecessary follow-ups**.
1. Lead with the **most probable solution** before detailed analysis.
2. **Define every technical term** in plain language.
3. **Every sentence must cite sources** (URLs). Silence if uncited.
4. **Strictly format outputs in polished Markdown**.
`;

const FETCH_PROMPT = `You are a professional web content fetcher. Given a URL, fetch its content and return a structured Markdown document.

Rules:
- Preserve the original content structure (headings, lists, tables, code blocks)
- Convert HTML to clean Markdown
- Do NOT summarize or modify the content
- Return the complete content as-is
- Use proper Markdown formatting: # for headings, **bold**, *italic*, \`code\`, etc.
`;

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	// =========================================================================
	// Tool: grok_search — AI 网络搜索
	// =========================================================================
	pi.registerTool({
		name: "grok_search",
		label: "Grok Search",
		description:
			"通过 Grok API 执行 AI 驱动的深度网络搜索。自动检测时间相关查询并注入时间上下文。\n" +
			"返回搜索结果正文和 session_id（用于 grok_sources 获取信源）。\n" +
			"适用：查找技术文档、API 规范、开源项目、pi Extension 开发指南等。",
		promptSnippet:
			"通过 Grok API 执行 AI 深度网络搜索（文档、API、开源项目等）",
		promptGuidelines: [
			// === Search Trigger Conditions ===
			"Use grok_search when the user asks to search the web, find documentation, or look up technical information.",
			"Use grok_search to find pi Extension development docs, API references, and best practices.",
			"Strictly distinguish internal vs external knowledge. Even if you possess common-sense knowledge about a topic (e.g., a library like FastAPI), you MUST still use grok_search to verify with latest search results or official documentation.",
			"When uncertain about facts, explicitly inform the user of limitations rather than speculating from internal knowledge.",
			// === Search Execution ===
			"Search queries to grok_search MUST be in English for maximum coverage. Final user-facing output MUST be in Chinese.",
			"Execute independent grok_search calls in PARALLEL. Sequential execution only when one search depends on another's results.",
			"Prioritize authoritative sources: official docs, Wikipedia, academic databases, GitHub repos, reputable media.",
			// === Source Quality ===
			"Key factual claims MUST be supported by ≥2 independent sources. Single-source claims: explicitly state this limitation.",
			"Conflicting sources: Present evidence from both sides, assess credibility/timeliness, identify stronger evidence, or declare unresolved discrepancies.",
			"Empirical conclusions MUST include confidence levels (High/Medium/Low).",
			// === Post-Search Behavior ===
			"After grok_search, call grok_sources with the returned session_id to retrieve source URLs if needed.",
			"After grok_search returns results, use web_fetch to get full content from interesting URLs.",
			// === Output Standards ===
			"All conclusions MUST specify: applicable conditions, scope boundaries, and known limitations.",
			"When uncertain: state unknowns and reasons BEFORE presenting confirmed facts.",
			"Challenge flawed premises: when user logic contains errors, pinpoint specific issues with evidence.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "搜索查询，清晰、自包含的自然语言问题",
			}),
			platform: Type.Optional(
				Type.String({
					description:
						'聚焦平台，如 "Twitter", "GitHub, Reddit"。留空为全网搜索。',
				}),
			),
			extra_sources: Type.Optional(
				Type.Number({
					description:
						"额外补充信源数量（Tavily/Firecrawl），0 为关闭。默认 0。",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "🔍 正在搜索..." }] });

			try {
				const config = await configManager.getFullConfig();
				const sessionId = newSessionId();

				// Parallel: Grok search + optional Tavily/Firecrawl
				const hasTavily = !!config.tavilyApiKey;
				const hasFirecrawl = !!config.firecrawlApiKey;
				const extraCount = params.extra_sources || 0;

				const tasks: Promise<unknown>[] = [
					grokSearch(params.query, params.platform || "", signal),
				];

				if (extraCount > 0 && hasTavily) {
					tasks.push(tavilySearch(params.query, extraCount, signal));
				}
				if (extraCount > 0 && hasFirecrawl) {
					tasks.push(
						firecrawlSearch(params.query, Math.round(extraCount * 0.7), signal),
					);
				}

				const results = await Promise.allSettled(tasks);

				const grokResult =
					results[0].status === "fulfilled" ? (results[0].value as string) : "";
				const tavilySources =
					extraCount > 0 && hasTavily && results[1]?.status === "fulfilled"
						? (results[1].value as Source[])
						: [];
				const firecrawlSources =
					extraCount > 0 &&
					hasFirecrawl &&
					results[results.length - 1]?.status === "fulfilled"
						? (results[results.length - 1].value as Source[])
						: [];

				// Parse Grok response
				const { answer, sources: grokSources } =
					splitAnswerAndSources(grokResult);
				const allSources = mergeSources(
					grokSources,
					tavilySources,
					firecrawlSources,
				);

				// Cache sources
				sourcesCache.set(sessionId, allSources);

				// Build output
				let output = answer;
				if (allSources.length > 0) {
					output += `\n\n---\n**信源 (${allSources.length})** | session_id: \`${sessionId}\`\n`;
					for (const s of allSources.slice(0, 10)) {
						output += s.title ? `- [${s.title}](${s.url})\n` : `- ${s.url}\n`;
					}
					if (allSources.length > 10) {
						output += `- ... 还有 ${allSources.length - 10} 个信源，使用 grok_sources 获取\n`;
					}
				}

				return {
					content: [{ type: "text", text: output }],
					details: {
						session_id: sessionId,
						content: answer,
						sources_count: allSources.length,
						sources: allSources,
					},
				};
			} catch (e) {
				throw new Error(
					`搜索失败: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	});

	// =========================================================================
	// Tool: grok_sources — 获取缓存信源
	// =========================================================================
	pi.registerTool({
		name: "grok_sources",
		label: "Grok Sources",
		description:
			"通过 session_id 获取之前 grok_search 缓存的完整信源列表。\n" +
			"当对搜索结果感兴趣或需要更多参考链接时使用。",
		promptSnippet: "通过 session_id 获取搜索信源列表",
		promptGuidelines: [
			"Use grok_sources with the session_id from grok_search to retrieve the full source list when you need more reference URLs.",
		],
		parameters: Type.Object({
			session_id: Type.String({ description: "grok_search 返回的 session_id" }),
		}),

		async execute(_toolCallId, params) {
			const sources = sourcesCache.get(params.session_id);
			if (!sources) {
				return {
					content: [
						{
							type: "text",
							text: `未找到 session_id: ${params.session_id} 的信源缓存（可能已过期）`,
						},
					],
					details: {
						session_id: params.session_id,
						sources: [],
						sources_count: 0,
					},
				};
			}

			let output = `## 信源列表 (${sources.length})\n\n`;
			for (const s of sources) {
				if (s.title) {
					output += `- **[${s.title}](${s.url})**`;
				} else {
					output += `- ${s.url}`;
				}
				if (s.description) output += ` — ${s.description.slice(0, 100)}`;
				if (s.provider) output += ` [${s.provider}]`;
				output += "\n";
			}

			return {
				content: [{ type: "text", text: output }],
				details: {
					session_id: params.session_id,
					sources,
					sources_count: sources.length,
				},
			};
		},
	});

	// =========================================================================
	// Tool: web_fetch — 网页内容抓取（Tavily → Firecrawl 自动降级）
	// =========================================================================
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"抓取并提取指定 URL 的完整网页内容，返回 Markdown 格式。\n" +
			"优先使用 Tavily Extract，失败时自动降级到 Firecrawl Scrape。\n" +
			"100% 内容保真，不做摘要或修改。",
		promptSnippet: "抓取网页完整内容（Tavily → Firecrawl 自动降级）",
		promptGuidelines: [
			"Use web_fetch to get the full content of a specific webpage URL.",
			"Use web_fetch after grok_search to read detailed content from search result URLs.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "要抓取的网页 URL（HTTP/HTTPS）" }),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "📄 正在抓取网页..." }] });

			const config = await configManager.getFullConfig();

			// Try Tavily first
			if (config.tavilyApiKey) {
				const result = await tavilyExtract(params.url, signal);
				if (result) {
					return {
						content: [{ type: "text", text: result }],
						details: { url: params.url, provider: "tavily" },
					};
				}
			}

			// Fallback to Firecrawl
			if (config.firecrawlApiKey) {
				onUpdate?.({
					content: [
						{ type: "text", text: "📄 Tavily 失败，尝试 Firecrawl..." },
					],
				});
				const result = await firecrawlScrape(params.url, signal);
				if (result) {
					return {
						content: [{ type: "text", text: result }],
						details: { url: params.url, provider: "firecrawl" },
					};
				}
			}

			// Both failed or not configured
			if (!config.tavilyApiKey && !config.firecrawlApiKey) {
				return {
					content: [
						{
							type: "text",
							text: "配置错误: TAVILY_API_KEY 和 FIRECRAWL_API_KEY 均未配置。\n请使用 /grok-config 设置至少一个。",
						},
					],
					details: { url: params.url, error: "not_configured" },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "提取失败: 所有提取服务均未能获取内容。可尝试用 grok_search 搜索相关内容。",
					},
				],
				details: { url: params.url, error: "all_failed" },
			};
		},
	});

	// =========================================================================
	// Tool: web_map — 站点结构映射
	// =========================================================================
	pi.registerTool({
		name: "web_map",
		label: "Web Map",
		description:
			"通过 Tavily Map API 遍历网站结构，发现 URL 并生成站点地图。\n" +
			"从根 URL 开始图遍历，支持深度/广度控制和自然语言过滤。",
		promptSnippet: "遍历网站结构，发现 URL 生成站点地图",
		promptGuidelines: [
			"Use web_map to discover a website's structure and find specific pages.",
			"Start with low max_depth (1-2) for initial exploration.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "起始 URL（如 'https://docs.example.com'）",
			}),
			instructions: Type.Optional(
				Type.String({
					description: "自然语言过滤指令（如 'only documentation pages'）",
				}),
			),
			max_depth: Type.Optional(
				Type.Number({ description: "最大遍历深度（1-5），默认 1" }),
			),
			max_breadth: Type.Optional(
				Type.Number({ description: "每页最大跟踪链接数（1-500），默认 20" }),
			),
			limit: Type.Optional(
				Type.Number({ description: "总链接处理上限（1-500），默认 50" }),
			),
			timeout: Type.Optional(
				Type.Number({ description: "超时秒数（10-150），默认 150" }),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const result = await tavilyMap(
				params.url,
				{
					instructions: params.instructions,
					maxDepth: params.max_depth,
					maxBreadth: params.max_breadth,
					limit: params.limit,
					timeout: params.timeout,
				},
				signal,
			);
			return {
				content: [{ type: "text", text: result }],
				details: { url: params.url },
			};
		},
	});

	// =========================================================================
	// Tool: grok_config — 配置管理
	// =========================================================================
	pi.registerTool({
		name: "grok_config",
		label: "Grok Config",
		description:
			"查看或修改 Grok Search 的完整配置（Grok/Tavily/Firecrawl API）。",
		promptSnippet: "查看或修改 Grok Search 配置",
		parameters: Type.Object({
			action: StringEnum(["show", "set", "test"] as const),
			key: Type.Optional(
				StringEnum([
					"grokApiUrl",
					"grokApiKey",
					"model",
					"tavilyApiKey",
					"tavilyApiUrl",
					"firecrawlApiKey",
					"firecrawlApiUrl",
				] as const),
			),
			value: Type.Optional(Type.String()),
		}),

		async execute(_toolCallId, params) {
			const config = await configManager.getFullConfig();

			if (params.action === "show") {
				const lines = [
					"## Grok Search 配置\n",
					"| 配置项 | 值 |",
					"|--------|-----|",
					`| Grok API URL | ${config.grokApiUrl || "❌ 未配置"} |`,
					`| Grok API Key | ${config.grokApiKey ? configManager.maskKey(config.grokApiKey) : "❌ 未配置"} |`,
					`| Grok 模型 | ${config.grokModel} |`,
					`| Tavily API URL | ${config.tavilyApiUrl} |`,
					`| Tavily API Key | ${config.tavilyApiKey ? configManager.maskKey(config.tavilyApiKey) : "❌ 未配置"} |`,
					`| Firecrawl API URL | ${config.firecrawlApiUrl} |`,
					`| Firecrawl API Key | ${config.firecrawlApiKey ? configManager.maskKey(config.firecrawlApiKey) : "❌ 未配置"} |`,
					`| 配置文件 | ${configManager.getConfigPath()} |`,
				];

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: config,
				};
			}

			if (params.action === "test") {
				const results: string[] = ["## 连接测试\n"];

				// Test Grok
				if (config.grokApiUrl && config.grokApiKey) {
					try {
						const start = Date.now();
						const response = await fetch(
							`${config.grokApiUrl.replace(/\/+$/, "")}/models`,
							{
								headers: { Authorization: `Bearer ${config.grokApiKey}` },
								signal: AbortSignal.timeout(10000),
							},
						);
						const elapsed = Date.now() - start;
						if (response.ok) {
							const data = (await response.json()) as {
								data?: Array<{ id: string }>;
							};
							const models = (data.data || []).map((m) => m.id);
							configManager.setCachedModels(
								config.grokApiUrl,
								config.grokApiKey,
								models,
							);
							results.push(
								`✅ **Grok API**: 连接成功 (${elapsed}ms)，${models.length} 个模型`,
							);
							if (models.length > 0) {
								results.push(
									`   模型: ${models.slice(0, 10).join(", ")}${models.length > 10 ? "..." : ""}`,
								);
							}
						} else {
							results.push(`⚠️ **Grok API**: HTTP ${response.status}`);
						}
					} catch (e) {
						results.push(
							`❌ **Grok API**: ${e instanceof Error ? e.message : String(e)}`,
						);
					}
				} else {
					results.push("⏭️ **Grok API**: 未配置");
				}

				// Test Tavily
				if (config.tavilyApiKey) {
					try {
						const response = await fetch(
							`${config.tavilyApiUrl.replace(/\/+$/, "")}/search`,
							{
								method: "POST",
								headers: {
									Authorization: `Bearer ${config.tavilyApiKey}`,
									"Content-Type": "application/json",
								},
								body: JSON.stringify({ query: "test", max_results: 1 }),
								signal: AbortSignal.timeout(10000),
							},
						);
						results.push(
							response.ok
								? "✅ **Tavily API**: 连接成功"
								: `⚠️ **Tavily API**: HTTP ${response.status}`,
						);
					} catch {
						results.push("❌ **Tavily API**: 连接失败");
					}
				} else {
					results.push("⏭️ **Tavily API**: 未配置");
				}

				// Test Firecrawl
				if (config.firecrawlApiKey) {
					try {
						const response = await fetch(
							`${config.firecrawlApiUrl.replace(/\/+$/, "")}/scrape`,
							{
								method: "POST",
								headers: {
									Authorization: `Bearer ${config.firecrawlApiKey}`,
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									url: "https://example.com",
									formats: ["markdown"],
								}),
								signal: AbortSignal.timeout(15000),
							},
						);
						results.push(
							response.ok
								? "✅ **Firecrawl API**: 连接成功"
								: `⚠️ **Firecrawl API**: HTTP ${response.status}`,
						);
					} catch {
						results.push("❌ **Firecrawl API**: 连接失败");
					}
				} else {
					results.push("⏭️ **Firecrawl API**: 未配置");
				}

				return {
					content: [{ type: "text", text: results.join("\n") }],
					details: { tested: true },
				};
			}

			if (params.action === "set") {
				if (!params.key || !params.value) {
					throw new Error("action=set 时 key 和 value 为必填项");
				}

				const displayValue = params.key.toLowerCase().includes("key")
					? configManager.maskKey(params.value)
					: params.value;

				switch (params.key) {
					case "grokApiUrl": {
						const file = await configManager.loadFile();
						await configManager.setGrokApi(
							params.value,
							file.apiKey || config.grokApiKey,
						);
						break;
					}
					case "grokApiKey": {
						const file = await configManager.loadFile();
						await configManager.setGrokApi(
							file.apiUrl || config.grokApiUrl,
							params.value,
						);
						break;
					}
					case "model":
						await configManager.setModel(params.value);
						break;
					case "tavilyApiKey":
						await configManager.setTavily(params.value);
						break;
					case "tavilyApiUrl":
						await configManager.setTavily(config.tavilyApiKey, params.value);
						break;
					case "firecrawlApiKey":
						await configManager.setFirecrawl(params.value);
						break;
					case "firecrawlApiUrl":
						await configManager.setFirecrawl(
							config.firecrawlApiKey,
							params.value,
						);
						break;
				}

				return {
					content: [
						{ type: "text", text: `✅ 已更新 ${params.key} = ${displayValue}` },
					],
					details: { key: params.key, updated: true },
				};
			}

			throw new Error(`未知 action: ${params.action}`);
		},
	});

	// =========================================================================
	// Tool: search_planning — 搜索规划（6 阶段）
	// =========================================================================
	pi.registerTool({
		name: "search_planning",
		label: "Search Planning",
		description:
			"结构化搜索规划工具。在执行复杂搜索前先生成可执行的搜索计划。\n" +
			"流程: plan_intent → plan_complexity → plan_sub_query(×N) → plan_search_term(×N) → plan_tool_mapping(×N) → plan_execution\n" +
			"复杂度 Level 1 = 阶段 1-3; Level 2 = 阶段 1-5; Level 3 = 全部 6 阶段。",
		promptSnippet: "结构化搜索规划（分阶段、多轮）",
		promptGuidelines: [
			"Use search_planning before executing complex, multi-faceted searches to create a structured plan.",
		],
		parameters: Type.Object({
			phase: StringEnum([
				"intent_analysis",
				"complexity_assessment",
				"query_decomposition",
				"search_strategy",
				"tool_selection",
				"execution_order",
			] as const),
			thought: Type.String({ description: "本阶段的推理过程" }),
			session_id: Type.Optional(
				Type.String({ description: "留空创建新会话，或传入已有 ID" }),
			),
			is_revision: Type.Optional(
				Type.Boolean({ description: "是否覆盖已有阶段" }),
			),
			confidence: Type.Optional(Type.Number({ description: "置信度 0.0-1.0" })),
			phase_data: Type.String({ description: "阶段数据，JSON 字符串格式" }),
		}),

		async execute(_toolCallId, params) {
			let phaseData: unknown;
			try {
				phaseData = JSON.parse(params.phase_data);
			} catch {
				phaseData = params.phase_data;
			}

			const result = planningEngine.processPhase({
				phase: params.phase,
				thought: params.thought,
				sessionId: params.session_id,
				isRevision: params.is_revision,
				confidence: params.confidence,
				phaseData,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	// =========================================================================
	// Command: /grok-search
	// =========================================================================
	pi.registerCommand("grok-search", {
		description: "使用 Grok 搜索网络（/grok-search <query>）",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("用法: /grok-search <搜索内容>", "warning");
				return;
			}

			ctx.ui.setStatus("grok", "🔍 搜索中...");

			try {
				const raw = await grokSearch(args.trim());
				const { answer, sources } = splitAnswerAndSources(raw);

				let output = answer;
				if (sources.length > 0) {
					const sessionId = newSessionId();
					sourcesCache.set(sessionId, sources);
					output += `\n\n---\n**信源 (${sources.length})** | session_id: \`${sessionId}\`\n`;
					for (const s of sources.slice(0, 10)) {
						output += s.title ? `- [${s.title}](${s.url})\n` : `- ${s.url}\n`;
					}
				}

				pi.sendMessage(
					{
						customType: "grok-search",
						content: output,
						display: true,
						details: { sources },
					},
					{ triggerTurn: true },
				);
			} catch (e) {
				ctx.ui.notify(
					`搜索失败: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			} finally {
				ctx.ui.setStatus("grok", undefined);
			}
		},
	});

	// =========================================================================
	// Command: /grok-config
	// =========================================================================
	pi.registerCommand("grok-config", {
		description: "配置 Grok Search（Grok / Tavily / Firecrawl API）",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select("Grok Search 配置:", [
				"查看当前配置",
				"设置 Grok API",
				"设置 Tavily API",
				"设置 Firecrawl API",
				"切换模型",
				"测试所有连接",
			]);

			if (!choice) return;

			switch (choice) {
				case "查看当前配置": {
					const config = await configManager.getFullConfig();
					const lines = [
						`Grok: ${config.grokApiUrl || "未配置"} | ${config.grokApiKey ? configManager.maskKey(config.grokApiKey) : "未配置"}`,
						`模型: ${config.grokModel}`,
						`Tavily: ${config.tavilyApiKey ? configManager.maskKey(config.tavilyApiKey) : "未配置"}`,
						`Firecrawl: ${config.firecrawlApiKey ? configManager.maskKey(config.firecrawlApiKey) : "未配置"}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				case "设置 Grok API": {
					const url = await ctx.ui.input(
						"Grok API URL:",
						"https://api.x.ai/v1",
					);
					if (!url) return;
					const key = await ctx.ui.input("Grok API Key:", "");
					if (!key) return;
					const file = await configManager.loadFile();
					await configManager.setGrokApi(url, key);
					ctx.ui.notify(`✅ Grok API 已配置`, "success");
					break;
				}

				case "设置 Tavily API": {
					const key = await ctx.ui.input("Tavily API Key:", "");
					if (!key) return;
					await configManager.setTavily(key);
					ctx.ui.notify(`✅ Tavily API 已配置`, "success");
					break;
				}

				case "设置 Firecrawl API": {
					const key = await ctx.ui.input("Firecrawl API Key:", "");
					if (!key) return;
					await configManager.setFirecrawl(key);
					ctx.ui.notify(`✅ Firecrawl API 已配置`, "success");
					break;
				}

				case "切换模型": {
					const config = await configManager.getFullConfig();
					ctx.ui.notify("正在获取可用模型...", "info");

					// Try cached first
					let models = configManager.getCachedModels(
						config.grokApiUrl,
						config.grokApiKey,
					);

					if (!models && config.grokApiUrl && config.grokApiKey) {
						try {
							const response = await fetch(
								`${config.grokApiUrl.replace(/\/+$/, "")}/models`,
								{
									headers: { Authorization: `Bearer ${config.grokApiKey}` },
									signal: AbortSignal.timeout(10000),
								},
							);
							if (response.ok) {
								const data = (await response.json()) as {
									data?: Array<{ id: string }>;
								};
								models = (data.data || []).map((m) => m.id);
								configManager.setCachedModels(
									config.grokApiUrl,
									config.grokApiKey,
									models,
								);
							}
						} catch {
							// ignore
						}
					}

					if (models && models.length > 0) {
						const choice = await ctx.ui.select(
							`当前: ${config.grokModel}`,
							models,
						);
						if (choice) {
							await configManager.setModel(choice);
							ctx.ui.notify(`✅ 模型已切换: ${choice}`, "success");
						}
					} else {
						const model = await ctx.ui.input("输入模型 ID:", config.grokModel);
						if (model) {
							await configManager.setModel(model);
							ctx.ui.notify(`✅ 模型已切换: ${model}`, "success");
						}
					}
					break;
				}

				case "测试所有连接": {
					ctx.ui.notify("正在测试连接...", "info");
					const results: string[] = [];
					const config = await configManager.getFullConfig();

					if (config.grokApiUrl && config.grokApiKey) {
						try {
							const start = Date.now();
							const response = await fetch(
								`${config.grokApiUrl.replace(/\/+$/, "")}/models`,
								{
									headers: { Authorization: `Bearer ${config.grokApiKey}` },
									signal: AbortSignal.timeout(10000),
								},
							);
							const elapsed = Date.now() - start;
							if (response.ok) {
								const data = (await response.json()) as {
									data?: Array<{ id: string }>;
								};
								const count = (data.data || []).length;
								results.push(`✅ Grok: ${elapsed}ms, ${count} 模型`);
							} else {
								results.push(`⚠️ Grok: HTTP ${response.status}`);
							}
						} catch {
							results.push("❌ Grok: 连接失败");
						}
					} else {
						results.push("⏭️ Grok: 未配置");
					}

					results.push(
						config.tavilyApiKey ? "✅ Tavily: 已配置" : "⏭️ Tavily: 未配置",
					);
					results.push(
						config.firecrawlApiKey
							? "✅ Firecrawl: 已配置"
							: "⏭️ Firecrawl: 未配置",
					);

					ctx.ui.notify(results.join("\n"), "info");
					break;
				}
			}
		},
	});

	// =========================================================================
	// Command: /grok-model
	// =========================================================================
	pi.registerCommand("grok-model", {
		description: "快速切换 Grok 模型（/grok-model [model-id]）",
		handler: async (args, ctx) => {
			if (args.trim()) {
				await configManager.setModel(args.trim());
				ctx.ui.notify(`✅ 模型已切换: ${args.trim()}`, "success");
				return;
			}

			const config = await configManager.getFullConfig();
			let models = configManager.getCachedModels(
				config.grokApiUrl,
				config.grokApiKey,
			);

			if (!models && config.grokApiUrl && config.grokApiKey) {
				ctx.ui.notify("正在获取可用模型...", "info");
				try {
					const response = await fetch(
						`${config.grokApiUrl.replace(/\/+$/, "")}/models`,
						{
							headers: { Authorization: `Bearer ${config.grokApiKey}` },
							signal: AbortSignal.timeout(10000),
						},
					);
					if (response.ok) {
						const data = (await response.json()) as {
							data?: Array<{ id: string }>;
						};
						models = (data.data || []).map((m) => m.id);
						configManager.setCachedModels(
							config.grokApiUrl,
							config.grokApiKey,
							models,
						);
					}
				} catch {
					// ignore
				}
			}

			if (models && models.length > 0) {
				const choice = await ctx.ui.select(`当前: ${config.grokModel}`, models);
				if (choice) {
					await configManager.setModel(choice);
					ctx.ui.notify(`✅ 模型已切换: ${choice}`, "success");
				}
			} else {
				const model = await ctx.ui.input("输入模型 ID:", config.grokModel);
				if (model) {
					await configManager.setModel(model);
					ctx.ui.notify(`✅ 模型已切换: ${model}`, "success");
				}
			}
		},
	});

	// =========================================================================
	// Command: /pi-ext-docs
	// =========================================================================
	pi.registerCommand("pi-ext-docs", {
		description: "搜索 pi Extension 开发文档（/pi-ext-docs [topic]）",
		handler: async (args, ctx) => {
			const topic =
				args.trim() || "pi Extension API registerTool registerCommand";
			ctx.ui.setStatus("grok", "📚 搜索 pi 文档...");

			try {
				const raw = await grokSearch(
					`site:github.com earendil-works pi coding agent extensions ${topic}`,
				);
				const { answer, sources } = splitAnswerAndSources(raw);

				let output = `## pi Extension 文档搜索: ${topic}\n\n${answer}`;
				if (sources.length > 0) {
					output += "\n\n### 相关链接\n";
					for (const s of sources.slice(0, 8)) {
						output += s.title ? `- [${s.title}](${s.url})\n` : `- ${s.url}\n`;
					}
				}

				pi.sendMessage(
					{
						customType: "grok-search",
						content: output,
						display: true,
						details: { sources },
					},
					{ triggerTurn: true },
				);
			} catch (e) {
				ctx.ui.notify(
					`搜索失败: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			} finally {
				ctx.ui.setStatus("grok", undefined);
			}
		},
	});

	// =========================================================================
	// Message Renderer
	// =========================================================================
	pi.registerMessageRenderer("grok-search", (message, options, theme) => {
		const { expanded } = options;
		let text = theme.fg("accent", "🔍 Grok Search\n\n");
		text += message.content;

		if (expanded && message.details?.sources?.length) {
			text += "\n\n" + theme.fg("muted", "─── 信源 ───\n");
			for (const s of message.details.sources) {
				const label = s.title || s.url;
				const provider = s.provider ? ` [${s.provider}]` : "";
				text += theme.fg("dim", `• ${label}${provider}\n`);
			}
		}

		return new Text(text, 0, 0);
	});

	// =========================================================================
	// Session Start: Show status
	// =========================================================================
	pi.on("session_start", async (_event, ctx) => {
		const config = await configManager.getFullConfig();
		const services: string[] = [];
		if (config.grokApiUrl) services.push("Grok");
		if (config.tavilyApiKey) services.push("Tavily");
		if (config.firecrawlApiKey) services.push("Firecrawl");

		if (services.length > 0) {
			ctx.ui.setStatus("grok", `${services.join("+")} | ${config.grokModel}`);
		} else {
			ctx.ui.setStatus("grok", "Grok: 未配置 (/grok-config)");
		}
	});
}
