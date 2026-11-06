// 客户搜索问题生成器 —— 宿主侧
// 职责：
//   1. 注册 AI 工具 generate_customer_questions（在对话中由模型调用）；
//   2. 提供「系统数据同步」路由：登录 localhost:8080 的卡赫 GEO 系统，
//      拉取品牌配置（/system-config/brand）与维度（/geo-dimensions/*），缓存到本地；
//   3. 生成时使用同步来的品牌信息 + 动态维度（决策链路）。
// 零官方包 import：服务经 ctx.inject / ctx.get 运行时解析，工具定义用纯对象注册。
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";

const CONFIG_DIR = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "karcher-search-questions");
const CONFIG_FILE = join(CONFIG_DIR, "company.json");
const SYNC_ROUTE = "/__karcher-search-questions/sync";
const CONFIG_ROUTE = "/__karcher-search-questions/company";

// 兜底的 5 个决策链路（系统维度不可用时使用）。
const FALLBACK_CATEGORIES = [
  { id: "application", label: "应用知识类", match: /应用|知识|场景|怎么选|怎么用|原理|选购/ },
  { id: "brand_detail", label: "品牌详情类", match: /详情|系列|参数|技术|口碑|特点/ },
  { id: "brand_recommendation", label: "品牌推荐类", match: /推荐|哪款|适合|性价比|选型/ },
  { id: "brand_comparison", label: "品牌比较类", match: /比较|对比|区别|哪个好|竞品/ },
  { id: "usage_maintenance", label: "使用维护类", match: /维护|保养|维修|售后|故障|保修|耗材/ },
];

// 品牌比较时优先使用的决策维度（取自系统 decision_criteria，按对清洁设备的相关度排序）。
const COMPARISON_CRITERIA = [
  "清洁效率", "吸干效果", "清洁效果", "水箱容量", "续航能力",
  "维护成本", "售后服务", "噪音控制", "设备稳定性", "操作便利性",
  "全生命周期成本", "场景适配能力", "安全能力", "环保节水",
];

// 决策维度 → 自然的比较问法。
const CRITERIA_PHRASES = {
  "清洁效率": "哪个清洁效率高",
  "清洁效果": "哪个清洁效果好",
  "吸干效果": "哪个吸干效果好",
  "设备稳定性": "哪个更耐用",
  "安全能力": "哪个更安全",
  "操作便利性": "哪个操作更方便",
  "续航能力": "哪个续航更久",
  "水箱容量": "哪个水箱容量大",
  "除尘能力": "哪个除尘效果好",
  "油污清洗能力": "哪个油污清洗能力强",
  "高温清洗能力": "哪个高温清洗能力强",
  "售后服务": "哪个售后服务好",
  "维护成本": "哪个维护成本低",
  "全生命周期成本": "哪个全生命周期成本低",
  "品牌专业度": "哪个品牌更专业",
  "产品线完整度": "哪个产品线更全",
  "场景适配能力": "哪个场景适配更好",
  "采购风险": "哪个采购风险更低",
  "环保节水": "哪个更环保节水",
  "噪音控制": "哪个噪音更小",
};

function phraseFor(criterion) {
  return CRITERIA_PHRASES[criterion] || `在「${criterion}」上哪个更好`;
}

const DEFAULT_CONFIG = {
  _source: "system", // system | manual
  _baseUrl: "http://localhost:8080",
  _username: "",
  _password: "",
  _token: "",
  // 同步到的原始系统数据
  brandRaw: null,
  dimensionTypes: [],
  dimensionMap: {}, // { typeName: [ {name, description} ] }
  syncedAt: 0,
  // 手动兜底字段
  brandName: "",
  brandIntro: "",
  productSeries: "",
  sellingPoints: "",
  targetCustomers: "",
  industries: "",
  _provider: "deepseek-official",
  _model: "",
};

async function readConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

