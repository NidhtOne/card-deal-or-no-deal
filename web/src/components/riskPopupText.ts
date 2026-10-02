/**
 * 风险提示弹窗（docs/开发文档.md 3.11）：两处触发、受 risk_popup_enabled 全局开关控制。
 *
 * 触发点 1（3.11 第 1 条）：点击进入除取款机（tier===1）外档位时；
 * 触发点 2（3.11 第 2 条 / 3.8.4）：POST /api/bailout 返回 needsReminder=true（当日第 2、3 次申请）。
 *
 * 本文件只放「逐字文案 + 触发判定」纯函数（可单测文案一字不差与开关显隐），
 * 弹窗 UI 为通用受控组件 RiskPopup.tsx（标题/文案/确认按钮可传参，两处复用）。
 */

/** 触发点 1 文案（文档 3.11 第 1 条，逐字） */
export const RISK_TEXT_ENTRY =
  '提示：本游戏仅为虚拟娱乐，对局存在亏损风险，入场资金输掉不予返还，请理性游玩';

/** 触发点 2 文案（文档 3.11 第 2 条，逐字） */
export const RISK_TEXT_BAILOUT =
  '提示：您今日已经多次使用破产救助，请适当休息，注意游戏节奏';

/**
 * 触发点 1 显隐判定：非取款机档（tier!==1，取款机=新手保底档不提示）且开关开。
 * @param tier 目标档位（1=取款机）
 * @param riskPopupEnabled 用户设置 risk_popup_enabled
 */
export function shouldShowEntryRisk(tier: number, riskPopupEnabled: boolean): boolean {
  return tier !== 1 && riskPopupEnabled;
}

/**
 * 触发点 2 显隐判定：服务端标记 needsReminder（当日第 2/3 次申请）且开关开。
 * @param needsReminder POST /api/bailout 响应标记（文档外补充字段）
 * @param riskPopupEnabled 用户设置 risk_popup_enabled
 */
export function shouldShowBailoutReminder(needsReminder: boolean, riskPopupEnabled: boolean): boolean {
  return needsReminder && riskPopupEnabled;
}
