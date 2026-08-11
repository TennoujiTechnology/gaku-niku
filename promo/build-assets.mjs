import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const assets = path.join(root, "assets");
const shotPath = path.join(assets, "app-prepare.png");
const shot = fs.existsSync(shotPath)
  ? `data:image/png;base64,${fs.readFileSync(shotPath).toString("base64")}`
  : "";

const esc = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#081321"/>
      <stop offset="0.52" stop-color="#102844"/>
      <stop offset="1" stop-color="#151B3D"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#6A86FF"/>
      <stop offset="0.55" stop-color="#42D7D0"/>
      <stop offset="1" stop-color="#F58AB7"/>
    </linearGradient>
    <radialGradient id="glow">
      <stop offset="0" stop-color="#5C7CFA" stop-opacity=".45"/>
      <stop offset="1" stop-color="#5C7CFA" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#020916" flood-opacity=".55"/>
    </filter>
    <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="18" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="screenClip"><rect x="706" y="220" width="1080" height="710" rx="24"/></clipPath>
  </defs>`;

const base = (content, kicker = "SELF-LEARNING SUBTITLE STUDIO") => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1920" viewBox="0 0 1920 1920">
  ${defs}
  <rect width="1920" height="1920" fill="url(#bg)"/>
  <circle cx="1700" cy="120" r="470" fill="url(#glow)" opacity=".8"/>
  <circle cx="190" cy="1030" r="420" fill="url(#glow)" opacity=".36"/>
  <path d="M-120 940 C430 710 760 1110 1180 820 S1790 600 2070 760" fill="none" stroke="url(#accent)" stroke-width="3" opacity=".34"/>
  <text x="94" y="88" fill="#9FB4D3" font-family="PingFang SC, Helvetica, sans-serif" font-size="22" font-weight="600" letter-spacing="5">${kicker}</text>
  ${content}
</svg>`;

const logo = (x, y, size = 86) => `
  <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * .25)}" fill="#5D7DF2"/>
  <rect x="${x + 3}" y="${y + 3}" width="${size - 6}" height="${size - 6}" rx="${Math.round(size * .23)}" fill="none" stroke="#9EB5FF" stroke-width="3"/>
  <text x="${x + size / 2}" y="${y + size * .65}" text-anchor="middle" fill="white" font-family="Helvetica, sans-serif" font-size="${Math.round(size * .39)}" font-weight="800">CC</text>`;

const pill = (x, y, w, label, color = "#5C7CFA") => `
  <rect x="${x}" y="${y}" width="${w}" height="62" rx="31" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-opacity=".65"/>
  <circle cx="${x + 30}" cy="${y + 31}" r="7" fill="${color}"/>
  <text x="${x + 52}" y="${y + 40}" fill="#EAF1FF" font-family="PingFang SC, sans-serif" font-size="25" font-weight="600">${esc(label)}</text>`;

const card = (x, y, w, h, title, body, color = "#5C7CFA", index = "") => `
  <g filter="url(#shadow)">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="#172A42" stroke="#426383" stroke-opacity=".65"/>
    <rect x="${x}" y="${y}" width="8" height="${h}" rx="4" fill="${color}"/>
    ${index ? `<text x="${x + 34}" y="${y + 48}" fill="${color}" font-family="Helvetica, sans-serif" font-size="20" font-weight="800">${index}</text>` : ""}
    <text x="${x + 36}" y="${y + 88}" fill="#F5F8FF" font-family="PingFang SC, sans-serif" font-size="32" font-weight="700">${esc(title)}</text>
    <text x="${x + 36}" y="${y + 132}" fill="#AFC1D8" font-family="PingFang SC, sans-serif" font-size="22">${esc(body)}</text>
  </g>`;

const scenes = [];

scenes.push(base(`
  <circle cx="960" cy="470" r="350" fill="url(#glow)" opacity=".9"/>
  ${logo(184, 314, 128)}
  <text x="350" y="410" fill="#F8FBFF" font-family="PingFang SC, sans-serif" font-size="126" font-weight="800">自学型熟肉机</text>
  <rect x="356" y="446" width="820" height="8" rx="4" fill="url(#accent)"/>
  <text x="356" y="536" fill="#C5D4E8" font-family="PingFang SC, sans-serif" font-size="42" font-weight="500">先学背景 · 再做熟肉 · 本地封装</text>
  <text x="356" y="626" fill="#7F96B4" font-family="PingFang SC, sans-serif" font-size="28">30 秒了解一台会先自学的字幕工作站</text>
  ${pill(356, 710, 240, "知识预习", "#42D7D0")}
  ${pill(620, 710, 240, "精准翻译", "#6A86FF")}
  ${pill(884, 710, 240, "逐句精修", "#F58AB7")}
  ${pill(1148, 710, 240, "自动封装", "#FFD166")}
`, "PRECISION VIDEO SUBTITLES"));

