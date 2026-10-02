/**
 * RiskPopup —— 风险提示弹窗（docs/开发文档.md 3.11），通用受控组件。
 * 两处复用（两触发点均受 risk_popup_enabled 控制后才挂载本组件）：
 * 1. 进入非取款机档位（LobbyPage）：确认 → 继续开局；取消 → 留在原页不调 start；
 * 2. 破产救助第 2/3 次（needsReminder=true）：仅确认按钮（信息型，无取消）。
 * 文案逐字来自 riskPopupText.ts（文档 3.11 逐字），禁止在调用处改写。
 */
export default function RiskPopup({
  title = '风险提示',
  message,
  confirmText = '确认',
  cancelText,
  onConfirm,
  onCancel,
}: {
  /** 弹窗标题（文档未定义，默认「风险提示」） */
  title?: string;
  /** 文案（必须传 riskPopupText.ts 的逐字常量） */
  message: string;
  /** 确认按钮文案（可传参，默认「确认」） */
  confirmText?: string;
  /** 取消按钮文案；不传则不渲染取消按钮（触发点 2 仅确认） */
  cancelText?: string;
  onConfirm: () => void;
  /** 取消回调；不传取消按钮时不要求 */
  onCancel?: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div className="w-full max-w-sm rounded-xl border border-amber-700/60 bg-slate-900 p-5 shadow-[0_0_40px_rgba(0,0,0,0.6)]">
        <h3 className="mb-3 text-base font-bold text-amber-300">{title}</h3>
        <p className="text-sm leading-relaxed text-slate-200">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          {cancelText && (
            <button
              onClick={onCancel}
              className="rounded-lg border border-slate-700 px-5 py-2 text-sm text-slate-300 hover:border-slate-500"
            >
              {cancelText}
            </button>
          )}
          <button
            onClick={onConfirm}
            className="rounded-lg bg-amber-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
