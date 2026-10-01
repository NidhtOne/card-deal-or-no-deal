import { formatMoney } from '../utils/money';

/**
 * 银行家报价模态弹窗（产品确认新增 —— 与文档 3.5 底部按钮布局的偏差已获产品确认：
 * 底部面板「当前报价 | 成交/还价/拒绝」保留为兜底入口，弹窗与面板共用同一 PlayerView
 * 数据源，弹窗内不另存报价状态；关闭弹窗 ≠ 决策，决策只走三个按钮）。
 *
 * 出现时机：BANKER_OFFER / FINAL_OFFER 且 currentOffer 非空（父组件控制挂载）；
 * 出现瞬间播放信封传递动效，银行家立绘高亮由页面 offerPhase 样式同步驱动；
 * 玩家完成决策（成交/还价成功/拒绝）后 currentOffer 变化，父组件负责销毁。
 */
export default function OfferModal(props: {
  /** 报价金额（分） */
  offerFen: number;
  /** 是否终极报价（FINAL_OFFER） */
  isFinal: boolean;
  bankerUrl: string | null;
  /** 本轮还价机会是否已消耗（3.6.5 每轮限 1 次） */
  counterUsed: boolean;
  /** busy 期间三按钮禁用防连点 */
  busy: boolean;
  onDeal: () => void;
  onCounter: () => void;
  onNoDeal: () => void;
  /** 仅收起弹窗，不做任何决策 */
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4">
      <div className="relative w-full max-w-md rounded-2xl border border-amber-700/60 bg-slate-900 p-6 shadow-2xl">
        {/* 报价传递动效（信封意象，弹窗出现瞬间播放一次） */}
        <span className="envelope-fly pointer-events-none absolute -top-2 left-2 inline-block text-2xl">
          ✉
        </span>
        <button
          onClick={props.onClose}
          disabled={props.busy}
          title="收起弹窗（不视为决策，可在底部面板继续操作）"
          className="absolute right-3 top-3 rounded p-1 text-slate-500 hover:text-slate-300 disabled:opacity-40"
        >
          ✕
        </button>

        <div className="flex items-center gap-4">
          <div
            className={`flex h-28 w-20 shrink-0 items-end justify-center overflow-hidden rounded-lg border bg-slate-950 sm:h-32 sm:w-24 ${
              props.isFinal ? 'banker-glow border-rose-500' : 'banker-glow border-amber-500'
            }`}
          >
            {props.bankerUrl ? (
              <img src={props.bankerUrl} alt="银行家" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full animate-pulse bg-slate-800" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            {props.isFinal ? (
              <span className="w-fit rounded bg-rose-900/60 px-2 py-0.5 text-xs font-semibold text-rose-300">
                终极报价
              </span>
            ) : (
              <span className="text-xs text-slate-400">银行家报价</span>
            )}
            <div className="text-3xl font-black text-amber-300">
              ¥{formatMoney(props.offerFen)}
            </div>
            <p className="text-xs text-slate-500">
              {props.isFinal ? '最后的机会：成交，或拒绝进入换牌决策。' : '成交收下报价，或拒绝继续翻牌。'}
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2">
          <button
            onClick={props.onDeal}
            disabled={props.busy}
            className="rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-bold hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            成交 Deal
          </button>
          <button
            onClick={props.onCounter}
            disabled={props.busy || props.counterUsed}
            title={props.counterUsed ? '本轮还价机会已用完（3.6.5 每轮限 1 次）' : undefined}
            className="rounded-lg bg-amber-500 px-3 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            还价{props.counterUsed ? '（本轮已用）' : ''}
          </button>
          <button
            onClick={props.onNoDeal}
            disabled={props.busy}
            className="rounded-lg bg-rose-600 px-3 py-2.5 text-sm font-bold hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            拒绝 No Deal
          </button>
        </div>
      </div>
    </div>
  );
}
