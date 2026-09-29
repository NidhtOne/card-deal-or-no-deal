import { useCallback, useEffect, useState } from 'react';
import { getErrorMessage } from '../api/client';
import { Settings, userApi } from '../api/user';
import Layout from '../components/Layout';
import PageHeader from '../components/PageHeader';

type EditableSettings = Omit<Settings, 'availableTracks'>;

/**
 * /settings —— 设置页（文档 3.7 / 第四章）：8 个设置项 UI 并持久化。
 * 音乐播放与风险提示弹窗的实际联动在后续阶段接入，本阶段只做读取与保存。
 */
export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState<EditableSettings | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    const s = await userApi.getSettings();
    setSettings(s);
    setForm({
      bgmEnabled: s.bgmEnabled,
      bgmTrack: s.bgmTrack,
      volume: s.volume,
      sfxEnabled: s.sfxEnabled,
      sfxVolume: s.sfxVolume,
      amountListEnabled: s.amountListEnabled,
      riskPopupEnabled: s.riskPopupEnabled,
      achievementEnabled: s.achievementEnabled,
    });
  }, []);

  useEffect(() => {
    reload().catch(() => setError('加载失败，请稍后重试'));
  }, [reload]);

  function patch<K extends keyof EditableSettings>(key: K, value: EditableSettings[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setMessage('');
  }

  async function onSave() {
    if (!form) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const saved = await userApi.updateSettings(form);
      setSettings(saved);
      setMessage('设置已保存');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!settings || !form) {
    return (
      <Layout>
        <PageHeader />
        <div className="flex flex-1 items-center justify-center text-slate-500">
          {error || '加载中…'}
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader />
      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold text-amber-300">设置</h1>
        <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6">
          <Toggle
            label="背景音乐"
            checked={form.bgmEnabled}
            onChange={(v) => patch('bgmEnabled', v)}
          />
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-slate-300">背景音乐曲目</span>
            <select
              value={form.bgmTrack}
              onChange={(e) => patch('bgmTrack', e.target.value)}
              disabled={!form.bgmEnabled}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm outline-none focus:border-amber-400 disabled:opacity-40"
            >
              {settings.availableTracks.map((track) => (
                <option key={track} value={track}>
                  {track}
                </option>
              ))}
            </select>
          </div>
          <Slider
            label="音乐音量"
            value={form.volume}
            disabled={!form.bgmEnabled}
            onChange={(v) => patch('volume', v)}
          />
          <Toggle
            label="音效"
            checked={form.sfxEnabled}
            onChange={(v) => patch('sfxEnabled', v)}
          />
          <Slider
            label="音效音量"
            value={form.sfxVolume}
            disabled={!form.sfxEnabled}
            onChange={(v) => patch('sfxVolume', v)}
          />
          <Toggle
            label="面额清单"
            hint="对局内展示 26 张面额集合，已淘汰实时划线"
            checked={form.amountListEnabled}
            onChange={(v) => patch('amountListEnabled', v)}
          />
          <Toggle
            label="风险提示弹窗"
            hint="进入非取款机档位、多次破产救助时弹出提示"
            checked={form.riskPopupEnabled}
            onChange={(v) => patch('riskPopupEnabled', v)}
          />
          <Toggle
            label="成就系统"
            checked={form.achievementEnabled}
            onChange={(v) => patch('achievementEnabled', v)}
          />

          {error && <p className="text-sm text-rose-400">{error}</p>}
          {message && <p className="text-sm text-emerald-400">{message}</p>}
          <button
            onClick={onSave}
            disabled={saving}
            className="rounded bg-amber-500 px-6 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
        <p className="mt-4 text-xs text-slate-600">
          音乐播放、音效与风险提示弹窗的实际联动将在对局阶段接入，本页面设置已实时持久化。
        </p>
      </div>
    </Layout>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <span className="text-sm text-slate-300">{label}</span>
        {hint && <p className="mt-0.5 text-xs text-slate-600">{hint}</p>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full transition-colors ${
          checked ? 'bg-amber-500' : 'bg-slate-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
            checked ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function Slider({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-slate-300">{label}</span>
      <div className="flex w-56 items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 accent-amber-400 disabled:opacity-40"
        />
        <span className="w-8 text-right text-sm text-slate-400">{value}</span>
      </div>
    </div>
  );
}
