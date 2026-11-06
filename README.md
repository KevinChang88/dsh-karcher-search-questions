# 客户搜索问题生成器（DSH 插件）

在 **AI 对话框**中，根据你的输入要求 + 从**卡赫 GEO 系统**同步来的品牌信息与业务维度，生成潜在客户真实可能搜索或咨询的问题，并按系统的**决策链路维度**分组。

- 交互方式：直接在 AI 对话框里提要求，模型自动调用工具生成问题。
- 数据来源：从 `http://localhost:8080` 的卡赫 GEO 系统同步（品牌配置 + geo 维度），无需手工填写。
- 生成策略：本地模板兜底 + LLM 扩写润色（可选）。

---

## 一、架构

| 半身 | 文件 | 作用 |
|---|---|---|
| 宿主侧 | `lib/index.js` | ① 注册 AI 工具 `generate_customer_questions`；② 提供「同步」路由：登录卡赫 GEO → 拉取品牌配置 + 维度 → 缓存；③ 生成时使用同步数据 |
| 浏览器侧 | `lib/client.js` | 在「设置」里注册「品牌信息与业务维度」页面（系统数据源 + 一键同步 + AI 配置） |

不 import 任何 `@deepseek-ai/*` 包；服务经 `ctx.inject` / `ctx.get` 运行时解析。

## 二、使用

1. 打开「设置 → 品牌信息与业务维度」，填**系统地址**（默认 `http://localhost:8080`）、**用户名**、**密码**，点「从系统同步」。
2. 同步成功后页面会显示识别到的品牌名与维度分组。
3. 回到 AI 对话框，输入要求（如 `帮我生成高压清洗机的客户搜索问题`），模型自动调用工具，按同步来的维度分组输出问题。

## 三、同步的数据

| 数据 | 系统接口 |
|---|---|
| 品牌配置（品牌名/定位/核心优势/产品类目与系列） | `GET /api/v1/system-config/brand` |
| 维度类型 | `GET /api/v1/geo-dimensions/types` |
| 维度明细（决策链路分组） | `GET /api/v1/geo-dimensions/dimensions?dim_type=X` |
| 登录（获取 token） | `POST /api/v1/auth/login` |

同步结果缓存于 `~/.dsh/karcher-search-questions/company.json`（含账号与 token，本机使用）。

## 四、配置

- **系统地址 / 用户名 / 密码**：用于登录卡赫 GEO 并拉取数据。
- **提供方 / 模型**：AI 扩写用；提供方留空默认 `deepseek-official`，模型留空则仅模板生成。

## 五、安装与分发

### 前置要求

- DeepSeek Harness（DSH）运行环境；
- 可访问的卡赫 GEO 系统（用于同步品牌信息与业务维度）。

### 分发方式（三选一）

**A. GitHub（推荐）**

把本目录推送到 GitHub 仓库后，接收方二选一：

- 插件面板：DSH → 插件 → 安装来源选「git」→ 填 `https://github.com/<账号>/dsh-karcher-search-questions.git`；
- 手动：在接收方 profile 的 `package.json` 中加入：

```json
"dependencies": {
  "dsh-karcher-search-questions": "github:<账号>/dsh-karcher-search-questions#main"
},
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-karcher-search-questions"] } }
```

然后 `pnpm install` 并重启。

**B. npm**

`npm publish` 发布后，接收方在插件面板输入包名安装，或手动加 `"dependencies": { "dsh-karcher-search-questions": "^1.0.0" }`。

**C. 本地 / zip**

`npm pack` 生成 `.tgz`，或整个目录打包 zip 发给对方；对方解压后在插件面板选「本地目录」安装。

### 安装后配置

1. 打开「设置 → 品牌信息与业务维度」，填系统地址、用户名、密码，点「从系统同步」。
2. 回到 AI 对话框输入要求即可生成问题。

### 开发环境

本机开发时用 `link:` 软链挂载（`~/.dsh/profiles/desktop`），改动源码后需**重启 DSH** 生效。

## 六、已知限制

- 维度分组名从系统动态读取；若系统里没有「决策链路」类维度，则回退到内置 5 链路（应用知识/品牌详情/品牌推荐/品牌比较/使用维护）。
- 账号密码明文存在本地 JSON，仅供本机使用。
- 工具依赖 `tools` 服务与 `llm` 服务（可选）；LLM 失败自动回退模板。