scenes.push(base(`
  <text x="100" y="230" fill="#F8FBFF" font-family="PingFang SC, sans-serif" font-size="76" font-weight="800">翻译之前</text>
  <text x="100" y="322" fill="url(#accent)" font-family="PingFang SC, sans-serif" font-size="76" font-weight="800">先把作品学懂</text>
  <text x="104" y="396" fill="#9CB0C9" font-family="PingFang SC, sans-serif" font-size="28">不只换一种语言，更要把语境、人物和称呼带过去</text>
  ${card(820, 190, 430, 220, "作品背景", "世界观、时间线与活动信息", "#42D7D0", "01")}
  ${card(1300, 190, 430, 220, "角色关系", "人物身份、距离感与说话方式", "#6A86FF", "02")}
  ${card(820, 470, 430, 220, "称呼习惯", "敬语、昵称与粉丝语境", "#F58AB7", "03")}
  ${card(1300, 470, 430, 220, "专有名词", "官方译名、舞台名与梗", "#FFD166", "04")}
  <path d="M560 520 C680 520 690 300 800 300 M560 520 C680 520 690 580 800 580" fill="none" stroke="#6A86FF" stroke-width="4" stroke-dasharray="10 13" opacity=".7"/>
  <circle cx="535" cy="520" r="84" fill="#172A42" stroke="#6A86FF" stroke-width="3"/>
  <text x="535" y="500" text-anchor="middle" fill="#F4F7FF" font-family="PingFang SC, sans-serif" font-size="27" font-weight="700">研究</text>
  <text x="535" y="540" text-anchor="middle" fill="#9DB0C9" font-family="PingFang SC, sans-serif" font-size="22">Research</text>
`));

scenes.push(base(`
  <text x="100" y="246" fill="#F8FBFF" font-family="PingFang SC, sans-serif" font-size="66" font-weight="800">一处配置</text>
  <text x="100" y="330" fill="#61DCD4" font-family="PingFang SC, sans-serif" font-size="66" font-weight="800">全部流程</text>
  <text x="104" y="398" fill="#9CB0C9" font-family="PingFang SC, sans-serif" font-size="27">在线视频、本地文件、API 与 Agent CLI</text>
  ${pill(102, 482, 220, "Bilibili", "#F58AB7")}
  ${pill(102, 566, 220, "YouTube", "#FF6B6B")}
  ${pill(102, 650, 220, "本地视频", "#42D7D0")}
  ${pill(348, 482, 230, "API Key", "#6A86FF")}
  ${pill(348, 566, 230, "Agent CLI", "#FFD166")}
  ${pill(348, 650, 230, "本地显存", "#A78BFA")}
  <g filter="url(#shadow)">
    <rect x="686" y="154" width="1120" height="820" rx="34" fill="#F4F7FB" stroke="#6E8CAC" stroke-width="2"/>
    <rect x="686" y="154" width="1120" height="58" rx="34" fill="#12243C"/>
    <circle cx="726" cy="183" r="8" fill="#FF7185"/><circle cx="754" cy="183" r="8" fill="#FFD166"/><circle cx="782" cy="183" r="8" fill="#4CD3A0"/>
    <image href="${shot}" x="706" y="220" width="1080" height="760" preserveAspectRatio="xMidYMin slice" clip-path="url(#screenClip)"/>
  </g>
`));

const stages = [
  ["1", "获取素材", "最高授权画质", "#61DCD4"],
  ["2", "背景预习", "角色、术语、称呼", "#FFD166"],
  ["3", "原文听写", "逐句保留语气", "#6A86FF"],
  ["4", "精准翻译", "语境优先", "#F58AB7"],
  ["5", "疑点复核", "跳回画面 OCR", "#A78BFA"],
  ["6", "字幕质检", "两行与时序检查", "#42D7D0"],
  ["7", "视频封装", "保留原始画质", "#FF8A65"],
  ["8", "最终验证", "字幕流与校验", "#72D09C"],
];
const stageMarkup = stages.map((s, i) => {
  const x = 100 + (i % 4) * 440;
  const y = 340 + Math.floor(i / 4) * 250;
  return card(x, y, 390, 190, s[1], s[2], s[3], s[0]);
}).join("\n");
scenes.push(base(`
  <text x="100" y="220" fill="#F8FBFF" font-family="PingFang SC, sans-serif" font-size="72" font-weight="800">内置 8 阶段</text>
  <text x="725" y="220" fill="url(#accent)" font-family="Helvetica, sans-serif" font-size="72" font-weight="800">Precision Harness</text>
  <text x="104" y="284" fill="#9CB0C9" font-family="PingFang SC, sans-serif" font-size="27">每一步都有输入、证据和验收门槛</text>
  ${stageMarkup}
`));