function splitLines(s) {
  return String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 系统数据同步（登录 + 拉取）
// ---------------------------------------------------------------------------
async function httpJson(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { __text: text };
      }
    }
    if (!res.ok) {
      const msg = data.detail || (Array.isArray(data) ? "请求失败" : String(data.message || data.__text || res.status));
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function loginSystem(baseUrl, username, password) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/auth/login`;
  const data = await httpJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const token = data.access_token || data.token || data.accessToken;
  if (!token) throw new Error("登录成功但未返回 token");
  return token;
}

async function fetchWithToken(baseUrl, token, path) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1${path}`;
  return httpJson(url, { headers: { Authorization: `Bearer ${token}` } });
}

async function syncSystem(baseUrl, username, password, token) {
  const token2 = token || await loginSystem(baseUrl, username, password);
  // 1) 品牌配置
  const brandRaw = await fetchWithToken(baseUrl, token2, "/system-config/brand");
  // 2) 维度类型
  const typesRaw = await fetchWithToken(baseUrl, token2, "/geo-dimensions/types");
  const typeList = Array.isArray(typesRaw) ? typesRaw
    : (typesRaw.items || typesRaw.data || typesRaw.types || []);
  // 3) 每个类型的维度
  const dimensionMap = {};
  for (const t of typeList) {
    const typeName = t.name ?? t.type ?? t.dim_type ?? t.id ?? String(t);
    if (!typeName) continue;
    try {
      const dims = await fetchWithToken(baseUrl, token2, `/geo-dimensions/dimensions?dim_type=${encodeURIComponent(typeName)}&active_only=true`);
      const dimList = Array.isArray(dims) ? dims : (dims.items || dims.data || dims.dimensions || []);
      dimensionMap[typeName] = dimList.map((d) => ({
        name: d.name ?? d.dimension ?? d.label ?? String(d),
        description: d.description ?? d.desc ?? "",
      }));
    } catch {
      dimensionMap[typeName] = [];
    }
  }
  return { token: token2, brandRaw, dimensionTypes: typeList.map((t) => t.name ?? t.type ?? t.dim_type ?? t.id ?? String(t)), dimensionMap };
}

// ---------------------------------------------------------------------------
// 归一化：系统原始数据 → 生成用的结构化字段
// ---------------------------------------------------------------------------
function pickString(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim()).join("、");
  return typeof v === "string" ? v : "";
}

function normalizeBrand(brandRaw) {
  if (!brandRaw) return null;
  const groups = ["household", "indoor", "outdoor"];
  const seriesLines = [];
  const products = [];
  for (const g of groups) {
    const rows = Array.isArray(brandRaw[g]) ? brandRaw[g] : [];
    for (const row of rows) {
      const cat = pickString(row.category);
      const ser = pickString(row.series);
      const prods = Array.isArray(row.products) ? row.products : [];
      if (cat) {
        const line = ser ? `${cat} ${ser}` : cat;
        if (!seriesLines.includes(line)) seriesLines.push(line);
      }
      for (const p of prods) {
        if (typeof p === "string" && p.trim() && !products.includes(p.trim())) products.push(p.trim());
      }
    }
  }
  return {
    brandName: pickString(brandRaw.brand_names ?? brandRaw.brand_name ?? brandRaw.name),
    brandIntro: pickString(brandRaw.brand_positioning ?? brandRaw.positioning),
    sellingPoints: pickString(brandRaw.brand_core_advantages ?? brandRaw.core_advantages),
    productSeries: seriesLines.join("\n"),
    targetCustomers: pickString(brandRaw.target_customers ?? brandRaw.audience),
    industries: pickString(brandRaw.industries ?? brandRaw.scenarios),
    products,
  };
}

// 从同步的维度里挑出「决策链路」分组；没有则退回兜底 5 链路。
function pickGroups(config) {
  const typeNames = Object.keys(config.dimensionMap || {});
  // 1) 优先「journey（客户决策旅程）」类型——系统的 5 决策链路（应用知识/品牌推荐/品牌比较/品牌详情/使用维护）
  let chainType = typeNames.find((n) => n === "journey");
  // 2) 其次匹配中英文的「链路/决策/旅程/意图」关键词（兼容类型名可能是中文的情况）
  if (!chainType) chainType = typeNames.find((n) => /journey|链路|决策|旅程|意图/.test(n));
  // 3) 最后回退到第一个类型
  if (!chainType) chainType = typeNames[0];
  const dims = chainType ? (config.dimensionMap[chainType] || []) : [];
  if (dims.length > 0) {
    return dims.map((d, i) => {
      const name = d.name || String(i + 1);
      const fb = FALLBACK_CATEGORIES.find((c) => c.match.test(name)) || { id: "brand_detail", label: "品牌详情类" };
      return { id: `${fb.id}_${i}`, label: name, templateId: fb.id, description: d.description || "" };
    });
  }
  // 4) 退回兜底
  return FALLBACK_CATEGORIES.map((c) => ({ id: c.id, label: c.label, templateId: c.id, description: "" }));
}

