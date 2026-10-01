import { api } from './client';

/**
 * GET /api/wallet（docs/开发文档.md 6.3 余额与流水）。
 * 响应体字段以服务端代码为准（server/src/wallet/wallet.controller.ts，文档外补充）；
 * 金额一律整数分（铁律 4）。
 */
export interface WalletView {
  balanceFen: number;
  flows: {
    id: number;
    amountFen: number;
    balanceAfterFen: number;
    /** 初始赠送/入场/奖金/税/签到/任务/救助/成就 */
    type: string;
    refId: string | null;
    createdAt: string;
  }[];
}

export const walletApi = {
  getWallet: () => api.get<WalletView>('/wallet').then((r) => r.data),
};
