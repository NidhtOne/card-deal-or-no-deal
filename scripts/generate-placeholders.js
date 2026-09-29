/**
 * 生成仓库内置占位资产（一次性工具脚本，需重新生成时运行：node scripts/generate-placeholders.js）：
 * - assets/bankers/banker-1/2/3.png：3 张内置银行家占位立绘（3:4 竖版，SVG 栅格化）
 * - assets/placeholders/character-silhouette.png：用户未上传角色图时的占位剪影（3:4）
 * - assets/placeholders/avatar-default.png：默认头像占位（1:1）
 * - assets/music/lobby.wav / match.wav / finale.wav：占位 BGM（1 秒静音 WAV，
 *   对应 3.9 大厅/对局/终局三种氛围；开源用户可直接替换目录内文件增删曲目）
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');

/** 竖版人物占位图（头 + 肩剪影 + 纯色背景） */
function portraitSvg({ width, height, bg, fg, label }) {
  const cx = width / 2;
  const headR = width * 0.18;
  const headCy = height * 0.34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="${bg}"/>
  <circle cx="${cx}" cy="${headCy}" r="${headR}" fill="${fg}"/>
  <path d="M ${cx - width * 0.3} ${height} C ${cx - width * 0.3} ${height * 0.52}, ${cx + width * 0.3} ${height * 0.52}, ${cx + width * 0.3} ${height} Z" fill="${fg}"/>
  <text x="${cx}" y="${height * 0.92}" font-size="${Math.round(width * 0.08)}" fill="#94a3b8" text-anchor="middle" font-family="sans-serif">${label}</text>
</svg>`;
}

/** 1 秒静音 WAV（PCM 16bit 单声道 8000Hz） */
function silentWavBuffer() {
  const sampleRate = 8000;
  const dataSize = sampleRate * 2; // 1 秒
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

async function main() {
  const bankers = [
    { file: 'banker-1.png', bg: '#1e3a8a', fg: '#3b82f6', label: 'Banker I' },
    { file: 'banker-2.png', bg: '#7c2d12', fg: '#ea580c', label: 'Banker II' },
    { file: 'banker-3.png', bg: '#14532d', fg: '#22c55e', label: 'Banker III' },
  ];
  for (const b of bankers) {
    const out = path.join(ROOT, 'assets', 'bankers', b.file);
    await sharp(Buffer.from(portraitSvg({ width: 600, height: 800, bg: b.bg, fg: b.fg, label: b.label })))
      .png()
      .toFile(out);
    console.log('written', out);
  }

  const placeholders = [
    { file: 'character-silhouette.png', w: 600, h: 800, label: '未上传角色图' },
    { file: 'avatar-default.png', w: 512, h: 512, label: '' },
  ];
  for (const p of placeholders) {
    const out = path.join(ROOT, 'assets', 'placeholders', p.file);
    await sharp(
      Buffer.from(portraitSvg({ width: p.w, height: p.h, bg: '#0f172a', fg: '#334155', label: p.label })),
    )
      .png()
      .toFile(out);
    console.log('written', out);
  }

  for (const track of ['lobby.wav', 'match.wav', 'finale.wav']) {
    const out = path.join(ROOT, 'assets', 'music', track);
    fs.writeFileSync(out, silentWavBuffer());
    console.log('written', out);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