function firstProduct(brand, requirement) {
  const req = String(requirement || "").trim();
  // 需求里点名了某个产品
  for (const p of brand.products || []) {
    if (p && req.includes(p)) return p;
  }
  // 从需求抽取产品名词
  const t = req.replace(/帮我|请|生成|一下|相关|的|客户|问题|咨询|搜索|给我|想要|关于|针对|需要|来个|来点|一些/g, " ");
  const m = t.match(/[A-Za-z0-9\u4e00-\u9fa5]{2,10}(?:机|器|设备|车|泵|枪|柜)/g);
  if (m && m.length) return m[m.length - 1].trim();
  return (brand.products || [])[0] || "";
}

// 从同步维度里提取竞品、场景、痛点、决策维度关键词，用于生成更贴合客户视角的问题。
function extractContext(config) {
  const dm = config.dimensionMap || {};
  const pick = (list, key) => (list || []).map((d) => (d && d[key]) || "").filter(Boolean);
  const last = (s) => String(s).split(/[-–—]/).pop().trim();
  const competitors = (dm.competitor || [])
    .map((d) => ({ name: d?.name || "", desc: d?.description || "" }))
    .filter((c) => c.name);
  // 只保留在 COMPARISON_CRITERIA 里的决策维度（保持系统顺序）
  const allCriteria = pick(dm.decision_criteria, "name");
  const decisionCriteria = COMPARISON_CRITERIA.filter((c) => allCriteria.includes(c));
  return {
    competitors,
    scenes: pick(dm.scene, "name").map(last).filter(Boolean),
    painPoints: pick(dm.pain_point, "name").map(last).filter(Boolean),
    decisionCriteria,
    industries: pick(dm.industry, "name"),
    intents: pick(dm.intent, "name"),
  };
}

