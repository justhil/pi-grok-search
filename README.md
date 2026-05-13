# pi-grok-search

[English](./README_EN.md) | 简体中文

通过 [Grok API](https://docs.x.ai/) + [Tavily](https://tavily.com/) + [Firecrawl](https://firecrawl.dev/) 为 [pi](https://github.com/earendil-works/pi-mono) 提供完整的网络访问能力。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 参考: [GrokSearch MCP](https://github.com/GuDaStudio/GrokSearch)

## 双引擎架构

```
pi ──Extension──► pi-grok-search
                    ├─ grok_search     ───► Grok API（AI 深度搜索）
                    ├─ grok_sources    ───► 信源缓存（按 session_id）
                    ├─ web_fetch       ───► Tavily Extract → Firecrawl Scrape（自动降级）
                    ├─ web_map         ───► Tavily Map（站点映射）
                    └─ search_planning ──► 6 阶段结构化搜索规划
```

## 功能特性

- **🔍 AI 深度搜索** — Grok 驱动，自动时间注入，支持平台聚焦，默认紧凑输出
- **🎛️ 搜索模式预设** — `/grok-config` 中切换 Auto / 编程文档 / 代码示例 / 项目调研 / 论文资料 / 事实核查
- **📄 网页抓取** — Tavily Extract → Firecrawl Scrape 自动降级，默认返回预览避免上下文爆炸
- **🗺️ 站点映射** — Tavily Map 遍历网站结构，默认限制链接与输出大小
- **📋 搜索规划** — 6 阶段结构化规划
- **💾 信源缓存** — session_id 索引，按需获取
- **🔄 智能重试** — Retry-After 头解析 + 指数退避
- **⚙️ 交互式配置** — CLI 菜单配置 Grok/Tavily/Firecrawl API
- **🔍 连接诊断** — 一键测试所有 API 连通性

## 安装

### 方式一：pi install（推荐）

```bash
# 从 GitHub 安装
pi install git:github.com/justhiL/pi-grok-search

# 或指定版本
pi install git:github.com/justhiL/pi-grok-search@v2.0.0
```

### 方式二：手动安装

```bash
# 全局
git clone https://github.com/justhiL/pi-grok-search.git ~/.pi/agent/extensions/pi-grok-search/

# 项目本地
git clone https://github.com/justhiL/pi-grok-search.git .pi/extensions/pi-grok-search/
```

### 方式三：测试运行

```bash
pi -e git:github.com/justhiL/pi-grok-search
```

## 配置

安装后在 pi 中运行 `/grok-config` 进入交互式配置菜单，或直接设置环境变量：

### 环境变量

```bash
# Grok（必填）
export GROK_API_URL="https://api.x.ai/v1"
export GROK_API_KEY="xai-your-key"
export GROK_MODEL="grok-4-fast"        # 可选

# Tavily（可选，提供 web_fetch / web_map）
export TAVILY_API_KEY="tvly-your-key"

# Firecrawl（可选，Tavily 失败时托底）
export FIRECRAWL_API_KEY="fc-your-key"
```

### 交互式配置

在 pi 中输入：

```
/grok-config
```

支持：查看配置、设置 Grok/Tavily/Firecrawl API、切换模型、切换搜索模式、测试连接。

### 配置文件

持久化到 `~/.config/pi-grok-search/config.json`：

```json
{
  "apiUrl": "https://api.x.ai/v1",
  "apiKey": "xai-your-key",
  "model": "grok-4-fast",
  "searchProfile": "auto",
  "tavilyApiKey": "tvly-your-key",
  "firecrawlApiKey": "fc-your-key"
}
```

## 使用

### 命令

| 命令                     | 说明                       |
| ------------------------ | -------------------------- |
| `/grok-search <query>`   | 搜索网络信息               |
| `/grok-config`           | 交互式配置管理             |
| `/grok-model [model-id]` | 切换 Grok 模型             |
| `/pi-ext-docs [topic]`   | 搜索 pi Extension 开发文档 |

### 工具（LLM 自动调用）

| 工具              | 说明                                        |
| ----------------- | ------------------------------------------- |
| `grok_search`     | AI 深度搜索，默认 compact 输出，返回结果 + session_id |
| `grok_sources`    | 通过 session_id 分页获取信源列表                    |
| `web_fetch`       | 抓取网页内容预览（Tavily → Firecrawl 自动降级）      |
| `web_map`         | 遍历网站结构，生成受限站点地图                      |
| `grok_config`     | 查看/修改/测试配置                          |
| `search_planning` | 6 阶段结构化搜索规划                        |

安装后 LLM 会自动识别这些工具，根据用户问题自主决定调用。

### 搜索模式预设

`/grok-config` 可切换全局默认搜索模式，保存到 `~/.config/pi-grok-search/config.json`。`grok_search` 也支持通过 `profile` 参数临时覆盖。

| 模式 | `profile` | 适合场景 |
| ---- | --------- | -------- |
| 自动 | `auto` | 默认策略，按问题自动判断 |
| 编程文档 | `coding_docs` | 官方文档、API、版本、最小示例 |
| 代码示例 | `code_examples` | GitHub 参考代码、真实项目用法 |
| 项目调研 | `project_research` | README、issue、release、changelog、项目比较 |
| 论文资料 | `academic` | 论文、报告、DOI、作者年份、证据链 |
| 事实核查 | `fact_check` | 多来源验证、冲突证据、可信度判断 |

主模型只注入当前模式的轻量提示；完整模式提示词只在调用 Grok API 时注入，降低常驻上下文占用。

### 搜索结果控制

为避免一次搜索把上下文撑爆，默认启用保守预算：

- `grok_search` 默认 `mode=compact`，只返回紧凑答案和 Top 信源；明确需要深度研究时再用 `mode=deep`
- `extra_sources` 是 Tavily/Firecrawl 共享的补充信源总预算，不会再被两个引擎叠加放大
- `grok_sources` 支持 `limit` / `offset` 分页，默认每次 20 条
- `web_fetch` 默认最多返回约 12KB 预览，可用 `max_output_bytes` 临时放大
- `web_map` 默认 `max_breadth=10`、`limit=30`，并走统一输出截断

常用参数：

```json
{
  "profile": "auto | coding_docs | code_examples | project_research | academic | fact_check",
  "mode": "compact | normal | deep | sources_only",
  "max_answer_chars": 6000,
  "max_sources": 8,
  "max_output_bytes": 12000
}
```

## 信源质量准则

本扩展只在 pi 主提示中保留轻量搜索规则，详细准则按搜索模式注入 Grok 请求：

- 编程场景优先官方文档、版本化 API、GitHub 源码和示例
- 论文资料模式优先论文、学术数据库、官方报告和可引用元数据
- 事实核查模式强调独立来源、时效性、冲突证据和置信度
- 默认避免把长网页直接注入上下文，优先使用紧凑结果、信源列表和按需抓取

## 相关链接

- [linux do](https://linux.do)
- [本项目 GitHub](https://github.com/justhiL/pi-grok-search)
- [pi 官方文档](https://github.com/earendil-works/pi-mono)
- [pi Extension 文档](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Grok API](https://docs.x.ai/)
- [Tavily API](https://docs.tavily.com/)
- [Firecrawl API](https://docs.firecrawl.dev/)
- [GrokSearch MCP 参考](https://github.com/GuDaStudio/GrokSearch)

## License

[MIT](LICENSE)
