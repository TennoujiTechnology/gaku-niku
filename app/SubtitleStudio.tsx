"use client";

import {
  default as React,
  type ChangeEvent,
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const BRIDGE_URL = "http://127.0.0.1:43127";

type Workspace = "prepare" | "running" | "review";
type EngineMode = "api" | "cli" | "gpu";
type PhaseStatus = "pending" | "running" | "done" | "error";

type Role = {
  id: string;
  name: string;
  color: string;
};

type Cue = {
  id: number;
  start: number;
  end: number;
  speakerId: string;
  source: string;
  translation: string;
  confidence: number;
  flagged?: boolean;
};

type Capability = {
  available: boolean;
  path?: string;
  detail?: string;
};

const phaseDefinitions = [
  ["acquire", "获取素材", "最高授权画质与音轨"],
  ["research", "背景预习", "角色、称呼与专有名词"],
  ["source_transcript", "原文听写", "词级时间戳与说话人"],
  ["translate", "精准翻译", "语境优先的逐句本地化"],
  ["resolve_ambiguities", "疑点复核", "跳转画面并执行 OCR"],
  ["subtitle_qc", "字幕质检", "两行、时序与可读性"],
  ["mux", "视频封装", "SRT / ASS / MKV / MP4"],
  ["final_validation", "最终验证", "逐流核验与抽帧检查"],
] as const;

const initialRoles: Role[] = [
  { id: "tomori", name: "高松灯", color: "#77BBDD" },
  { id: "anon", name: "千早爱音", color: "#FF8899" },
  { id: "rana", name: "要乐奈", color: "#77DD77" },
  { id: "soyo", name: "长崎爽世", color: "#FFDD88" },
  { id: "taki", name: "椎名立希", color: "#7777AA" },
];

const initialCues: Cue[] = [
  {
    id: 1,
    start: 0.8,
    end: 4.4,
    speakerId: "anon",
    source: "それでは、改めて自己紹介からいきましょうか。",
    translation: "那么，我们再从自我介绍开始吧",
    confidence: 0.98,
  },
  {
    id: 2,
    start: 4.7,
    end: 7.2,
    speakerId: "tomori",
    source: "高松燈役の羊宮妃那です。",
    translation: "我是饰演高松灯的羊宫妃那",
    confidence: 0.99,
  },
  {
    id: 3,
    start: 7.55,
    end: 10.6,
    speakerId: "taki",
    source: "椎名立希役の林鼓子です。",
    translation: "我是饰演椎名立希的林鼓子",
    confidence: 0.99,
  },
  {
    id: 4,
    start: 10.95,
    end: 14.85,
    speakerId: "soyo",
    source: "今日は最後まで一緒に楽しんでいきましょう。",
    translation: "今天就让我们一起尽兴到最后吧",
    confidence: 0.96,
  },
  {
    id: 5,
    start: 15.2,
    end: 18.7,
    speakerId: "rana",
    source: "抹茶パフェ、食べたい。",
    translation: "想吃抹茶芭菲",
    confidence: 0.93,
  },
  {
    id: 6,
    start: 19.1,
    end: 23.6,
    speakerId: "anon",
    source: "急に？ でも、埼玉にもおいしいお店ありそう。",
    translation: "这么突然？不过埼玉应该也有好吃的店",
    confidence: 0.84,
    flagged: true,
  },
  {
    id: 7,
    start: 24.1,
    end: 28.8,
    speakerId: "tomori",
    source: "迷子でも、前へ進みたい。",
    translation: "即使迷失方向，也想继续向前",
    confidence: 0.91,
  },
  {
    id: 8,
    start: 29.2,
    end: 33.4,
    speakerId: "taki",
    source: "ほら、次のコーナー始まるよ。",
    translation: "好了，下一个环节要开始了",
    confidence: 0.97,
  },
];

const researchSites = [
  { id: "official", label: "官方站点", hint: "作品官网、角色页、出演者资料" },
  { id: "wikipedia", label: "Wikipedia", hint: "基础人物与作品关系" },
  { id: "fandom", label: "Fandom / 萌娘百科", hint: "称呼、梗与粉丝语境" },
  { id: "video", label: "视频简介与评论", hint: "活动名、章节与现场信息" },
];

function detectSourceKind(source: string) {
  const value = source.trim();
  if (!value) return { label: "等待输入", tone: "neutral" };
  if (/bilibili\.com|b23\.tv/i.test(value))
    return { label: "Bilibili", tone: "pink" };
  if (/youtube\.com|youtu\.be/i.test(value))
    return { label: "YouTube", tone: "red" };
  if (/^https?:\/\//i.test(value))
    return { label: "yt-dlp 链接", tone: "violet" };
  return { label: "本地文件", tone: "green" };
}

function formatTime(value: number, compact = false) {
  if (!Number.isFinite(value)) return "00:00.000";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = Math.floor(value % 60);
  const millis = Math.floor((value % 1) * 1000);
  const prefix = hours ? `${String(hours).padStart(2, "0")}:` : "";
  const base = `${prefix}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return compact ? base : `${base}.${String(millis).padStart(3, "0")}`;
}

function parseTime(value: string) {
  const parts = value.trim().split(":");
  if (!parts.length || parts.some((part) => Number.isNaN(Number(part)))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

function statusLabel(status: PhaseStatus) {
  if (status === "done") return "完成";
  if (status === "running") return "处理中";
  if (status === "error") return "需处理";
  return "等待";
}

export function SubtitleStudio() {
  const [workspace, setWorkspace] = useState<Workspace>("prepare");
  const [source, setSource] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [outputPath, setOutputPath] = useState("~/Movies/Precision Subtitles");
  const [formats, setFormats] = useState(["ass", "srt", "mkv"]);
  const [engineMode, setEngineMode] = useState<EngineMode>("cli");
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [cli, setCli] = useState("codex");
  const [gpuModel, setGpuModel] = useState("deepseek-r1:14b");
  const [keywords, setKeywords] = useState(["BanG Dream!", "MyGO!!!!!", "迷子集会"]);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [selectedSites, setSelectedSites] = useState(["official", "wikipedia", "fandom", "video"]);
  const [customSites, setCustomSites] = useState("");
  const [bridgeStatus, setBridgeStatus] = useState<"checking" | "online" | "offline">("checking");
  const [capabilities, setCapabilities] = useState<Record<string, Capability>>({});
  const [phaseStates, setPhaseStates] = useState<Record<string, PhaseStatus>>(
    Object.fromEntries(phaseDefinitions.map(([id]) => [id, "pending"])),
  );
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState("");
  const [runMessage, setRunMessage] = useState("准备就绪");
  const [runError, setRunError] = useState("");
  const [roles, setRoles] = useState(initialRoles);
  const [cues, setCues] = useState(initialCues);
  const [selectedCueId, setSelectedCueId] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [search, setSearch] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [fontFamily, setFontFamily] = useState("Noto Sans CJK SC");
  const [fontSize, setFontSize] = useState(42);
  const [fontWeight, setFontWeight] = useState(700);
  const [outline, setOutline] = useState(3);
  const [glow, setGlow] = useState(8);
  const [shadow, setShadow] = useState(3);
  const [saved, setSaved] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const sourceKind = detectSourceKind(source);
  const selectedCue = cues.find((cue) => cue.id === selectedCueId) ?? cues[0];
  const currentCue = cues.find((cue) => currentTime >= cue.start && currentTime <= cue.end) ?? selectedCue;
  const currentRole = roles.find((role) => role.id === currentCue?.speakerId) ?? roles[0];
  const timelineDuration = Math.max(35, ...cues.map((cue) => cue.end));
  const filteredCues = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return cues.filter((cue) => {
      if (onlyFlagged && !cue.flagged) return false;
      if (!needle) return true;
      const speaker = roles.find((role) => role.id === cue.speakerId)?.name ?? "";
      return `${speaker} ${cue.source} ${cue.translation}`.toLowerCase().includes(needle);
    });
  }, [cues, onlyFlagged, roles, search]);

  useEffect(() => {
    let active = true;
    async function probeBridge() {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/capabilities`);
        if (!response.ok) throw new Error("bridge unavailable");
        const data = await response.json();
        if (!active) return;
        setCapabilities(data.tools ?? {});
        setBridgeStatus("online");
      } catch {
        if (active) setBridgeStatus("offline");
      }
    }
    void probeBridge();
    const timer = window.setInterval(probeBridge, 8000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!jobId || workspace !== "running") return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/jobs/${jobId}`);
        if (!response.ok) throw new Error("无法读取任务状态");
        const data = await response.json();
        setProgress(data.progress ?? 0);
        setRunMessage(data.message ?? "处理中");
        if (data.phases) setPhaseStates(data.phases);
        if (data.status === "completed") {
          window.clearInterval(timer);
          setProgress(100);
          if (Array.isArray(data.review?.roles) && data.review.roles.length) setRoles(data.review.roles);
          if (Array.isArray(data.review?.cues) && data.review.cues.length) {
            setCues(data.review.cues);
            setSelectedCueId(data.review.cues[0].id);
          }
          if (data.mediaUrl) setPreviewUrl(`${BRIDGE_URL}${data.mediaUrl}`);
          setWorkspace("review");
        }
        if (data.status === "failed") {
          window.clearInterval(timer);
          setRunError(data.error ?? "任务执行失败，请查看本地日志。 ");
        }
      } catch (error) {
        window.clearInterval(timer);
        setRunError(error instanceof Error ? error.message : "本地桥连接中断");
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [jobId, workspace]);

  useEffect(() => {
    return () => {
      if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setSource(file.name);
  }

  async function chooseLocalFile() {
    if (bridgeStatus === "online") {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/pick-file`, { method: "POST" });
        const data = await response.json();
        if (data.cancelled) return;
        if (response.ok && data.path) {
          if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
          setSource(data.path);
          if (data.previewUrl) setPreviewUrl(`${BRIDGE_URL}${data.previewUrl}`);
          return;
        }
      } catch {
        // Fall back to the browser file control.
      }
    }
    fileInputRef.current?.click();
  }

  function toggleFormat(format: string) {
    setFormats((current) =>
      current.includes(format) ? current.filter((item) => item !== format) : [...current, format],
    );
  }

  function addKeyword() {
    const value = keywordDraft.trim();
    if (!value || keywords.includes(value)) return;
    setKeywords((current) => [...current, value]);
    setKeywordDraft("");
  }

  function toggleSite(id: string) {
    setSelectedSites((current) =>
      current.includes(id) ? current.filter((site) => site !== id) : [...current, id],
    );
  }

  function updateCue(patch: Partial<Cue>) {
    setCues((current) => current.map((cue) => (cue.id === selectedCueId ? { ...cue, ...patch } : cue)));
    setSaved(false);
  }

  function updateRole(id: string, patch: Partial<Role>) {
    setRoles((current) => current.map((role) => (role.id === id ? { ...role, ...patch } : role)));
    setSaved(false);
  }

  function seekTo(value: number, cueId?: number) {
    setCurrentTime(value);
    if (cueId) setSelectedCueId(cueId);
    if (videoRef.current) videoRef.current.currentTime = value;
  }

  async function startTranslation() {
    setRunError("");
    if (!source.trim()) {
      setRunError("请先填写视频链接或选择本地视频。 ");
      return;
    }
    if (!formats.length) {
      setRunError("请至少选择一种输出格式。 ");
      return;
    }
    if (bridgeStatus !== "online") {
      setRunError("本地桥尚未启动。请先运行 npm run bridge，再开始翻译。 ");
      return;
    }
    setWorkspace("running");
    setRunMessage("正在创建任务…");
    try {
      const response = await fetch(`${BRIDGE_URL}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source,
          outputPath,
          formats,
          sourceLanguage: "ja",
          targetLanguage: "zh-CN",
          engine: {
            mode: engineMode,
            provider,
            model: engineMode === "api" ? model : "",
            cli,
            gpuModel,
            apiKey,
            baseUrl,
          },
          research: {
            keywords,
            sites: selectedSites,
            customSites: customSites.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
          },
          subtitleStyle: { fontFamily, fontSize, fontWeight, outline, glow, shadow, maxLines: 2 },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "任务创建失败");
      setJobId(data.id);
      setRunMessage("任务已交给本地 Agent");
    } catch (error) {
      setWorkspace("prepare");
      setRunError(error instanceof Error ? error.message : "任务创建失败");
    }
  }

  async function saveRefinements() {
    if (jobId && bridgeStatus === "online") {
      try {
        const response = await fetch(`${BRIDGE_URL}/api/jobs/${jobId}/refine`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cues, roles, style: { fontFamily, fontSize, fontWeight, outline, glow, shadow } }),
        });
        if (!response.ok) throw new Error("本地桥未接受精修数据");
      } catch {
        setRunError("保存到本地任务失败；当前修改仍保留在浏览器中。 ");
        return false;
      }
    }
    setSaved(true);
    return true;
  }

  async function exportProject() {
    if (!await saveRefinements()) return;
    if (!jobId || bridgeStatus !== "online") {
      setRunError("示例工程只能预览编辑；真实任务完成后可由本地 Agent 重新生成并封装。 ");
      return;
    }
    try {
      const response = await fetch(`${BRIDGE_URL}/api/jobs/${jobId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outputPath,
          formats,
          engine: { mode: engineMode, provider, model: engineMode === "api" ? model : "", cli, gpuModel, apiKey, baseUrl },
          roles,
          cues,
          style: { fontFamily, fontSize, fontWeight, outline, glow, shadow, maxLines: 2 },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "导出任务创建失败");
      setRunMessage("正在根据精修结果重新生成并封装");
      setWorkspace("running");
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "导出任务创建失败");
    }
  }

  function loadDemo() {
    setRoles(initialRoles);
    setCues(initialCues);
    setSelectedCueId(1);
    setWorkspace("review");
    setCurrentTime(1);
    setSaved(true);
  }

  function togglePlayback() {
    if (!videoRef.current) {
      setIsPlaying((value) => !value);
      return;
    }
    if (videoRef.current.paused) videoRef.current.play();
    else videoRef.current.pause();
  }

  const overlayStyle = {
    "--speaker-color": currentRole?.color ?? "#ffffff",
    "--subtitle-size": `${fontSize}px`,
    "--subtitle-weight": fontWeight,
    "--subtitle-outline": `${outline}px`,
    "--subtitle-glow": `${glow}px`,
    "--subtitle-shadow": `${shadow}px`,
    "--subtitle-font": `"${fontFamily}", "PingFang SC", sans-serif`,
  } as CSSProperties;

  return (
    <div className="studio-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span>CC</span></div>
          <div>
            <div className="brand-name">自学型熟肉机</div>
            <div className="brand-subtitle">先学背景 · 再做熟肉 · 本地封装</div>
          </div>
        </div>
        <nav className="workflow-nav" aria-label="工作流程">
          <button className={workspace === "prepare" ? "active" : ""} onClick={() => setWorkspace("prepare")}>
            <span>1</span> 准备
          </button>
          <div className="workflow-line" />
          <button className={workspace === "running" ? "active" : ""} onClick={() => jobId && setWorkspace("running")}>
            <span>2</span> 翻译
          </button>
          <div className="workflow-line" />
          <button className={workspace === "review" ? "active" : ""} onClick={() => setWorkspace("review")}>
            <span>3</span> 精修
          </button>
        </nav>
        <div className="header-actions">
          <div className={`bridge-pill ${bridgeStatus}`}>
            <i /> 本地桥{bridgeStatus === "online" ? "已连接" : bridgeStatus === "checking" ? "检查中" : "未连接"}
          </div>
          <button className="icon-button" aria-label="帮助">?</button>
        </div>
      </header>

      {workspace === "prepare" && (
        <main className="prepare-page">
          <section className="page-heading">
            <div>
              <p className="eyebrow">NEW TRANSLATION</p>
              <h1>新建字幕工程</h1>
              <p>让 Agent 先理解作品与人物，再开始逐句翻译。</p>
            </div>
            <button className="secondary-button" onClick={loadDemo}><span>◫</span> 载入示例工程</button>
          </section>

          {runError && <div className="notice error"><strong>无法开始</strong><span>{runError}</span><button onClick={() => setRunError("")}>×</button></div>}

          <div className="prepare-grid">
            <div className="prepare-main">
              <section className="panel source-panel">
                <div className="panel-title-row">
                  <div><span className="section-index">01</span><h2>视频与输出</h2></div>
                  <span className={`source-badge ${sourceKind.tone}`}>{sourceKind.label}</span>
                </div>
                <label className="field-label" htmlFor="video-source">视频位置</label>
                <div className="source-input-row">
                  <input id="video-source" value={source} onChange={(event) => setSource(event.target.value)} placeholder="粘贴 Bilibili / YouTube / 其他链接，或输入本地路径" />
                  <input ref={fileInputRef} className="visually-hidden" type="file" accept="video/*,audio/*" onChange={handleFile} />
                  <button className="browse-button" onClick={chooseLocalFile}>选择文件</button>
                </div>
                <p className="field-help">自动识别来源；网页预览使用临时文件地址，Agent 处理本地文件时请填写完整路径。</p>
                <div className="source-requirements">
                  <span><i className={capabilities.ffmpeg?.available ? "ok" : ""} /> FFmpeg {capabilities.ffmpeg?.available ? "就绪" : "待检测"}</span>
                  {(sourceKind.label === "Bilibili") && <span><i className={capabilities.yutto?.available ? "ok" : "missing"} /> yutto {capabilities.yutto?.available ? capabilities.yutto.detail ?? "就绪" : "未发现"}</span>}
                  {(sourceKind.label === "YouTube" || sourceKind.label === "yt-dlp 链接") && <span><i className={capabilities["yt-dlp"]?.available ? "ok" : "missing"} /> yt-dlp {capabilities["yt-dlp"]?.available ? "就绪" : "未发现"}</span>}
                </div>
                <div className="field-grid">
                  <div>
                    <label className="field-label" htmlFor="output-path">输出文件夹</label>
                    <input id="output-path" value={outputPath} onChange={(event) => setOutputPath(event.target.value)} />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="quality">下载画质</label>
                    <select id="quality" defaultValue="best"><option value="best">最高可用画质</option><option value="1080">1080P</option><option value="720">720P</option><option value="source">保留本地源文件</option></select>
                  </div>
                </div>
                <div className="format-row">
                  <span className="field-label">输出格式</span>
                  <div className="format-chips">
                    {["srt", "ass", "mkv", "mp4"].map((format) => (
                      <button key={format} className={formats.includes(format) ? "selected" : ""} onClick={() => toggleFormat(format)}>
                        <span className="check">{formats.includes(format) ? "✓" : ""}</span>{format.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="panel research-panel">
                <div className="panel-title-row">
                  <div><span className="section-index">02</span><h2>翻译前预习</h2></div>
                  <span className="required-badge">翻译前必做</span>
                </div>
                <p className="panel-intro">这些信息会写入 Agent 的研究门槛。没有完成角色、术语和称呼表，就不会进入翻译阶段。</p>
                <label className="field-label" htmlFor="keyword">知识关键词</label>
                <div className="tag-editor">
                  {keywords.map((keyword) => (
                    <span key={keyword}>{keyword}<button aria-label={`移除 ${keyword}`} onClick={() => setKeywords((items) => items.filter((item) => item !== keyword))}>×</button></span>
                  ))}
                  <input id="keyword" value={keywordDraft} onChange={(event) => setKeywordDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addKeyword(); } }} placeholder="输入作品、人物或活动名，回车添加" />
                </div>
                <div className="site-grid">
                  {researchSites.map((site) => (
                    <button key={site.id} className={`site-choice ${selectedSites.includes(site.id) ? "selected" : ""}`} onClick={() => toggleSite(site.id)}>
                      <span className="site-check">{selectedSites.includes(site.id) ? "✓" : ""}</span>
                      <span><strong>{site.label}</strong><small>{site.hint}</small></span>
                    </button>
                  ))}
                </div>
                <label className="field-label" htmlFor="custom-sites">自定义优先站点</label>
                <input id="custom-sites" value={customSites} onChange={(event) => setCustomSites(event.target.value)} placeholder="例如 bang-dream.com, mygo-movie.jp（逗号分隔）" />
              </section>
            </div>

            <aside className="prepare-side">
              <section className="panel engine-panel">
                <div className="panel-title-row"><div><span className="section-index">03</span><h2>翻译引擎</h2></div></div>
                <div className="segmented-control">
                  <button className={engineMode === "api" ? "active" : ""} onClick={() => setEngineMode("api")}>API Key</button>
                  <button className={engineMode === "cli" ? "active" : ""} onClick={() => setEngineMode("cli")}>Agent CLI</button>
                  <button className={engineMode === "gpu" ? "active" : ""} onClick={() => setEngineMode("gpu")}>本地显存</button>
                </div>

                {engineMode === "api" && <div className="engine-fields">
                  <label className="field-label" htmlFor="provider">服务商</label>
                  <select id="provider" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="compatible">OpenAI 兼容接口</option></select>
                  <label className="field-label" htmlFor="api-model">模型</label>
                  <input id="api-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="留空使用服务商默认模型" />
                  <label className="field-label" htmlFor="api-key">API Key</label>
                  <input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="仅传给 127.0.0.1，不写入项目" />
                  {provider === "compatible" && <><label className="field-label" htmlFor="base-url">Base URL</label><input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://.../v1" /></>}
                </div>}

                {engineMode === "cli" && <div className="engine-fields">
                  <label className="field-label" htmlFor="agent-cli">本地 Agent</label>
                  <select id="agent-cli" value={cli} onChange={(event) => setCli(event.target.value)}>
                    <option value="codex">Codex CLI</option><option value="claude">Claude Code</option><option value="deepseek">DeepSeek CLI</option><option value="ollama">Ollama</option>
                  </select>
                  <div className="capability-list">
                    {["codex", "claude", "deepseek", "ollama"].map((tool) => (
                      <div key={tool}><span className={capabilities[tool]?.available ? "available" : "unavailable"} /> <strong>{tool}</strong><small>{capabilities[tool]?.available ? "已发现" : bridgeStatus === "online" ? "未发现" : "待连接"}</small></div>
                    ))}
                  </div>
                  <p className="privacy-note">使用 CLI 已有登录态，不需要在网页里填写密钥。</p>
                </div>}

                {engineMode === "gpu" && <div className="engine-fields">
                  <label className="field-label" htmlFor="gpu-model">Ollama 模型</label>
                  <input id="gpu-model" value={gpuModel} onChange={(event) => setGpuModel(event.target.value)} />
                  <div className="gpu-card"><span>GPU</span><strong>{capabilities.gpu?.detail ?? "连接本地桥后检测"}</strong><small>长视频建议 14B 以上模型，并保持分段上下文。</small></div>
                  <p className="privacy-note warning">纯本地模型没有网页工具时，研究阶段需由 harness 调用浏览器或使用已有资料。</p>
                </div>}
              </section>

              <section className="panel harness-panel">
                <div className="harness-heading"><div><span className="pulse-dot" /><strong>Precision harness</strong></div><span>v1</span></div>
                <p>内置可审计的 8 阶段字幕流水线</p>
                <ol>
                  {phaseDefinitions.map(([, label], index) => <li key={label}><span>{index + 1}</span>{label}{index === 1 && <em>研究门槛</em>}</li>)}
                </ol>
                <div className="harness-rule"><span>✓</span><p><strong>成片约束</strong>最多两行、无多余句末句号、说话起止严格贴合、角色色描边发光、OCR 抽帧检查。</p></div>
              </section>

              <button className="primary-action" onClick={startTranslation}><span>▶</span><strong>开始翻译</strong><small>先研究，再听写与翻译</small></button>
              <p className="resource-note">低内存模式：媒体按需解码，Agent 输出直接写入日志。</p>
            </aside>
          </div>
        </main>
      )}

      {workspace === "running" && (
        <main className="running-page">
          <section className="run-hero">
            <div className="run-orbit" style={{ "--progress": `${progress}%` } as CSSProperties}><span>{Math.round(progress)}%</span></div>
            <p className="eyebrow">TRANSLATION IN PROGRESS</p>
            <h1>{runMessage}</h1>
            <p>可以离开这个页面，本地 Agent 会继续执行并把进度写入任务清单。</p>
          </section>
          <section className="panel run-panel">
            <div className="progress-header"><strong>总进度</strong><span>{Math.round(progress)}%</span></div>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
            <div className="phase-list">
              {phaseDefinitions.map(([id, label, description], index) => {
                const status = phaseStates[id] ?? "pending";
                return <div className={`phase-item ${status}`} key={id}>
                  <span className="phase-number">{status === "done" ? "✓" : index + 1}</span>
                  <div><strong>{label}</strong><small>{description}</small></div>
                  <span className="phase-status">{statusLabel(status)}</span>
                </div>;
              })}
            </div>
            {runError && <div className="notice error"><strong>任务中断</strong><span>{runError}</span></div>}
            <div className="run-footer"><span>任务 ID：{jobId || "创建中"}</span><button className="secondary-button" onClick={() => setWorkspace("prepare")}>返回设置</button><button className="secondary-button" onClick={loadDemo}>打开示例精修台</button></div>
          </section>
        </main>
      )}

      {workspace === "review" && (
        <main className="review-page">
          <div className="review-toolbar">
            <div className="project-title"><button className="back-button" onClick={() => setWorkspace("prepare")}>‹</button><div><strong>{source || "MyGO 迷子集会 · 示例工程"}</strong><span>{cues.length} 句 · 日语 → 简体中文</span></div></div>
            <div className="review-actions"><span className={`save-state ${saved ? "saved" : "dirty"}`}>{saved ? "已保存" : "有未保存修改"}</span><button className="secondary-button" onClick={saveRefinements}>保存工程</button><button className="export-button" onClick={exportProject}>导出 / 封装 <span>⌄</span></button></div>
          </div>

          {runError && <div className="review-notice notice error"><strong>提示</strong><span>{runError}</span><button onClick={() => setRunError("")}>×</button></div>}

          <div className="review-workspace">
            <section className="preview-column">
              <div className="video-stage">
                {previewUrl ? <video ref={videoRef} src={previewUrl} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} /> : <div className="video-placeholder"><div className="stage-grid" /><span>视频预览</span><small>选择本地文件即可在此预览；示例仅展示字幕效果</small></div>}
                {currentCue && <div className="subtitle-safe-area" style={overlayStyle}>
                  <div className="subtitle-overlay"><span className="speaker-label">{currentRole?.name}</span>{currentCue.translation}</div>
                </div>}
                <button className="center-play" onClick={togglePlayback}>{isPlaying ? "Ⅱ" : "▶"}</button>
              </div>
              <div className="transport">
                <button onClick={() => seekTo(Math.max(0, currentTime - 5))}>−5s</button>
                <button className="transport-play" onClick={togglePlayback}>{isPlaying ? "Ⅱ" : "▶"}</button>
                <button onClick={() => seekTo(Math.min(timelineDuration, currentTime + 5))}>+5s</button>
                <span className="timecode">{formatTime(currentTime)} <i>/</i> {formatTime(timelineDuration)}</span>
                <div className="transport-spacer" />
                <button>音量</button><button>适配</button>
              </div>
            </section>

            <aside className="inspector">
              <div className="inspector-tabs"><button className="active">字幕样式</button><button>画面</button></div>
              <div className="inspector-scroll">
                <section className="control-section"><div className="control-heading"><strong>排版</strong><button onClick={() => { setFontFamily("Noto Sans CJK SC"); setFontSize(42); setFontWeight(700); }}>重置</button></div>
                  <label className="field-label" htmlFor="font-family">字体</label>
                  <select id="font-family" value={fontFamily} onChange={(event) => { setFontFamily(event.target.value); setSaved(false); }}><option>Noto Sans CJK SC</option><option>Source Han Sans SC</option><option>PingFang SC</option><option>思源黑体</option></select>
                  <div className="mini-grid"><div><label className="field-label" htmlFor="font-size">字号</label><div className="number-input"><input id="font-size" type="number" min="18" max="96" value={fontSize} onChange={(event) => { setFontSize(Number(event.target.value)); setSaved(false); }} /><span>px</span></div></div><div><label className="field-label" htmlFor="font-weight">字重</label><select id="font-weight" value={fontWeight} onChange={(event) => { setFontWeight(Number(event.target.value)); setSaved(false); }}><option value="500">中等</option><option value="700">粗体</option><option value="900">特粗</option></select></div></div>
                  <div className="constraint-banner"><span>2</span><p><strong>最多两行</strong>自动利用横向安全区，禁止第三行。</p><i>锁定</i></div>
                </section>
                <section className="control-section"><div className="control-heading"><strong>角色色效果</strong><span className="auto-badge">自动</span></div>
                  {[{ label: "外圈描边", value: outline, set: setOutline, max: 8 }, { label: "柔光", value: glow, set: setGlow, max: 20 }, { label: "投影", value: shadow, set: setShadow, max: 10 }].map((control) => <label className="range-control" key={control.label}><span>{control.label}<b>{control.value}px</b></span><input type="range" min="0" max={control.max} value={control.value} onChange={(event) => { control.set(Number(event.target.value)); setSaved(false); }} /></label>)}
                </section>
                <section className="control-section roles-section"><div className="control-heading"><strong>识别出的角色</strong><span>{roles.length} 位</span></div>
                  <div className="role-list">{roles.map((role) => <div className="role-row" key={role.id}><input className="color-input" type="color" value={role.color} aria-label={`${role.name}颜色`} onChange={(event) => updateRole(role.id, { color: event.target.value })} /><input value={role.name} onChange={(event) => updateRole(role.id, { name: event.target.value })} /><span style={{ background: role.color }} /></div>)}</div>
                  <button className="add-role" onClick={() => setRoles((current) => [...current, { id: `speaker-${Date.now()}`, name: "新角色", color: "#A78BFA" }])}>＋ 添加角色</button>
                </section>
              </div>
            </aside>
          </div>

          <section className="timeline-panel">
            <div className="timeline-toolbar"><div className="timeline-tabs"><button className="active">时间轴</button><button>波形</button></div><div className="timeline-tools"><button>−</button><input aria-label="时间轴缩放" type="range" min="20" max="100" defaultValue="56" /><button>＋</button><button>适配全部</button></div></div>
            <div className="timeline-body">
              <div className="track-labels"><div>视频</div><div>字幕</div></div>
              <div className="timeline-canvas" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); seekTo(((event.clientX - bounds.left) / bounds.width) * timelineDuration); }}>
                <div className="ruler">{Array.from({ length: 8 }, (_, index) => <span key={index} style={{ left: `${index * 14.285}%` }}>{formatTime((timelineDuration / 7) * index, true)}</span>)}</div>
                <div className="video-track"><div className="filmstrip">{Array.from({ length: 16 }, (_, index) => <i key={index} />)}</div></div>
                <div className="subtitle-track">{cues.map((cue) => { const role = roles.find((item) => item.id === cue.speakerId); return <button key={cue.id} className={cue.id === selectedCueId ? "selected" : ""} style={{ left: `${(cue.start / timelineDuration) * 100}%`, width: `${Math.max(2.4, ((cue.end - cue.start) / timelineDuration) * 100)}%`, borderColor: role?.color }} onClick={(event) => { event.stopPropagation(); seekTo(cue.start, cue.id); }}><span style={{ background: role?.color }} />{cue.translation}</button>; })}</div>
                <div className="playhead" style={{ left: `${(currentTime / timelineDuration) * 100}%` }}><span /></div>
              </div>
            </div>
          </section>

          <section className="cue-editor-panel">
            <div className="cue-list-column">
              <div className="cue-list-toolbar"><strong>逐句精修</strong><div className="cue-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索台词或角色" /></div><button className={onlyFlagged ? "filter active" : "filter"} onClick={() => setOnlyFlagged((value) => !value)}>⚑ 低置信度</button></div>
              <div className="cue-table-head"><span>#</span><span>时间</span><span>角色</span><span>原文 / 译文</span><span>置信度</span></div>
              <div className="cue-list">{filteredCues.map((cue) => { const role = roles.find((item) => item.id === cue.speakerId); return <button key={cue.id} className={`cue-row ${cue.id === selectedCueId ? "selected" : ""}`} onClick={() => { setSelectedCueId(cue.id); seekTo(cue.start); }}><span className="cue-index">{String(cue.id).padStart(2, "0")}{cue.flagged && <i>!</i>}</span><span className="cue-time">{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></span><span className="cue-speaker"><i style={{ background: role?.color }} />{role?.name}</span><span className="cue-copy"><small>{cue.source}</small><strong>{cue.translation}</strong></span><span className={`confidence ${cue.confidence < 0.9 ? "low" : ""}`}>{Math.round(cue.confidence * 100)}%</span></button>; })}</div>
            </div>

            <aside className="sentence-editor">
              <div className="sentence-heading"><div><span>句子 {selectedCue.id}</span>{selectedCue.flagged && <em>低置信度</em>}</div><div><button onClick={() => setSelectedCueId(Math.max(1, selectedCue.id - 1))}>‹</button><button onClick={() => setSelectedCueId(Math.min(cues.length, selectedCue.id + 1))}>›</button></div></div>
              <label className="field-label" htmlFor="speaker">说话人</label>
              <select id="speaker" value={selectedCue.speakerId} onChange={(event) => updateCue({ speakerId: event.target.value })}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select>
              <div className="time-editor"><div><label className="field-label" htmlFor="start-time">开始</label><input key={`start-${selectedCue.id}-${selectedCue.start}`} id="start-time" defaultValue={formatTime(selectedCue.start)} onBlur={(event) => { const value = parseTime(event.target.value); if (value !== null) updateCue({ start: value }); else event.target.value = formatTime(selectedCue.start); }} /></div><span>→</span><div><label className="field-label" htmlFor="end-time">结束</label><input key={`end-${selectedCue.id}-${selectedCue.end}`} id="end-time" defaultValue={formatTime(selectedCue.end)} onBlur={(event) => { const value = parseTime(event.target.value); if (value !== null) updateCue({ end: value }); else event.target.value = formatTime(selectedCue.end); }} /></div></div>
              <label className="field-label" htmlFor="source-copy">日语原文</label><textarea id="source-copy" rows={3} value={selectedCue.source} onChange={(event) => updateCue({ source: event.target.value })} />
              <div className="translation-label"><label className="field-label" htmlFor="translation-copy">中文译文</label><span>{selectedCue.translation.length} 字 · 预计 1 行</span></div>
              <textarea id="translation-copy" className="translation-textarea" rows={4} value={selectedCue.translation} onChange={(event) => updateCue({ translation: event.target.value })} />
              <div className="quality-flags"><button className={selectedCue.flagged ? "active" : ""} onClick={() => updateCue({ flagged: !selectedCue.flagged })}>⚑ 标记待复核</button><button onClick={() => seekTo(selectedCue.start)}>◎ 跳到画面 / OCR</button></div>
              <div className="timing-status"><span>✓</span><p><strong>时序已贴合语音</strong>字幕从说话开始出现，并在话音结束时消失。</p></div>
              <button className="save-sentence" onClick={saveRefinements}>保存本句 <kbd>⌘ ↵</kbd></button>
            </aside>
          </section>
        </main>
      )}
    </div>
  );
}