// ---------------------------------------------------------------------------
// 模板引擎（决策链路分组兜底；站在客户视角，而非品牌视角）
// ---------------------------------------------------------------------------
function templateFor(templateId, brand, product, context) {
  const b = brand.brandName || "品牌";
  const prod = product || "清洁设备";
  const bp = `${b}${prod}`;
  const scenes = (context?.scenes || []).slice(0, 3);
  const pains = (context?.painPoints || []).slice(0, 3);
  const criteria = (context?.decisionCriteria || []).slice(0, 4);
  // 只保留与当前产品相关的竞品（竞品描述里点名了该产品）
  const relComps = (context?.competitors || [])
    .filter((c) => !prod || (c.desc || "").includes(prod))
    .slice(0, 4);

  switch (templateId) {
    case "application": {
      // 售前·应用知识：客户了解品类/应用，不带品牌；穿插场景/痛点问题
      const list = [];
      const push = (q) => { if (q) list.push(q); };
      push(`${prod}怎么选`);
      push(scenes[0] ? `${scenes[0]}地面清洁用什么设备` : "");
      push(`${prod}适合什么场景`);
      push(pains[0] ? `${pains[0]}怎么办` : "");
      push(`${prod}的工作原理是什么`);
      push(scenes[1] ? `${scenes[1]}地面清洁用什么设备` : "");
      push(`${prod}使用要注意什么`);
      push(pains[1] ? `${pains[1]}怎么办` : "");
      push(`${prod}的参数怎么看`);
      push(scenes[2] ? `${scenes[2]}地面清洁用什么设备` : "");
      push(`${prod}有哪些类型`);
      push(pains[2] ? `${pains[2]}怎么办` : "");
      return list;
    }
    case "brand_recommendation": {
      // 售前·求推荐：客户没有明确品牌倾向；穿插场景问题
      const list = [];
      const push = (q) => { if (q) list.push(q); };
      push(`${prod}哪个牌子好`);
      push(scenes[0] ? `${scenes[0]}用哪个牌子的${prod}好` : "");
      push(`${prod}品牌排行榜`);
      push(scenes[1] ? `${scenes[1]}用哪个牌子的${prod}好` : "");
      push(`性价比高的${prod}推荐`);
      push(`进口${prod}哪个牌子好`);
      push(`${prod}十大品牌`);
      push(scenes[2] ? `${scenes[2]}用哪个牌子的${prod}好` : "");
      return list;
    }
    case "brand_comparison": {
      // 售前·品牌对比：卡赫作为被比较品牌之一，落到具体产品 + 多决策维度
      const list = [];
      const push = (q) => { if (q) list.push(q); };
      for (const c of relComps) {
        push(`${b}和${c.name}的${prod}哪个好`);
        const c1 = criteria[0], c2 = criteria[1];
        if (c1) push(`${b}和${c.name}的${prod}${phraseFor(c1)}`);
        if (c2) push(`${b}和${c.name}的${prod}${phraseFor(c2)}`);
      }
      push(`进口和国产${prod}的区别`);
      push(`${b}和国产${prod}比怎么样`);
      return list;
    }
    case "brand_detail": {
      // 已锁定品牌：了解卡赫具体产品细节
      return [
        `${b}${prod}怎么样`,
        `${b}${prod}的参数`,
        `${b}${prod}有哪些型号`,
        `${b}${prod}系列区别`,
        `${b}${prod}的口碑`,
      ];
    }
    case "usage_maintenance": {
      // 售后：使用维护
      return [
        `${bp}怎么保养`,
        `${bp}故障了怎么办`,
        `${prod}喷嘴/喷头堵了怎么办`,
        `${bp}的耗材多久换`,
        `${b}售后怎么样`,
      ];
    }
    default:
      return [`${prod}相关问题`, `${prod}怎么咨询`];
  }
}

function generateTemplate(brand, requirement, count, groups, context) {
  const product = firstProduct(brand, requirement);
  const per = Math.max(3, Math.ceil((count || 25) / Math.max(1, groups.length)));
  const result = [];
  for (const g of groups) {
    const pool = templateFor(g.templateId, brand, product, context);
    const questions = [];
    const seen = new Set();
    for (let i = 0; questions.length < per && i < 200; i++) {
      const q = (pool[i % pool.length] || "").trim();
      if (!q || seen.has(q)) continue;
      seen.add(q);
      questions.push(q);
    }
    if (questions.length) result.push({ category: g.id, label: g.label, questions });
  }
  return result;
}

// ---------------------------------------------------------------------------
// LLM 扩写
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `你是一位专业的「客户搜索/咨询问题」专家，站在真实客户的搜索/咨询角度，推断他们会在搜索引擎或客服渠道输入的问题。

请根据给定的品牌背景信息、业务维度分组与用户要求，生成一批潜在客户真实可能搜索或咨询的问题，并严格按给定的分组输出（分组标签务必与指令一致，不要自创）。

要求：
1. 问题真实自然、口语化，符合客户口吻，严禁营销腔。
2. 必须站在「客户视角」提问：客户关心的是自己的需求、场景、痛点和决策，而不是「了解品牌」。售前阶段（应用知识、品牌推荐、品牌比较）不要问「XX是什么品牌」「XX品牌怎么样」这类品牌介绍式问题。
3. 品牌名只作背景信息，按分组阶段使用：
   - 应用知识类：只问品类/应用（如「高压清洗机怎么选」「工厂地面油污怎么清洗」），不出现品牌名；
   - 品牌推荐类：问「哪个牌子好」「性价比高的XX」等求推荐问题，不点名具体品牌；
   - 品牌比较类：用「卡赫 与 竞品」的对比（如「卡赫和亿力哪个好」）；
   - 品牌详情类、使用维护类：客户已锁定/已购买，可用「卡赫+产品」的写法（如「卡赫高压清洗机参数」「卡赫高压清洗机怎么保养」）。
4. 尽量利用给出的竞品、场景、痛点、比较决策维度、适用行业、客户意图等信息，让问题更具体、更贴合真实客户的处境与决策。
5. 「竞品品牌」列表已按当前产品维度筛选：品牌比较类只使用列表里的竞品，不要自创、不要混入其它产品的品牌。
6. 输出语言按指令指定（zh=简体中文，en=English）。
7. 只输出一个 JSON 对象，不要解释、前言或代码块标记。结构：
{"groups":[{"label":"分组名","questions":["..."]}]}
label 必须与指令给出的分组名完全一致；没有合适问题的分组可省略。`;