scenes.push(base(`
  <text x="100" y="205" fill="#F8FBFF" font-family="PingFang SC, sans-serif" font-size="70" font-weight="800">一句一句，把字幕修到位</text>
  <text x="104" y="267" fill="#9CB0C9" font-family="PingFang SC, sans-serif" font-size="27">说话开始才出现，话音结束就消失</text>
  <g filter="url(#shadow)">
    <rect x="100" y="330" width="980" height="470" rx="30" fill="#0A111E" stroke="#36516F"/>
    <rect x="142" y="370" width="896" height="300" rx="18" fill="#121B2B"/>
    <circle cx="585" cy="498" r="95" fill="url(#glow)"/>
    <path d="M570 455 L570 542 L646 498 Z" fill="#EAF1FF" opacity=".9"/>
    <text x="590" y="610" text-anchor="middle" fill="#FFFFFF" stroke="#77BBDD" stroke-width="8" paint-order="stroke" font-family="PingFang SC, sans-serif" font-size="43" font-weight="800">即使迷失方向，也想继续向前</text>
    <line x1="142" y1="716" x2="1038" y2="716" stroke="#334D6B" stroke-width="2"/>
    <rect x="210" y="738" width="260" height="28" rx="8" fill="#FF8899"/>
    <rect x="480" y="738" width="190" height="28" rx="8" fill="#77BBDD"/>
    <rect x="680" y="738" width="310" height="28" rx="8" fill="#7777AA"/>
    <line x1="605" y1="694" x2="605" y2="784" stroke="#61DCD4" stroke-width="4"/>
  </g>
  <g filter="url(#shadow)">
    <rect x="1140" y="330" width="670" height="470" rx="30" fill="#172A42" stroke="#426383"/>
    <text x="1195" y="404" fill="#F6F8FF" font-family="PingFang SC, sans-serif" font-size="34" font-weight="700">字幕样式</text>
    ${pill(1195, 450, 250, "最多两行", "#6A86FF")}
    ${pill(1470, 450, 270, "无多余句号", "#42D7D0")}
    ${pill(1195, 536, 250, "角色应援色", "#F58AB7")}
    ${pill(1470, 536, 270, "描边与发光", "#FFD166")}
    <circle cx="1218" cy="684" r="18" fill="#77BBDD"/><text x="1254" y="694" fill="#DCE8F6" font-family="PingFang SC, sans-serif" font-size="25">高松灯</text>
    <circle cx="1438" cy="684" r="18" fill="#FF8899"/><text x="1474" y="694" fill="#DCE8F6" font-family="PingFang SC, sans-serif" font-size="25">千早爱音</text>
    <circle cx="1662" cy="684" r="18" fill="#77DD77"/><text x="1698" y="694" fill="#DCE8F6" font-family="PingFang SC, sans-serif" font-size="25">要乐奈</text>
  </g>
`));

