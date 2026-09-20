# WorkBuddy Web Monitor

监控 WorkBuddy 每个会话的模型 Token 调用情况：上下文占用、累计输入/输出、缓存命中、推理 tokens、API 请求数、生成速度（保守值）等。

数据来源：`~/.workbuddy/projects/<工作目录>/<会话-id>.jsonl` 转录文件（只读解析，零侵入）。

![预览](public/preview.png)

## 显示指标（每个会话）

```
会话: ~/WorkBuddy-2026-09-18-22-34-32  (最后活动 0 分钟前)
模型: glm-5.3-flash
上下文占用: 87.2k tokens
累计输入:   1595.7k  (缓存命中 1431.8k)
累计输出:   12.8k  (推理 6962)
API 请求:   23 次
最近速度:   ~6 tok/s (含工具执行时间, 保守值)
```

- **上下文占用**：最近一次 API 请求的输入 tokens（即当前对话上下文规模）
- **累计输入/输出**：全会话所有 API 请求的 tokens 总和；缓存命中为 prompt cache 读取量；推理为 reasoning/thinking tokens
- **积分消耗**：来自每条 API 响应的 `rawUsage.credit`（WorkBuddy 官方计费积分）；走自建网关/本地模型时为 0
- **预估费用**：基于可编辑的 `pricing.json` 定价表（元/百万 tokens）按「模型 → token 用量」精确计算，拆分输入 / 缓存命中 / 输出三项；未收录定价的模型不显示费用（全局卡片带 `+` 号表示还有未计价部分）。卡片上的 **!** 悬停可查看所用单价
- **最近速度**：`最近一次输出 tokens ÷ 与上次请求完成时刻的间隔`。分母包含工具执行时间，因此是保守值；间隔超过 5 分钟视为会话闲置，不计入速度样本
- **详情页**：点击卡片展开——会话元信息 + 最近 300 条请求历史（时间/模型/输入/缓存/输出/推理/单次速度）

全局面板提供：今日请求/输入/输出、活跃会话数（10 分钟内）、24h 会话数、累计汇总、模型分布条形图。

## 快速开始

### Docker 部署（推荐）

```bash
docker compose up -d --build
# 打开 http://localhost:3456
```

`docker-compose.yml` 已配置将 `~/.workbuddy` **只读**挂载进容器。

或直接用 `docker run`：

```bash
docker build -t workbuddy-web-monitor .
docker run -d --name workbuddy-monitor \
  -p 3456:3456 \
  -v ~/.workbuddy:/data/workbuddy:ro \
  workbuddy-web-monitor
```

> macOS Docker Desktop 可直接挂载 `~/.workbuddy`；Linux 主机同理。

### 本地运行（无需 Docker）

```bash
node server.js          # 或 npm start
# 打开 http://localhost:3456
```

要求 Node.js ≥ 18，无任何 npm 依赖。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3456` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `WB_HOME` | `~/.workbuddy`（容器内 `/data/workbuddy`） | WorkBuddy 数据目录 |
| `AUTH_TOKEN` | 空 | 可选访问令牌；设置后需带 `?token=<值>` 或 `Authorization: Bearer <值>` |
| `PRICING_FILE` | `<项目目录>/pricing.json` | 模型定价表路径（热加载，改完即生效无需重启） |

### 模型定价（费用预估）

编辑项目根目录的 `pricing.json` 即可增改模型单价（元/百万 tokens），**保存即生效**（每次请求现读，无需重启）：

```json
{
  "source": "open.bigmodel.cn/pricing",
  "currency": "CNY",
  "prices": {
    "glm-5.3-flash": { "input": 0.8, "cached": 0.23, "output": 2.8 },
    "glm-5.2": { "input": 8, "cached": 2, "output": 28 }
  }
}
```

- 模型名不区分大小写（转录中的 `GLM-5.3-Flash` 会匹配 `glm-5.3-flash`）
- 费用 =（输入−缓存命中）×输入价 + 缓存命中×缓存价 + 输出×输出价
- Docker 下自定义定价：`-v ./pricing.json:/app/pricing.json:ro`

公网暴露时建议设置 `AUTH_TOKEN`，例如：

```yaml
environment:
  - AUTH_TOKEN=my-secret
# 访问 http://localhost:3456/?token=my-secret
```

## API

| 端点 | 说明 |
|---|---|
| `GET /api/summary` | 全局汇总（今日 tokens、活跃会话、模型分布） |
| `GET /api/sessions` | 会话列表（按最后活动倒序，含全部指标） |
| `GET /api/sessions/:id/detail` | 单会话详情（含最近 300 条请求历史） |
| `GET /api/health` | 健康检查 |

## 实现说明

- **零依赖**：仅用 Node.js 内置模块（`http`/`fs`/`readline`），镜像基于 `node:22-alpine`
- **增量扫描**：按文件 `mtime + size` 缓存解析结果，5 秒轮询只重扫变化的文件（首轮全量 325 个文件约 0.7s，日常增量 < 50ms）
- **只读安全**：对 WorkBuddy 数据目录只有读权限，不影响 WorkBuddy 运行
- **兼容多种 usage 格式**：自动归一化 camelCase（`inputTokens`）、snake_case（`input_tokens`）与 rawUsage 三种记录格式
