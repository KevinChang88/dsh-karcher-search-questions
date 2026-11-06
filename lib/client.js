// 浏览器侧插件体：在「设置（Settings）」里注册「品牌信息与业务维度」配置页。
// 该页面负责：配置卡赫 GEO 系统数据源（地址 + 账号），一键同步品牌信息与业务维度；
// 生成问题在 AI 对话框中由宿主工具 generate_customer_questions 完成。
window.__ModuleLoader__.load({
  id: "dsh-karcher-search-questions",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect } = React;

    const CONFIG_ROUTE = "/__karcher-search-questions/company";
    const SYNC_ROUTE = "/__karcher-search-questions/sync";

    const CSS = `
.dsh-cfg{padding:16px 20px 24px;max-width:760px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#1a1a1a)}
.dsh-cfg .box{background:var(--dsw-alias-fill-l1,#f5f5f5);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.dsh-cfg .box h2{font-size:13px;font-weight:600;margin:0 0 10px;color:var(--dsw-alias-label-secondary,#555)}
.dsh-cfg label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#555);margin-bottom:4px}
.dsh-cfg input{width:100%;box-sizing:border-box;background:var(--dsw-alias-fill-l2,#fff);border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:7px;padding:7px 9px;font-size:13px;color:inherit;font-family:inherit}
.dsh-cfg .row{margin-bottom:10px}
.dsh-cfg .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
.dsh-cfg .actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:2px}
.dsh-cfg button{border:1px solid var(--dsw-alias-border-l1,#ddd);background:var(--dsw-alias-fill-l2,#fff);border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;color:inherit}
.dsh-cfg button.primary{background:var(--dsw-alias-accent,#1668dc);border-color:transparent;color:#fff;font-weight:600}
.dsh-cfg button:disabled{opacity:.5;cursor:not-allowed}
.dsh-cfg .hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-top:2px}
.dsh-cfg .status{font-size:12px;color:var(--dsw-alias-label-secondary,#555)}
.dsh-cfg .status.ok{color:var(--dsw-alias-state-success-primary,#067647)}
.dsh-cfg .status.err{color:var(--dsw-alias-state-error-primary,#c62828)}
.dsh-cfg .preview{background:var(--dsw-alias-fill-l2,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:8px;padding:10px 12px;font-size:12px;margin-top:10px}
.dsh-cfg .preview .tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dsh-cfg .preview .tag{background:var(--dsw-alias-fill-l1,#f0f0f0);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--dsw-alias-label-secondary,#555)}
.dsh-cfg .notice{background:var(--dsw-alias-fill-l2,#fff);border:1px dashed var(--dsw-alias-border-l1,#ccc);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#555);margin-bottom:14px}
`;

    function injectCss() {
      const tagId = "dsh-karcher-search-questions/style";
      if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-karcher-search-questions";
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
    }

    function Field(props) {
      return h("div", { className: "row" },
        h("label", null, props.label),
        props.children,
        props.hint ? h("div", { className: "hint" }, props.hint) : null);
    }

    function ConfigPanel() {
      const [baseUrl, setBaseUrl] = useState("http://localhost:8080");
      const [username, setUsername] = useState("");
      const [password, setPassword] = useState("");
      const [provider, setProvider] = useState("deepseek-official");
      const [model, setModel] = useState("");
      const [loading, setLoading] = useState(true);
      const [syncing, setSyncing] = useState(false);
      const [saving, setSaving] = useState(false);
      const [status, setStatus] = useState("");
      const [err, setErr] = useState("");
      // 同步结果预览
      const [preview, setPreview] = useState(null); // {brandName, dimensionTypes, groups}

      useEffect(() => {
        let alive = true;
        fetch(CONFIG_ROUTE)
          .then((r) => r.json())
          .then((d) => {
            if (!alive) return;
            setBaseUrl(d._baseUrl || "http://localhost:8080");
            setUsername(d._username || "");
            setProvider(d._provider || "deepseek-official");
            setModel(d._model || "");
            if (d.brandRaw && d.dimensionTypes) {
              setPreview({
                brandName: (d.brandName || "").trim() || "(未识别到品牌名)",
                dimensionTypes: d.dimensionTypes || [],
                groups: d.groups || [],
              });
            }
          })
          .catch(() => { if (alive) setErr("读取配置失败"); })
          .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
      }, []);

      const sync = async () => {
        setSyncing(true);
        setErr("");
        setStatus("");
        try {
          const res = await fetch(SYNC_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ baseUrl, username, password }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "同步失败");
          setPreview({
            brandName: data.brand && data.brand.brandName ? data.brand.brandName : "(未识别到品牌名)",
            dimensionTypes: data.dimensionTypes || [],
            groups: data.groups || [],
          });
          setStatus("已同步，最新维度分组：" + (data.groups || []).join("、"));
        } catch (e) {
          setErr("同步失败：" + String(e && e.message ? e.message : e));
        } finally {
          setSyncing(false);
        }
      };

      const saveAi = async () => {
        setSaving(true);
        setErr("");
        try {
          const res = await fetch(CONFIG_ROUTE, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ _provider: provider, _model: model }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "保存失败");
          setStatus("AI 配置已保存");
        } catch (e) {
          setErr("保存失败：" + String(e && e.message ? e.message : e));
        } finally {
          setSaving(false);
        }
      };

      if (loading) return h("div", { className: "dsh-cfg" }, h("div", { className: "box" }, "加载中…"));

      return h("div", { className: "dsh-cfg" },
        h("div", { className: "notice" },
          "品牌信息与业务维度来自卡赫 GEO 系统（localhost:8080），在此配置数据源并同步即可，无需手工填写。生成时在 AI 对话框中输入要求，模型会自动调用工具并按同步来的维度分组输出。"),

        h("div", { className: "box" },
          h("h2", null, "系统数据源"),
          h(Field, { label: "系统地址" },
            h("input", { type: "text", value: baseUrl, onChange: (e) => setBaseUrl(e.target.value), placeholder: "http://localhost:8080" })),
          h("div", { className: "grid" },
            h(Field, { label: "用户名" },
              h("input", { type: "text", value: username, onChange: (e) => setUsername(e.target.value) })),
            h(Field, { label: "密码" },
              h("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value) }))),
          h("div", { className: "actions" },
            h("button", { className: "primary", onClick: sync, disabled: syncing }, syncing ? "同步中…" : "从系统同步")),

          preview ? h("div", { className: "preview" },
            h("div", null, "品牌：" + preview.brandName),
            h("div", { className: "hint" }, preview.dimensionTypes && preview.dimensionTypes.length ? "已同步 " + preview.dimensionTypes.length + " 个维度类型：" + preview.dimensionTypes.join("、") : ""),
            preview.groups && preview.groups.length > 0
              ? h("div", { className: "tags" }, preview.groups.map((g) => h("span", { key: g, className: "tag" }, g)))
              : null)
            : null),

        h("div", { className: "box" },
          h("h2", null, "AI 扩写（可选）"),
          h(Field, { label: "提供方", hint: "留空默认 deepseek-official" },
            h("input", { type: "text", value: provider, onChange: (e) => setProvider(e.target.value), placeholder: "deepseek-official" })),
          h(Field, { label: "模型", hint: "留空则仅用模板生成；本机默认 deepseek-v4-pro" },
            h("input", { type: "text", value: model, onChange: (e) => setModel(e.target.value), placeholder: "deepseek-v4-pro" })),
          h("div", { className: "actions" },
            h("button", { onClick: saveAi, disabled: saving }, saving ? "保存中…" : "保存 AI 配置"))),

        h("div", { className: "actions" },
          status ? h("span", { className: "status ok" }, status) : null,
          err ? h("span", { className: "status err" }, err) : null));
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        injectCss();
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "brand-business-dimensions",
          order: 50,
          label: () => "品牌信息与业务维度",
        }, ConfigPanel));
      },
    };
  },
});
