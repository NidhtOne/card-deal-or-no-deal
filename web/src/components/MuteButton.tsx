import { useState } from 'react';
import { getErrorMessage } from '../api/client';
import { useAudioStore } from '../audio/audioStore';

/**
 * MuteButton —— 对局页右上角快捷静音按钮（docs/开发文档.md 3.9）。
 * 【钦定语义，3.9 仅定义按钮存在 → 注释标注】按钮 = 切换 bgm_enabled：
 * 静音 → bgm_enabled=false 并 PUT /api/user/settings 持久化；恢复 → true，
 * 音量保持原值不清零；SFX 不受该按钮影响（sfx_enabled 独立）。
 * 持久化失败：回滚音频状态并提示（下次进站仍按服务端设置）。
 */
export default function MuteButton({ onError }: { onError?: (msg: string) => void }) {
  const muted = useAudioStore((s) => s.muted);
  const toggleBgmMuted = useAudioStore((s) => s.toggleBgmMuted);
  const [busy, setBusy] = useState(false);

  async function onToggle() {
    if (busy) return;
    setBusy(true);
    try {
      await toggleBgmMuted();
    } catch (err) {
      onError?.(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={() => void onToggle()}
      disabled={busy}
      title={muted ? '恢复背景音乐（音量保持原值）' : '静音背景音乐'}
      aria-pressed={muted}
      className="rounded border border-slate-700 px-2 py-0.5 text-sm leading-5 text-slate-300 hover:border-amber-400 hover:text-amber-300 disabled:opacity-40"
    >
      {muted ? '🔇' : '🔊'}
    </button>
  );
}