function parseLlmGroups(text, groups) {
  if (typeof text !== "string" || !text.trim()) return null;
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const tryParse = (s) => {
    const parsed = JSON.parse(s);
    if (!parsed || !Array.isArray(parsed.groups)) return null;
    const out = [];
    for (const g of parsed.groups) {
      const label = (g && (g.label ?? g.category ?? g.name)) || "";
      const lab = typeof label === "string" ? label.trim() : "";
      const questions = Array.isArray(g.questions) ? g.questions.filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim()) : [];
      if (!lab || !questions.length) continue;
      const target = groups.find((x) => x.label === lab);
      out.push({ category: target ? target.id : lab, label: lab, questions });
    }
    return out.length ? out : null;
  };
  try {
    return tryParse(cleaned);
  } catch {
    const s = cleaned.indexOf("{");
    const e = cleaned.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return tryParse(cleaned.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildPrompt(brand, requirement, count, groups, language, context) {
  const lines = [];
  const add = (label, value) => {
    if (value && String(value).trim()) lines.push(`${label}：${String(value).trim()}`);
  };
  add("品牌名", brand.brandName);
  add("品牌定位", brand.brandIntro);
  add("产品/系列", brand.productSeries);
  add("核心卖点/技术", brand.sellingPoints);
  add("目标客户", brand.targetCustomers);
  add("竞品品牌", (context?.competitors || []).map((c) => c.name).join("、"));
  add("场景关键词", (context?.scenes || []).join("、"));
  add("痛点关键词", (context?.painPoints || []).join("、"));
  add("比较决策维度", (context?.decisionCriteria || []).join("、"));
  add("适用行业", (context?.industries || []).join("、"));
  add("客户意图类型", (context?.intents || []).join("、"));
  add("本次要求", requirement);
  lines.push(`分组（务必使用这些 label）：${groups.map((g) => g.label).join("、")}`);
  lines.push(`期望问题总数：约 ${count || 25} 条`);
  lines.push(`输出语言：${language === "en" ? "English" : "简体中文"}`);
  return lines.join("\n");
}

async function expandWithLlm(ctx, config, brand, requirement, count, groups, language, context) {
  const llm = ctx.get("llm");
  const model = config._model;
  if (!model) return null;
  const provider = config._provider || "deepseek-official";
  const messages = [{
    role: "user",
    content: [{ type: "text", text: SYSTEM_PROMPT + "\n\n" + buildPrompt(brand, requirement, count, groups, language, context) }],
  }];
  let text = "";
  let finishReason = "";
  let streamError = "";
  try {
    for await (const chunk of llm.stream({ provider, model, messages, maxTokens: 8192 })) {
      if (!chunk) continue;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        text += chunk.text;
      } else if (chunk.type === "finish") {
        finishReason = JSON.stringify(chunk.reason ?? {});
      }
    }
  } catch (e) {
    streamError = String(e && e.message ? e.message : e);
  }
  // 写诊断日志，便于排查 LLM 失败原因
  try {
    await appendFile(join(CONFIG_DIR, "llm.log"), JSON.stringify({
      ts: new Date().toISOString(), model, provider,
      textLen: text.length, textHead: text.slice(0, 200),
      finishReason, streamError,
    }) + "\n", "utf8");
  } catch {
    // ignore
  }
  if (!text) return null;
  return parseLlmGroups(text, groups);
}

function mergeGroups(templateGroups, llmGroups, count, groups) {
  const byId = new Map();
  for (const g of templateGroups) byId.set(g.category, { ...g, seen: new Set(g.questions) });
  for (const g of llmGroups || []) {
    const key = g.category;
    const e = byId.get(key);
    if (!e) {
      byId.set(key, { category: key, label: g.label, questions: [...g.questions], seen: new Set(g.questions) });
      continue;
    }
    for (const q of g.questions) {
      if (q && !e.seen.has(q)) {
        e.seen.add(q);
        e.questions.push(q);
      }
    }
  }
  const cap = Math.max(1, Math.ceil((count || 25) / Math.max(1, byId.size)));
  return groups.map((g) => byId.get(g.id)).filter(Boolean)
    .map((g) => ({ category: g.category, label: g.label, questions: g.questions.slice(0, cap) }));
}

function formatGroups(groups) {
  return groups.map((g) => `## ${g.label}\n${g.questions.map((q) => `- ${q}`).join("\n")}`).join("\n\n");
}

// 只保留与当前产品维度相关的竞品（竞品描述里点名了该产品）；无匹配则保留全部。
function filterCompetitorsByProduct(context, product) {
  const all = context?.competitors || [];
  if (!product) return context;
  const filtered = all.filter((c) => (c.desc || "").includes(product));
  return { ...context, competitors: filtered.length > 0 ? filtered : all };
}

function toMarkdown(groups, title) {
  const lines = [];
  if (title) lines.push(`# ${title}`, "");
  for (const g of groups) {
    lines.push(`## ${g.label}`, "");
    for (const q of g.questions) lines.push(`- ${q}`);
    lines.push("");
  }
  return lines.join("\n");
}

function toCsv(groups) {
  const rows = ["分类,问题"];
  for (const g of groups) {
    for (const q of g.questions) {
      rows.push(`"${g.label.replace(/"/g, '""')}","${q.replace(/"/g, '""')}"`);
    }
  }
  return rows.join("\n");
}

async function exportFiles(groups, title) {
  try {
    const dir = join(CONFIG_DIR, "exports");
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = join(dir, `customer-questions-${ts}`);
    const mdPath = `${base}.md`;
    const csvPath = `${base}.csv`;
    await writeFile(mdPath, toMarkdown(groups, title), "utf8");
    await writeFile(csvPath, toCsv(groups), "utf8");
    return { md: mdPath, csv: csvPath };
  } catch {
    return { md: "", csv: "" };
  }
}

// ---------------------------------------------------------------------------
// HTTP 工具函数
// ---------------------------------------------------------------------------
function sendJson(res, status, value) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("requestTooLarge");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export const inject = ["webServer"];

export function apply(ctx) {
  // 配置读写路由（设置页用）
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: CONFIG_ROUTE,
      handler: async (req, res) => {
        try {
          if (req.method === "GET") {
            const c = await readConfig();
            // 不把密码回传给前端；额外附带当前决策链路分组，供设置页预览
            const safe = { ...c, _password: "", _token: "", groups: pickGroups(c).map((g) => g.label) };
            sendJson(res, 200, safe);
            return;
          }
          if (req.method === "PUT" || req.method === "POST") {
            const body = await readJsonBody(req);
            const cur = await readConfig();
            const merged = { ...cur, ...body };
            await saveConfig(merged);
            sendJson(res, 200, { ok: true });
            return;
          }
          sendJson(res, 405, { ok: false, error: "method-not-allowed" });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error) });
        }
      },
    });
    return () => dispose();
  });

  // 同步路由：登录 + 拉取系统数据
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: SYNC_ROUTE,
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "method-not-allowed" });
            return;
          }
          const body = await readJsonBody(req);
          const baseUrl = (body.baseUrl || "").trim() || "http://localhost:8080";
          const username = (body.username || "").trim();
          const password = body.password || "";
          if (!username || !password) {
            sendJson(res, 400, { ok: false, error: "请填写用户名和密码" });
            return;
          }
          const cur = await readConfig();
          const synced = await syncSystem(baseUrl, username, password, cur._token || "");
          const brand = normalizeBrand(synced.brandRaw);
          const config = {
            ...cur,
            _source: "system",
            _baseUrl: baseUrl,
            _username: username,
            _password: password,
            _token: synced.token,
            brandRaw: synced.brandRaw,
            dimensionTypes: synced.dimensionTypes,
            dimensionMap: synced.dimensionMap,
            syncedAt: Date.now(),
            ...(brand ? { brandName: brand.brandName, brandIntro: brand.brandIntro, productSeries: brand.productSeries, sellingPoints: brand.sellingPoints, targetCustomers: brand.targetCustomers, industries: brand.industries } : {}),
          };
          await saveConfig(config);
          const groups = pickGroups(config);
          sendJson(res, 200, {
            ok: true,
            brand: brand || null,
            dimensionTypes: synced.dimensionTypes,
            groups: groups.map((g) => g.label),
          });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      },
    });
    return () => dispose();
  });

  // 注册 AI 工具
  ctx.inject(["tools"], (toolsCtx) => {
    toolsCtx.tools.register({
      name: "generate_customer_questions",
      description:
        "根据已同步的品牌信息与业务维度（决策链路），结合用户要求，生成一批潜在客户真实可能搜索或咨询的问题，并按系统里的维度分组输出。当用户要求「生成客户问题」「生成搜索问题」「生成咨询问题」或类似需求时调用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          requirement: {
            type: "string",
            description: "用户的原始要求/补充说明，例如针对某类产品、某类客户、某个场景想生成问题。",
          },
          count: {
            type: "number",
            description: "期望的问题总数（可选，默认约 25 条）。",
          },
        },
        required: ["requirement"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            groups: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  category: { type: "string" },
                  label: { type: "string" },
                  questions: { type: "array", items: { type: "string" } },
                },
                required: ["category", "label", "questions"],
              },
            },
            source: { type: "string" },
            files: {
              type: "object",
              additionalProperties: false,
              properties: {
                md: { type: "string" },
                csv: { type: "string" },
              },
              required: ["md", "csv"],
            },
          },
          required: ["groups", "source"],
        },
        render: (_args, value) => [{
          type: "text",
          text: (() => {
            if (!value || !Array.isArray(value.groups) || !value.groups.length) {
              return "未生成任何问题（请先在「设置 → 品牌信息与业务维度」里同步系统数据）。";
            }
            const head = formatGroups(value.groups);
            const files = value.files;
            const tail = files && files.md
              ? `\n\n---\n已导出文件：\n- Markdown: ${files.md}\n- CSV: ${files.csv}`
              : "";
            return head + tail;
          })(),
        }],
      },
      execute: async (args, _exec) => {
        const config = await readConfig();
        const requirement = String(args?.requirement ?? "").trim();
        const count = Number.isFinite(args?.count) && args.count > 0 ? Math.floor(args.count) : 25;

        // 品牌信息：优先用同步后的归一化字段
        let brand = normalizeBrand(config.brandRaw);
        if (!brand || !brand.brandName) {
          brand = {
            brandName: config.brandName,
            brandIntro: config.brandIntro,
            sellingPoints: config.sellingPoints,
            productSeries: config.productSeries,
            targetCustomers: config.targetCustomers,
            industries: config.industries,
            products: splitLines(config.productSeries),
          };
        }
        const groups = pickGroups(config);
        const context = extractContext(config);

        const product = firstProduct(brand, requirement);
        const llmContext = filterCompetitorsByProduct(context, product);

        const templateGroups = generateTemplate(brand, requirement, count, groups, context);
        let llmGroups = null;
        try {
          llmGroups = await expandWithLlm(ctx, config, brand, requirement, count, groups, "zh", llmContext);
        } catch {
          llmGroups = null;
        }
        // LLM 优先：只要 LLM 成功生成，就用 LLM 结果（它会参考全部业务维度）；
        // 模板只作离线兜底。
        const okLlm = Array.isArray(llmGroups) && llmGroups.length > 0;
        const finalGroups = okLlm ? mergeGroups([], llmGroups, count, groups) : templateGroups;
        const files = await exportFiles(finalGroups, requirement);
        return { groups: finalGroups, source: okLlm ? "llm" : "template", files };
      },
    });
  });
}
