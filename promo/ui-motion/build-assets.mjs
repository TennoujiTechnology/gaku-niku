import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const assets = path.join(root, "assets");
const raw = path.join(assets, "raw");
fs.mkdirSync(assets, { recursive: true });

const imageData = (name) => {
  const file = path.join(raw, name);
  return fs.existsSync(file) ? `data:image/png;base64,${fs.readFileSync(file).toString("base64")}` : "";
};

const prepare = imageData("prepare.png");
const review = imageData("review.png");

const common = `
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#071220"/><stop offset=".55" stop-color="#102B4A"/><stop offset="1" stop-color="#1A1E42"/></linearGradient>
  <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#5D7DF2"/><stop offset=".5" stop-color="#45D5CC"/><stop offset="1" stop-color="#F58CB8"/></linearGradient>
  <radialGradient id="glow"><stop stop-color="#5D7DF2" stop-opacity=".56"/><stop offset="1" stop-color="#5D7DF2" stop-opacity="0"/></radialGradient>
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#020713" flood-opacity=".72"/></filter>
  <clipPath id="screen"><rect x="322" y="352" width="1276" height="718" rx="26"/></clipPath>
</defs>`;

const intro = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
${common}<rect width="1920" height="1080" fill="url(#bg)"/><circle cx="1650" cy="130" r="520" fill="url(#glow)"/>
<text x="96" y="95" fill="#9DB2CC" font-family="Helvetica,sans-serif" font-size="21" font-weight="700" letter-spacing="5">SELF-LEARNING SUBTITLE STUDIO</text>
<text x="96" y="205" fill="#F8FBFF" font-family="Hiragino Sans GB,sans-serif" font-size="76" font-weight="800">不是上传完，就算翻译</text>
<rect x="98" y="244" width="790" height="7" rx="4" fill="url(#accent)"/>
<text x="98" y="302" fill="#A9BCD3" font-family="Hiragino Sans GB,sans-serif" font-size="28">真实操作 · 研究门槛 · 人工精修 · 可审计交付</text>
<g filter="url(#shadow)"><rect x="302" y="332" width="1316" height="758" rx="34" fill="#EAF0F7" stroke="#7291B4" stroke-width="2"/><image href="${prepare}" x="322" y="352" width="1276" height="718" preserveAspectRatio="xMidYMid slice" clip-path="url(#screen)"/></g>
</svg>`;

const outro = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
${common}<rect width="1920" height="1080" fill="url(#bg)"/><image href="${review}" width="1920" height="1080" opacity=".13"/><rect width="1920" height="1080" fill="#071220" fill-opacity=".62"/>
<circle cx="960" cy="440" r="460" fill="url(#glow)"/>
<rect x="865" y="170" width="190" height="190" rx="48" fill="#5D7DF2" stroke="#A9BCFF" stroke-width="4"/><text x="960" y="292" text-anchor="middle" fill="#FFF" font-family="Helvetica,sans-serif" font-size="72" font-weight="800">CC</text>
<text x="960" y="470" text-anchor="middle" fill="#F8FBFF" font-family="Hiragino Sans GB,sans-serif" font-size="88" font-weight="800">自学型熟肉机</text>
<text x="960" y="548" text-anchor="middle" fill="#A8BDD5" font-family="Hiragino Sans GB,sans-serif" font-size="32">先学懂，再翻准</text>
<rect x="430" y="630" width="1060" height="5" rx="3" fill="url(#accent)"/>
<text x="960" y="724" text-anchor="middle" fill="#D9E6F5" font-family="Hiragino Sans GB,sans-serif" font-size="29" font-weight="700">研究证据  →  Agent 执行  →  人工把关  →  最终验证</text>
<text x="960" y="835" text-anchor="middle" fill="#7891AF" font-family="Helvetica,sans-serif" font-size="22" letter-spacing="5">LOCAL · PRIVATE · AUDITABLE</text>
</svg>`;

const cursor = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><filter id="s"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-opacity=".55"/></filter><g filter="url(#s)"><path d="M34 22 L126 91 L82 98 L105 137 L83 149 L61 108 L31 139 Z" fill="#FFFFFF" stroke="#15243A" stroke-width="6" stroke-linejoin="round"/></g><circle cx="34" cy="22" r="14" fill="#5DE1D7" fill-opacity=".2" stroke="#5DE1D7" stroke-width="5"/></svg>`;

fs.writeFileSync(path.join(assets, "intro.svg"), intro);
fs.writeFileSync(path.join(assets, "outro.svg"), outro);
fs.writeFileSync(path.join(assets, "cursor.svg"), cursor);
console.log("Generated dynamic promo assets");
