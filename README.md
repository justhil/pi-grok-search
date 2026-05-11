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

支持：查看配置、设置 Grok/Tavily/Firecrawl API、切换模型、测试连接。

### 配置文件

持久化到 `~/.config/pi-grok-search/config.json`：

```json
{
  "apiUrl": "https://api.x.ai/v1",
  "apiKey": "xai-your-key",
  "model": "grok-4-fast",
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
  "mode": "compact | normal | deep | sources_only",
  "max_answer_chars": 6000,
  "max_sources": 8,
  "max_output_bytes": 12000
}
```

## 信源质量准则

本扩展内置了严格的搜索行为规范（通过 `promptGuidelines` 注入系统提示）：

- 搜索用英文，输出用中文
- 即使有内部知识也必须搜索验证
- 关键事实需 ≥2 个独立来源支持
- 冲突来源需呈现双方证据
- 不确定时先说明局限性

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