scenes.push(base(`
  <text x="100" y="215" fill="#F8FBFF" font-family="PingFang SC, sans-serif" font-size="72" font-weight="800">有疑点，就回到画面找证据</text>
  <text x="104" y="278" fill="#9CB0C9" font-family="PingFang SC, sans-serif" font-size="27">OCR 抽帧、角色复核、逐句精修</text>
  <g filter="url(#shadow)">
    <rect x="100" y="350" width="750" height="470" rx="30" fill="#101C2E" stroke="#426383"/>
    <rect x="150" y="400" width="650" height="330" rx="20" fill="#0A111E"/>
    <path d="M195 465 V430 H250 M700 430 H755 V465 M195 665 V700 H250 M700 700 H755 V665" fill="none" stroke="#61DCD4" stroke-width="7"/>
    <rect x="305" y="522" width="340" height="86" rx="14" fill="#F5F8FF" fill-opacity=".10" stroke="#F5F8FF" stroke-opacity=".55"/>
    <text x="475" y="579" text-anchor="middle" fill="#FFFFFF" font-family="PingFang SC, sans-serif" font-size="34" font-weight="700">迷子集会</text>
    <text x="150" y="782" fill="#61DCD4" font-family="Helvetica, sans-serif" font-size="22" font-weight="800">OCR FRAME CHECK</text>
  </g>
  <g filter="url(#shadow)">
    <rect x="920" y="350" width="890" height="470" rx="30" fill="#172A42" stroke="#426383"/>
    <text x="980" y="424" fill="#F6F8FF" font-family="PingFang SC, sans-serif" font-size="34" font-weight="700">逐句精修</text>
    <text x="980" y="485" fill="#8FA5BF" font-family="PingFang SC, sans-serif" font-size="22">日语原文</text>
    <rect x="980" y="508" width="770" height="66" rx="14" fill="#0E1D30"/>
    <text x="1008" y="551" fill="#CEDAEB" font-family="PingFang SC, sans-serif" font-size="24">迷子でも、前へ進みたい。</text>
    <text x="980" y="623" fill="#8FA5BF" font-family="PingFang SC, sans-serif" font-size="22">中文译文</text>
    <rect x="980" y="646" width="770" height="82" rx="14" fill="#0E1D30" stroke="#6A86FF"/>
    <text x="1008" y="697" fill="#F6F8FF" font-family="PingFang SC, sans-serif" font-size="30" font-weight="700">即使迷失方向，也想继续向前</text>
    <rect x="1480" y="752" width="270" height="52" rx="26" fill="#5C7CFA"/>
    <text x="1615" y="787" text-anchor="middle" fill="#FFFFFF" font-family="PingFang SC, sans-serif" font-size="23" font-weight="700">保存本句  ⌘ ↵</text>
  </g>
`));

scenes.push(base(`
  ${logo(140, 210, 118)}
  <text x="308" y="305" fill="#F8FBFF" font-family="PingFang SC, sans-serif" font-size="88" font-weight="800">先学懂，再翻准</text>
  <text x="146" y="430" fill="#9CB0C9" font-family="PingFang SC, sans-serif" font-size="31">从视频源到外挂字幕与封装成片，一台机器完成</text>
  <g filter="url(#shadow)">
    <rect x="142" y="522" width="480" height="190" rx="30" fill="#172A42" stroke="#426383"/>
    <text x="192" y="585" fill="#9CB0C9" font-family="Helvetica, sans-serif" font-size="22" font-weight="800">OUTPUT</text>
    <text x="192" y="665" fill="#F5F8FF" font-family="Helvetica, sans-serif" font-size="58" font-weight="800">SRT</text>
  </g>
  <g filter="url(#shadow)">
    <rect x="682" y="522" width="480" height="190" rx="30" fill="#172A42" stroke="#426383"/>
    <text x="732" y="585" fill="#9CB0C9" font-family="Helvetica, sans-serif" font-size="22" font-weight="800">STYLED CC</text>
    <text x="732" y="665" fill="#61DCD4" font-family="Helvetica, sans-serif" font-size="58" font-weight="800">ASS</text>
  </g>
  <g filter="url(#shadow)">
    <rect x="1222" y="522" width="480" height="190" rx="30" fill="#172A42" stroke="#426383"/>
    <text x="1272" y="585" fill="#9CB0C9" font-family="Helvetica, sans-serif" font-size="22" font-weight="800">MUXED VIDEO</text>
    <text x="1272" y="665" fill="#F58AB7" font-family="Helvetica, sans-serif" font-size="58" font-weight="800">MKV</text>
  </g>
  <rect x="142" y="800" width="1560" height="4" rx="2" fill="url(#accent)"/>
  <text x="142" y="872" fill="#DCE7F6" font-family="PingFang SC, sans-serif" font-size="30" font-weight="600">自学型熟肉机</text>
  <text x="1702" y="872" text-anchor="end" fill="#7F96B4" font-family="Helvetica, sans-serif" font-size="24">LOCAL · PRIVATE · AUDITABLE</text>
`, "PRECISION VIDEO SUBTITLES · V0.1.0"));

scenes.forEach((svg, i) => {
  fs.writeFileSync(path.join(assets, `scene-${String(i + 1).padStart(2, "0")}.svg`), svg);
});

console.log(`Generated ${scenes.length} SVG scenes in ${assets}`);
