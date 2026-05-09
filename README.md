# pi-grok-search

通过 [Grok API](https://docs.x.ai/) + [Tavily](https://tavily.com/) + [Firecrawl](https://firecrawl.dev/) 为 [pi](https://github.com/earendil-works/pi-mono) 提供完整的网络访问能力。

> 参考: [GrokSearch MCP](https://github.com/GuDaStudio/GrokSearch)

## 双引擎架构

```
pi ──Extension──► pi-grok-search
                    ├─ grok_search   ───► Grok API（AI 深度搜索）
                    ├─ grok_sources  ───► 信源缓存（按 session_id）
                    ├─ web_fetch     ───► Tavily Extract → Firecrawl Scrape（内容抓取，自动降级）
                    ├─ web_map       ───► Tavily Map（站点映射）
                    └─ search_planning ──► 6 阶段结构化搜索规划
```

## 功能特性

- **🔍 AI 深度搜索** — Grok 驱动，自动时间注入，支持平台聚焦
- **📄 网页抓取** — Tavily Extract → Firecrawl Scrape 自动降级
- **🗺️ 站点映射** — Tavily Map 遍历网站结构
- **📋 搜索规划** — 6 阶段结构化规划（intent → complexity → sub_query → search_term → tool_mapping → execution）
- **💾 信源缓存** — session_id 索引，按需获取
- **🔄 智能重试** — Retry-After 头解析 + 指数退避
- **⚙️ 交互式配置** — CLI 菜单配置 Grok/Tavily/Firecrawl API
- **🔍 连接诊断** — 一键测试所有 API 连通性

## 安装

### 全局安装（推荐）

```bash
cp -r /path/to/pi-grok-search ~/.pi/agent/extensions/pi-grok-search/
```

### 项目本地

```bash
cp -r /path/to/pi-grok-search .pi/extensions/pi-grok-search/
```

### 测试运行

```bash
pi -e ./pi-grok-search/index.ts
```

## 配置

### 环境变量（优先级最高）

```bash
# Grok（必填）
export GROK_API_URL="https://api.x.ai/v1"
export GROK_API_KEY="xai-your-key"
export GROK_MODEL="grok-4-fast"        # 可选

# Tavily（可选，提供 web_fetch/web_map）
export TAVILY_API_KEY="tvly-your-key"
export TAVILY_API_URL="https://api.tavily.com"  # 可选

# Firecrawl（可选，Tavily 失败时托底）
export FIRECRAWL_API_KEY="fc-your-key"
export FIRECRAWL_API_URL="https://api.firecrawl.dev/v2"  # 可选
```

### 交互式配置

```
/grok-config
```

菜单选项：

1. 查看当前配置
2. 设置 Grok API（URL + Key）
3. 设置 Tavily API
4. 设置 Firecrawl API
5. 切换模型（自动获取可用模型列表）
6. 测试所有连接

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

## 命令

| 命令                     | 说明                       |
| ------------------------ | -------------------------- |
| `/grok-search <query>`   | 搜索网络信息               |
| `/grok-config`           | 交互式配置管理             |
| `/grok-model [model-id]` | 切换 Grok 模型             |
| `/pi-ext-docs [topic]`   | 搜索 pi Extension 开发文档 |

## 工具（LLM 可调用）

### `grok_search` — AI 网络搜索

通过 Grok API 执行深度搜索，自动检测时间相关查询并注入时间上下文。

| 参数            | 类型   | 必填 | 说明                               |
| --------------- | ------ | ---- | ---------------------------------- |
| `query`         | string | ✅   | 搜索查询                           |
| `platform`      | string | ❌   | 聚焦平台（如 "Twitter", "GitHub"） |
| `extra_sources` | number | ❌   | 额外信源数量（Tavily/Firecrawl）   |

返回 `session_id`，用于 `grok_sources` 获取信源。

### `grok_sources` — 获取信源

通过 `session_id` 获取之前搜索缓存的完整信源列表。

| 参数         | 类型   | 必填 | 说明                            |
| ------------ | ------ | ---- | ------------------------------- |
| `session_id` | string | ✅   | `grok_search` 返回的 session_id |

### `web_fetch` — 网页内容抓取

Tavily Extract → Firecrawl Scrape 自动降级，100% 内容保真。

| 参数  | 类型   | 必填 | 说明         |
| ----- | ------ | ---- | ------------ |
| `url` | string | ✅   | 目标网页 URL |

### `web_map` — 站点结构映射

通过 Tavily Map API 遍历网站结构。

| 参数           | 类型   | 必填 | 默认 | 说明                  |
| -------------- | ------ | ---- | ---- | --------------------- |
| `url`          | string | ✅   | -    | 起始 URL              |
| `instructions` | string | ❌   | ""   | 自然语言过滤          |
| `max_depth`    | number | ❌   | 1    | 最大深度（1-5）       |
| `max_breadth`  | number | ❌   | 20   | 每页最大链接（1-500） |
| `limit`        | number | ❌   | 50   | 总链接上限（1-500）   |
| `timeout`      | number | ❌   | 150  | 超时秒数              |

### `grok_config` — 配置管理

| 参数     | 类型                      | 说明                    |
| -------- | ------------------------- | ----------------------- |
| `action` | "show" \| "set" \| "test" | 操作类型                |
| `key`    | string                    | 配置项（action=set 时） |
| `value`  | string                    | 配置值（action=set 时） |

### `search_planning` — 搜索规划

6 阶段结构化搜索规划：

1. **intent_analysis** — 分析用户意图
2. **complexity_assessment** — 评估复杂度（1-3）
3. **query_decomposition** — 分解子查询
4. **search_strategy** — 搜索策略
5. **tool_selection** — 工具选择
6. **execution_order** — 执行顺序

## pi Extension 规范参考

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 注册工具
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "工具描述（给 LLM 看的）",
    promptSnippet: "一行摘要",
    promptGuidelines: ["Use my_tool when..."],
    parameters: Type.Object({
      param: Type.String({ description: "参数说明" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: "结果" }],
        details: {
          /* 存储状态 */
        },
      };
    },
  });

  // 注册命令
  pi.registerCommand("my-cmd", {
    description: "命令说明",
    handler: async (args, ctx) => {
      ctx.ui.notify("Hello!", "info");
    },
  });

  // 监听事件
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("my-ext", "已加载");
  });
}
```

## 相关链接

- [pi Extension 文档](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [pi Extension 示例](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/examples/extensions)
- [Grok API 文档](https://docs.x.ai/)
- [Tavily API](https://docs.tavily.com/)
- [Firecrawl API](https://docs.firecrawl.dev/)
- [GrokSearch MCP 参考](https://github.com/GuDaStudio/GrokSearch)

## License

MIT
