import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const assets = path.join(root, "assets");
fs.mkdirSync(assets, { recursive: true });

const screenshotPath = path.join(root, "..", "assets", "app-prepare.png");
const screenshot = fs.existsSync(screenshotPath)
  ? `data:image/png;base64,${fs.readFileSync(screenshotPath).toString("base64")}`
  : "";

const defs = `
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#07111F"/><stop offset=".55" stop-color="#102A48"/><stop offset="1" stop-color="#171D42"/></linearGradient>
  <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#6A86FF"/><stop offset=".52" stop-color="#42D7D0"/><stop offset="1" stop-color="#F58AB7"/></linearGradient>
  <radialGradient id="glow"><stop stop-color="#5C7CFA" stop-opacity=".5"/><stop offset="1" stop-color="#5C7CFA" stop-opacity="0"/></radialGradient>
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#020713" flood-opacity=".58"/></filter>
  <clipPath id="screen"><rect x="80" y="188" width="1030" height="720" rx="28"/></clipPath>
</defs>`;

const base = (content, kicker = "SELF-LEARNING SUBTITLE STUDIO · UI LOGIC") => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1920" viewBox="0 0 1920 1920">
${defs}
<rect width="1920" height="1920" fill="url(#bg)"/>
<circle cx="1710" cy="110" r="480" fill="url(#glow)" opacity=".78"/>
<circle cx="160" cy="980" r="360" fill="url(#glow)" opacity=".28"/>
<path d="M-100 920 C400 690 730 1060 1190 810 S1760 660 2050 780" fill="none" stroke="url(#accent)" stroke-width="3" opacity=".28"/>
<text x="82" y="82" fill="#9CB2CF" font-family="PingFang SC,Helvetica,sans-serif" font-size="21" font-weight="700" letter-spacing="4">${kicker}</text>
${content}
</svg>`;

const logo = (x, y, size = 92) => `
<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * .25)}" fill="#5D7DF2" stroke="#9EB5FF" stroke-width="3"/>
<text x="${x + size / 2}" y="${y + size * .65}" text-anchor="middle" fill="#FFF" font-family="Helvetica,sans-serif" font-size="${Math.round(size * .4)}" font-weight="800">CC</text>`;

const title = (text, sub = "", x = 82, y = 220) => `
<text x="${x}" y="${y}" fill="#F7FAFF" font-family="PingFang SC,sans-serif" font-size="72" font-weight="800">${text}</text>
${sub ? `<text x="${x + 4}" y="${y + 58}" fill="#9DB2CB" font-family="PingFang SC,sans-serif" font-size="27">${sub}</text>` : ""}`;

const panel = (x, y, w, h, heading, body = "", color = "#6A86FF") => `
<g filter="url(#shadow)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="#172A42" stroke="#436481"/>
<rect x="${x}" y="${y}" width="7" height="${h}" rx="4" fill="${color}"/>
<text x="${x + 34}" y="${y + 54}" fill="#F5F8FF" font-family="PingFang SC,sans-serif" font-size="30" font-weight="700">${heading}</text>
${body ? `<text x="${x + 34}" y="${y + 96}" fill="#9FB2CA" font-family="PingFang SC,sans-serif" font-size="21">${body}</text>` : ""}</g>`;

const pill = (x, y, w, text, color = "#6A86FF") => `<rect x="${x}" y="${y}" width="${w}" height="54" rx="27" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-opacity=".72"/><circle cx="${x + 27}" cy="${y + 27}" r="6" fill="${color}"/><text x="${x + 46}" y="${y + 36}" fill="#EAF1FF" font-family="PingFang SC,sans-serif" font-size="22" font-weight="600">${text}</text>`;

const arrow = (x1, y1, x2, y2, color = "#61DCD4") => `<path d="M${x1} ${y1} L${x2 - 18} ${y2}" stroke="${color}" stroke-width="5" fill="none"/><path d="M${x2 - 28} ${y2 - 13} L${x2} ${y2} L${x2 - 28} ${y2 + 13}" fill="none" stroke="${color}" stroke-width="5"/>`;

const scenes = [];

scenes.push(base(`
<circle cx="960" cy="450" r="330" fill="url(#glow)" opacity=".9"/>
${logo(208, 270, 120)}
<text x="380" y="365" fill="#F8FBFF" font-family="PingFang SC,sans-serif" font-size="112" font-weight="800">50 秒看懂操作逻辑</text>
<rect x="382" y="408" width="1010" height="8" rx="4" fill="url(#accent)"/>
<text x="384" y="500" fill="#C5D5E9" font-family="PingFang SC,sans-serif" font-size="42" font-weight="600">准备 → 翻译 → 精修 → 导出</text>
<text x="384" y="578" fill="#8098B8" font-family="PingFang SC,sans-serif" font-size="27">自学型熟肉机 · 操作界面逻辑宣传片</text>
${pill(384, 680, 260, "输入与预习", "#42D7D0")}${pill(670, 680, 260, "Agent 执行", "#6A86FF")}${pill(956, 680, 260, "逐句把关", "#F58AB7")}${pill(1242, 680, 260, "成片交付", "#FFD166")}
`));

scenes.push(base(`
${title("三个工作区，一条完整状态流", "顶部导航对应真实数据状态，不是静态展示")}
${panel(90, 370, 450, 360, "1  准备", "视频、输出、知识与引擎", "#42D7D0")}
${panel(735, 370, 450, 360, "2  翻译", "任务清单、进度与阶段证据", "#6A86FF")}
${panel(1380, 370, 450, 360, "3  精修", "预览、时间轴、角色与逐句编辑", "#F58AB7")}
${arrow(555, 550, 710, 550)}${arrow(1200, 550, 1355, 550)}
<rect x="710" y="790" width="500" height="72" rx="36" fill="#FFD166" fill-opacity=".16" stroke="#FFD166"/>
<text x="960" y="837" text-anchor="middle" fill="#FFE5A6" font-family="PingFang SC,sans-serif" font-size="27" font-weight="700">导出 / 封装：重新质检后交付</text>
`));

scenes.push(base(`
${title("准备 01 · 视频与输出", "一个输入框自动识别 Bilibili、YouTube、本地路径与 yt-dlp 页面")}
<g filter="url(#shadow)"><rect x="66" y="166" width="1070" height="770" rx="34" fill="#F4F7FB" stroke="#7890A8"/><image href="${screenshot}" x="80" y="188" width="1030" height="724" preserveAspectRatio="xMidYMin slice" clip-path="url(#screen)"/></g>
${panel(1200, 236, 620, 160, "视频位置", "链接或本地完整路径", "#42D7D0")}
${panel(1200, 428, 620, 160, "输出策略", "目录 · 最高画质 · 不重编码", "#6A86FF")}
${panel(1200, 620, 620, 160, "交付格式", "SRT · ASS · MKV · MP4", "#F58AB7")}
${pill(1200, 824, 260, "智能识别来源", "#FFD166")}${pill(1485, 824, 300, "本地桥状态检查", "#42D7D0")}
`));

scenes.push(base(`
${title("准备 02–03 · 先定研究门槛，再选引擎", "角色、术语和称呼表未完成，就不会进入翻译阶段")}
${panel(90, 330, 810, 520, "翻译前预习", "知识关键词 + 优先搜索站点", "#FFD166")}
${pill(138, 445, 210, "作品名", "#6A86FF")}${pill(370, 445, 210, "角色名", "#F58AB7")}${pill(602, 445, 210, "活动名", "#42D7D0")}
${pill(138, 535, 300, "官方站点", "#42D7D0")}${pill(462, 535, 300, "Wikipedia", "#6A86FF")}
${pill(138, 625, 300, "Fandom / 萌娘", "#F58AB7")}${pill(462, 625, 300, "简介与评论", "#FFD166")}
${panel(980, 330, 840, 520, "翻译引擎", "按隐私、能力和成本选择", "#6A86FF")}
${pill(1030, 445, 220, "API Key", "#6A86FF")}${pill(1275, 445, 250, "Agent CLI", "#42D7D0")}${pill(1550, 445, 220, "本地显存", "#A78BFA")}
${panel(1030, 550, 340, 170, "Codex / Claude", "复用已有登录态", "#42D7D0")}
${panel(1415, 550, 355, 170, "DeepSeek / Ollama", "本地或自定义模型", "#A78BFA")}
`));

const stages = [["1","获取素材","#42D7D0"],["2","背景预习","#FFD166"],["3","原文听写","#6A86FF"],["4","精准翻译","#F58AB7"],["5","疑点复核","#A78BFA"],["6","字幕质检","#42D7D0"],["7","视频封装","#FF8A65"],["8","最终验证","#72D09C"]];
const stageCards = stages.map((s,i)=>{const x=90+(i%4)*445;const y=350+Math.floor(i/4)*250;return `<g filter="url(#shadow)"><rect x="${x}" y="${y}" width="400" height="190" rx="26" fill="#172A42" stroke="#436481"/><circle cx="${x+52}" cy="${y+54}" r="28" fill="${s[2]}" fill-opacity=".2" stroke="${s[2]}"/><text x="${x+52}" y="${y+64}" text-anchor="middle" fill="${s[2]}" font-family="Helvetica,sans-serif" font-size="25" font-weight="800">${s[0]}</text><text x="${x+96}" y="${y+66}" fill="#F4F8FF" font-family="PingFang SC,sans-serif" font-size="29" font-weight="700">${s[1]}</text><rect x="${x+34}" y="${y+112}" width="330" height="12" rx="6" fill="#0B1727"/><rect x="${x+34}" y="${y+112}" width="${i<3?330:72}" height="12" rx="6" fill="${s[2]}" opacity="${i<3?1:.35}"/><text x="${x+34}" y="${y+158}" fill="#8FA6C0" font-family="PingFang SC,sans-serif" font-size="20">${i<2?"证据已写入任务清单":i===2?"正在执行":"等待前置阶段"}</text></g>`;}).join("");
scenes.push(base(`${title("Precision Harness · 八阶段有序推进", "每一步都写状态、证据和验收结果")} ${stageCards}`));

scenes.push(base(`
${title("翻译页 · 看进度，也看依据", "页面读取任务清单；离开页面后，本地 Agent 仍会继续")}
<circle cx="310" cy="520" r="170" fill="#112B48" stroke="#315A7D" stroke-width="26"/><path d="M310 350 A170 170 0 1 1 155 590" fill="none" stroke="url(#accent)" stroke-width="28" stroke-linecap="round"/>
<text x="310" y="542" text-anchor="middle" fill="#F8FBFF" font-family="Helvetica,sans-serif" font-size="78" font-weight="800">48%</text>
<text x="310" y="606" text-anchor="middle" fill="#8FA6C0" font-family="PingFang SC,sans-serif" font-size="24">总进度</text>
<g filter="url(#shadow)"><rect x="600" y="300" width="1190" height="590" rx="34" fill="#172A42" stroke="#436481"/>
<text x="660" y="365" fill="#F5F8FF" font-family="PingFang SC,sans-serif" font-size="31" font-weight="700">阶段状态</text>
${[["✓","获取素材","已完成","#42D7D0"],["✓","背景预习","已完成","#FFD166"],["3","原文听写","执行中","#6A86FF"],["4","精准翻译","等待中","#F58AB7"],["5","疑点复核","等待中","#A78BFA"]].map((r,i)=>`<rect x="650" y="${405+i*88}" width="1090" height="68" rx="16" fill="#0F2035"/><circle cx="690" cy="${439+i*88}" r="22" fill="${r[3]}" fill-opacity=".18" stroke="${r[3]}"/><text x="690" y="${447+i*88}" text-anchor="middle" fill="${r[3]}" font-family="Helvetica,sans-serif" font-size="19" font-weight="800">${r[0]}</text><text x="735" y="${447+i*88}" fill="#EDF4FF" font-family="PingFang SC,sans-serif" font-size="25" font-weight="700">${r[1]}</text><text x="1670" y="${447+i*88}" text-anchor="end" fill="${r[3]}" font-family="PingFang SC,sans-serif" font-size="21">${r[2]}</text>`).join("")}</g>
`));

scenes.push(base(`
${title("精修页 · 视频、字幕样式和时间轴联动", "修改样式会即时反映到预览，角色颜色自动进入字幕效果")}
<g filter="url(#shadow)"><rect x="80" y="310" width="1080" height="480" rx="30" fill="#09111E" stroke="#35516E"/><rect x="130" y="355" width="980" height="310" rx="18" fill="#121E31"/><path d="M565 448 L565 570 L675 509 Z" fill="#EAF2FF" opacity=".92"/><text x="620" y="632" text-anchor="middle" fill="#FFF" stroke="#77BBDD" stroke-width="8" paint-order="stroke" font-family="PingFang SC,sans-serif" font-size="40" font-weight="800">即使迷失方向，也想继续向前</text>
<rect x="150" y="716" width="970" height="30" rx="8" fill="#0D1B2C"/><rect x="250" y="716" width="260" height="30" rx="8" fill="#FF8899"/><rect x="520" y="716" width="230" height="30" rx="8" fill="#77BBDD"/><rect x="760" y="716" width="300" height="30" rx="8" fill="#7777AA"/></g>
<g filter="url(#shadow)"><rect x="1220" y="310" width="620" height="480" rx="30" fill="#172A42" stroke="#436481"/><text x="1270" y="376" fill="#F5F8FF" font-family="PingFang SC,sans-serif" font-size="31" font-weight="700">字幕样式</text>${pill(1270,420,230,"最多两行","#6A86FF")}${pill(1520,420,260,"无多余句号","#42D7D0")}${pill(1270,500,230,"角色应援色","#F58AB7")}${pill(1520,500,260,"描边与发光","#FFD166")}<circle cx="1290" cy="620" r="16" fill="#77BBDD"/><text x="1320" y="628" fill="#DCE8F6" font-family="PingFang SC,sans-serif" font-size="23">高松灯</text><circle cx="1510" cy="620" r="16" fill="#FF8899"/><text x="1540" y="628" fill="#DCE8F6" font-family="PingFang SC,sans-serif" font-size="23">千早爱音</text><circle cx="1290" cy="686" r="16" fill="#77DD77"/><text x="1320" y="694" fill="#DCE8F6" font-family="PingFang SC,sans-serif" font-size="23">要乐奈</text></g>
`));

scenes.push(base(`
${title("时间轴 · 一个动作，同时定位视频和句子", "点字幕块跳到画面；拖动起止让字幕贴合说话声")}
<g filter="url(#shadow)"><rect x="90" y="350" width="1740" height="460" rx="32" fill="#13243A" stroke="#436481"/>
<text x="130" y="420" fill="#91A8C2" font-family="PingFang SC,sans-serif" font-size="22">视频</text><rect x="240" y="388" width="1520" height="68" rx="12" fill="#0D1A2B"/>${Array.from({length:14},(_,i)=>`<rect x="${255+i*106}" y="401" width="92" height="42" rx="6" fill="#253E59"/>`).join("")}
<text x="130" y="540" fill="#91A8C2" font-family="PingFang SC,sans-serif" font-size="22">字幕</text><rect x="240" y="500" width="1520" height="120" rx="12" fill="#0D1A2B"/>
<rect x="300" y="524" width="260" height="72" rx="10" fill="#FF8899" fill-opacity=".22" stroke="#FF8899"/><text x="320" y="568" fill="#F3F7FF" font-family="PingFang SC,sans-serif" font-size="20">那么，我们再从自我介绍开始吧</text>
<rect x="582" y="524" width="230" height="72" rx="10" fill="#77BBDD" fill-opacity=".22" stroke="#77BBDD"/><text x="602" y="568" fill="#F3F7FF" font-family="PingFang SC,sans-serif" font-size="20">我是饰演高松灯的羊宫妃那</text>
<rect x="835" y="524" width="300" height="72" rx="10" fill="#7777AA" fill-opacity=".22" stroke="#7777AA"/><text x="855" y="568" fill="#F3F7FF" font-family="PingFang SC,sans-serif" font-size="20">我是饰演椎名立希的林鼓子</text>
<line x1="760" y1="374" x2="760" y2="650" stroke="#61DCD4" stroke-width="5"/><circle cx="760" cy="374" r="10" fill="#61DCD4"/>
<text x="260" y="705" fill="#9DB2CB" font-family="PingFang SC,sans-serif" font-size="21">00:00</text><text x="740" y="705" fill="#9DB2CB" font-family="PingFang SC,sans-serif" font-size="21">00:10</text><text x="1220" y="705" fill="#9DB2CB" font-family="PingFang SC,sans-serif" font-size="21">00:20</text><text x="1690" y="705" text-anchor="end" fill="#9DB2CB" font-family="PingFang SC,sans-serif" font-size="21">00:30</text></g>
${pill(350,840,430,"点击句子 → 跳到对应画面","#42D7D0")}${pill(910,840,470,"调整起止 → 贴合说话声音","#F58AB7")}
`));

scenes.push(base(`
${title("逐句精修 · 人负责最后一公里", "低置信度优先复核，原文、译文、说话人和时间都可修改")}
<g filter="url(#shadow)"><rect x="90" y="320" width="920" height="560" rx="32" fill="#172A42" stroke="#436481"/><text x="140" y="388" fill="#F5F8FF" font-family="PingFang SC,sans-serif" font-size="30" font-weight="700">句子 06  ·  低置信度 84%</text><text x="140" y="455" fill="#8FA6C0" font-family="PingFang SC,sans-serif" font-size="21">说话人</text><rect x="140" y="476" width="360" height="58" rx="12" fill="#0D1B2D"/><text x="168" y="514" fill="#EEF5FF" font-family="PingFang SC,sans-serif" font-size="23">千早爱音</text><text x="540" y="455" fill="#8FA6C0" font-family="PingFang SC,sans-serif" font-size="21">开始 → 结束</text><rect x="540" y="476" width="410" height="58" rx="12" fill="#0D1B2D"/><text x="570" y="514" fill="#EEF5FF" font-family="Helvetica,sans-serif" font-size="22">00:19.100  →  00:23.600</text><text x="140" y="590" fill="#8FA6C0" font-family="PingFang SC,sans-serif" font-size="21">日语原文</text><rect x="140" y="612" width="810" height="70" rx="12" fill="#0D1B2D"/><text x="168" y="656" fill="#D9E5F4" font-family="PingFang SC,sans-serif" font-size="22">急に？ でも、埼玉にもおいしいお店ありそう。</text><text x="140" y="738" fill="#8FA6C0" font-family="PingFang SC,sans-serif" font-size="21">中文译文</text><rect x="140" y="760" width="810" height="76" rx="12" fill="#0D1B2D" stroke="#6A86FF"/><text x="168" y="808" fill="#F5F8FF" font-family="PingFang SC,sans-serif" font-size="27" font-weight="700">这么突然？不过埼玉应该也有好吃的店</text></g>
<g filter="url(#shadow)"><rect x="1080" y="320" width="750" height="560" rx="32" fill="#101E31" stroke="#436481"/><rect x="1140" y="390" width="630" height="330" rx="20" fill="#08111F"/><path d="M1185 450 V418 H1235 M1675 418 H1725 V450 M1185 660 V692 H1235 M1675 692 H1725 V660" fill="none" stroke="#61DCD4" stroke-width="7"/><rect x="1320" y="525" width="280" height="72" rx="12" fill="#FFFFFF" fill-opacity=".1" stroke="#FFFFFF" stroke-opacity=".55"/><text x="1460" y="570" text-anchor="middle" fill="#FFF" font-family="PingFang SC,sans-serif" font-size="28" font-weight="700">埼玉</text>${pill(1190,760,270,"标记待复核","#FFD166")}${pill(1485,760,280,"跳到画面 / OCR","#42D7D0")}</g>
`));

scenes.push(base(`
${logo(130,220,112)}
<text x="292" y="310" fill="#F8FBFF" font-family="PingFang SC,sans-serif" font-size="84" font-weight="800">确认修改，重新质检，再导出</text>
<text x="138" y="410" fill="#9DB2CB" font-family="PingFang SC,sans-serif" font-size="29">保存精修结果后，Harness 重新执行字幕 QC、封装和最终验证</text>
${panel(138,520,470,210,"SRT", "通用外挂字幕", "#6A86FF")}${panel(724,520,470,210,"ASS", "角色色与发光样式", "#42D7D0")}${panel(1310,520,470,210,"MKV / MP4", "字幕轨或成片封装", "#F58AB7")}
<rect x="138" y="820" width="1642" height="5" rx="3" fill="url(#accent)"/>
<text x="138" y="886" fill="#EAF1FF" font-family="PingFang SC,sans-serif" font-size="31" font-weight="700">先准备证据 → Agent 执行 → 人逐句把关</text>
<text x="1780" y="886" text-anchor="end" fill="#7E96B6" font-family="Helvetica,sans-serif" font-size="23">LOCAL · PRIVATE · AUDITABLE</text>
`, "PRECISION VIDEO SUBTITLES · UI LOGIC"));

scenes.forEach((svg, index) => fs.writeFileSync(path.join(assets, `scene-${String(index + 1).padStart(2, "0")}.svg`), svg));
console.log(`Generated ${scenes.length} UI guide scenes`);
