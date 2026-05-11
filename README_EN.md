# pi-grok-search

English | [简体中文](./README.md)

Complete web access for [pi](https://github.com/earendil-works/pi-mono) powered by [Grok API](https://docs.x.ai/) + [Tavily](https://tavily.com/) + [Firecrawl](https://firecrawl.dev/).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Inspired by [GrokSearch MCP](https://github.com/GuDaStudio/GrokSearch)

## Architecture

```
pi ──Extension──► pi-grok-search
                    ├─ grok_search     ───► Grok API (AI Deep Search)
                    ├─ grok_sources    ───► Source Cache (by session_id)
                    ├─ web_fetch       ───► Tavily Extract → Firecrawl Scrape (auto-fallback)
                    ├─ web_map         ───► Tavily Map (Site Mapping)
                    └─ search_planning ──► 6-Phase Structured Search Planning
```

## Features

- **🔍 AI Deep Search** — Grok-powered, auto time injection, platform focus, compact output by default
- **📄 Web Fetch** — Tavily Extract → Firecrawl Scrape auto-fallback, preview output by default
- **🗺️ Site Mapping** — Tavily Map traverses website structure with conservative defaults
- **📋 Search Planning** — 6-phase structured planning
- **💾 Source Cache** — session_id indexed, on-demand retrieval
- **🔄 Smart Retry** — Retry-After header parsing + exponential backoff
- **⚙️ Interactive Config** — CLI menu for Grok/Tavily/Firecrawl API
- **🔍 Connection Diagnostics** — One-click test all API connectivity

## Installation

### Option 1: pi install (Recommended)

```bash
# Install from GitHub
pi install git:github.com/justhiL/pi-grok-search

# Or with specific version
pi install git:github.com/justhiL/pi-grok-search@v2.0.0
```

### Option 2: Manual Install

```bash
# Global
git clone https://github.com/justhiL/pi-grok-search.git ~/.pi/agent/extensions/pi-grok-search/

# Project-local
git clone https://github.com/justhiL/pi-grok-search.git .pi/extensions/pi-grok-search/
```

### Option 3: Test Run

```bash
pi -e git:github.com/justhiL/pi-grok-search
```

## Configuration

After installation, run `/grok-config` in pi for interactive configuration, or set environment variables directly:

### Environment Variables

```bash
# Grok (required)
export GROK_API_URL="https://api.x.ai/v1"
export GROK_API_KEY="xai-your-key"
export GROK_MODEL="grok-4-fast"        # optional

# Tavily (optional, provides web_fetch / web_map)
export TAVILY_API_KEY="tvly-your-key"

# Firecrawl (optional, fallback when Tavily fails)
export FIRECRAWL_API_KEY="fc-your-key"
```

### Interactive Config

In pi, type:

```
/grok-config
```

Supports: view config, set Grok/Tavily/Firecrawl API, switch model, test connections.

### Config File

Persisted to `~/.config/pi-grok-search/config.json`:

```json
{
  "apiUrl": "https://api.x.ai/v1",
  "apiKey": "xai-your-key",
  "model": "grok-4-fast",
  "tavilyApiKey": "tvly-your-key",
  "firecrawlApiKey": "fc-your-key"
}
```

## Usage

### Commands

| Command                  | Description               |
| ------------------------ | ------------------------- |
| `/grok-search <query>`   | Search the web            |
| `/grok-config`           | Interactive configuration |
| `/grok-model [model-id]` | Switch Grok model         |
| `/pi-ext-docs [topic]`   | Search pi Extension docs  |

### Tools (Auto-invoked by LLM)

| Tool              | Description                                          |
| ----------------- | ---------------------------------------------------- |
| `grok_search`     | AI search with compact default output + session_id      |
| `grok_sources`    | Retrieve paginated source list by session_id            |
| `web_fetch`       | Fetch web content preview (Tavily → Firecrawl fallback) |
| `web_map`         | Traverse website structure with bounded output          |
| `grok_config`     | View / modify / test configuration                   |
| `search_planning` | 6-phase structured search planning                   |

After installation, LLM automatically recognizes these tools and decides when to call them.

### Search Result Controls

To avoid context blow-ups, conservative budgets are enabled by default:

- `grok_search` defaults to `mode=compact`; use `mode=deep` only for explicit deep-research requests
- `extra_sources` is a shared Tavily/Firecrawl source budget, not a per-provider multiplier
- `grok_sources` supports `limit` / `offset` pagination and defaults to 20 sources per call
- `web_fetch` returns an approximately 12KB preview by default; use `max_output_bytes` to enlarge one call
- `web_map` defaults to `max_breadth=10`, `limit=30`, and uses the shared output truncation path

Common parameters:

```json
{
  "mode": "compact | normal | deep | sources_only",
  "max_answer_chars": 6000,
  "max_sources": 8,
  "max_output_bytes": 12000
}
```

## Search Quality Guidelines

Built-in behavioral guidelines (injected into system prompt via `promptGuidelines`):

- Search queries in English, user output in Chinese
- Must verify with search even if internal knowledge exists
- Key claims require ≥2 independent sources
- Conflicting sources: present evidence from both sides
- State limitations when uncertain

## Links

- [GitHub](https://github.com/justhiL/pi-grok-search)
- [pi Official Docs](https://github.com/earendil-works/pi-mono)
- [pi Extension Docs](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Grok API](https://docs.x.ai/)
- [Tavily API](https://docs.tavily.com/)
- [Firecrawl API](https://docs.firecrawl.dev/)
- [GrokSearch MCP Reference](https://github.com/GuDaStudio/GrokSearch)

## License

[MIT](LICENSE)
