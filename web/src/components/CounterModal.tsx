import { useState } from 'react';
import { formatMoney, parseIntegerYuanToFen } from '../utils/money';

/**
 * 还价弹窗（docs/开发文档.md 3.6.5 + 任务书 §4）：
 * - UI 以元展示、整数输入，提交前 ×100 转整数分；本地非法输入直接驳回，
 *   不发请求、不消耗本轮还价次数；
 * - 范围提示：≥ 场上最低剩余面额、≤ 档位上限（面额清单关闭时最低面额不可得，
 *   降级只提示上限 —— 文档未明确该场景，按此默认实现，待人工确认）；
 * - 每轮限 1 次（counterUsed 时父组件不打开本弹窗）；
 * - 非法输入被服务端 400 驳回时不消耗次数，一律以后端响应刷新后的 state 为准。
 */
export default function CounterModal(props: {
  minRemainingFen: number | null;
  maxPrizeFen: number;
  currentOfferFen: number;
  submitting: boolean;
  serverError: string;
  onSubmit: (counterFen: number) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [localError, setLocalError] = useState('');

  function submit() {
    const fen = parseIntegerYuanToFen(input);
    if (fen === null) {
      setLocalError('请输入整数元金额（不带小数点）');
      return;
    }
    if (props.minRemainingFen !== null && fen < props.minRemainingFen) {
      setLocalError(`还价不得低于场上最低剩余面额 ¥${formatMoney(props.minRemainingFen)}`);
      return;
    }
    if (fen > props.maxPrizeFen) {
      setLocalError(`还价不得超过档位上限 ¥${formatMoney(props.maxPrizeFen)}`);
      return;
    }
    setLocalError('');
    props.onSubmit(fen);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <h3 className="mb-1 text-lg font-bold text-amber-300">向银行家还价</h3>
        <p className="mb-4 text-xs text-slate-500">
          当前报价 ¥{formatMoney(props.currentOfferFen)}；每轮限还价 1 次，还价失败保留原报价、不扣资金。
        </p>

        <div className="mb-2 flex items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setLocalError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !props.submitting) submit();
            }}
            placeholder="整数元金额"
            className="flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-lg text-slate-100 outline-none focus:border-amber-400"
          />
          <span className="text-sm text-slate-400">元</span>
        </div>

        <p className="mb-3 text-xs text-slate-500">
          范围：
          {props.minRemainingFen !== null
            ? `≥ 场上最低剩余面额 ¥${formatMoney(props.minRemainingFen)}`
            : '≥ 场上最低剩余面额（面额清单已关闭，无法预览）'}
          ，≤ 档位上限 ¥{formatMoney(props.maxPrizeFen)}
        </p>

        {(localError || props.serverError) && (
          <p className="mb-3 rounded border border-rose-800 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
            {localError || props.serverError}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={props.onClose}
            disabled={props.submitting}
            className="rounded border border-slate-700 px-5 py-2 text-sm text-slate-300 hover:border-slate-500"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={props.submitting}
            className="rounded bg-amber-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {props.submitting ? '提交中…' : '提交还价'}
          </button>
        </div>
      </div>
    </div>
  );
}
