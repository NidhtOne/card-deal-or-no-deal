import { useCallback, useEffect, useState } from 'react';
import { getErrorMessage } from '../api/client';
import { BankerOptions, CharacterHistory, uploadImage, userApi } from '../api/user';
import ImageCropUpload from '../components/ImageCropUpload';
import Layout from '../components/Layout';
import PageHeader from '../components/PageHeader';

/** 未上传角色图时的占位剪影（3.3：未上传时使用系统占位剪影，并引导上传） */
const CHARACTER_PLACEHOLDER = '/assets/placeholders/character-silhouette.png';

/**
 * /profile/character —— 我的角色（文档 3.3 / 第四章）：
 * 玩家角色立绘上传/裁剪（3:4）/最近 3 张历史切换；银行家内置选择 + 自定义上传。
 */
export default function CharacterPage() {
  const [history, setHistory] = useState<CharacterHistory | null>(null);
  const [banker, setBanker] = useState<BankerOptions | null>(null);
  const [characterOpen, setCharacterOpen] = useState(false);
  const [bankerOpen, setBankerOpen] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [h, b] = await Promise.all([userApi.getCharacterHistory(), userApi.getBankerOptions()]);
    setHistory(h);
    setBanker(b);
  }, []);

  useEffect(() => {
    reload().catch(() => setError('加载失败，请稍后重试'));
  }, [reload]);

  async function onActivate(id: number) {
    setError('');
    try {
      await userApi.activateCharacter(id);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function onSelectBanker(filename: string) {
    setError('');
    try {
      await userApi.selectBuiltinBanker(filename);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  const activeCharacterUrl = history?.activeUrl ?? null;
  const bankerDisplayUrl = banker?.currentUrl ?? banker?.defaultUrl ?? null;

  return (
    <Layout>
      <PageHeader />
      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold text-amber-300">我的角色</h1>
        {error && <p className="mb-4 text-sm text-rose-400">{error}</p>}

        {/* 玩家角色 */}
        <section className="mb-8 rounded-xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="mb-4 text-lg font-semibold">玩家角色立绘</h2>
          <div className="flex flex-wrap gap-6">
            <div className="w-48">
              <div className="aspect-[3/4] overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
                <img
                  src={activeCharacterUrl ?? CHARACTER_PLACEHOLDER}
                  alt="当前角色立绘"
                  className="h-full w-full object-cover"
                />
              </div>
              {!activeCharacterUrl && (
                <p className="mt-2 text-xs text-slate-500">未上传角色图，对局中将显示占位剪影</p>
              )}
              <button
                onClick={() => setCharacterOpen(true)}
                className="mt-3 w-full rounded bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400"
              >
                {activeCharacterUrl ? '更换立绘' : '上传立绘'}
              </button>
            </div>

            {/* 历史（最近 3 张，可切换） */}
            <div className="min-w-0 flex-1">
              <p className="mb-2 text-sm text-slate-400">历史立绘（保留最近 3 张，可切换）</p>
              {history && history.items.length > 0 ? (
                <div className="grid grid-cols-3 gap-3">
                  {history.items.map((item) => {
                    const active = item.url === history.activeUrl;
                    return (
                      <div key={item.id} className="w-full">
                        <div
                          className={`aspect-[3/4] overflow-hidden rounded-lg border ${
                            active ? 'border-amber-400' : 'border-slate-700'
                          } bg-slate-950`}
                        >
                          <img
                            src={item.url}
                            alt="历史立绘"
                            className="h-full w-full object-cover"
                          />
                        </div>
                        {active ? (
                          <p className="mt-1 text-center text-xs text-amber-300">使用中</p>
                        ) : (
                          <button
                            onClick={() => onActivate(item.id)}
                            className="mt-1 w-full rounded border border-slate-700 py-1 text-xs text-slate-300 hover:border-amber-400 hover:text-amber-300"
                          >
                            切换为这张
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-slate-600">暂无历史立绘</p>
              )}
            </div>
          </div>
        </section>

        {/* 银行家角色 */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="mb-4 text-lg font-semibold">银行家角色</h2>
          <div className="flex flex-wrap gap-6">
            <div className="w-40">
              <div className="aspect-[3/4] overflow-hidden rounded-lg border border-amber-400 bg-slate-950">
                {bankerDisplayUrl ? (
                  <img
                    src={bankerDisplayUrl}
                    alt="当前银行家"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-600">
                    暂无立绘
                  </div>
                )}
              </div>
              <p className="mt-2 text-center text-xs text-amber-300">当前银行家</p>
              <button
                onClick={() => setBankerOpen(true)}
                className="mt-3 w-full rounded border border-amber-500 px-3 py-2 text-xs text-amber-300 hover:bg-amber-500/10"
              >
                上传自定义银行家
              </button>
            </div>

            <div className="min-w-0 flex-1">
              <p className="mb-2 text-sm text-slate-400">内置银行家（点击切换）</p>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {banker?.builtin.map((b) => {
                  const active = banker.currentUrl === b.url;
                  return (
                    <button
                      key={b.filename}
                      onClick={() => onSelectBanker(b.filename)}
                      className={`overflow-hidden rounded-lg border ${
                        active ? 'border-amber-400' : 'border-slate-700 hover:border-slate-500'
                      }`}
                    >
                      <div className="aspect-[3/4] bg-slate-950">
                        <img
                          src={b.url}
                          alt={b.filename}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <p className="py-1 text-center text-xs text-slate-400">
                        {active ? '使用中' : b.filename}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </div>

      <ImageCropUpload
        open={characterOpen}
        title="上传角色立绘"
        aspect={3 / 4}
        hint="推荐 3:4 竖版立绘"
        onClose={() => setCharacterOpen(false)}
        onUpload={async (blob, onProgress) => {
          await uploadImage('/user/character', blob, onProgress);
          await reload();
        }}
      />
      <ImageCropUpload
        open={bankerOpen}
        title="上传自定义银行家"
        aspect={3 / 4}
        hint="推荐 3:4 竖版立绘"
        onClose={() => setBankerOpen(false)}
        onUpload={async (blob, onProgress) => {
          await uploadImage('/user/banker-character', blob, onProgress);
          await reload();
        }}
      />
    </Layout>
  );
}
