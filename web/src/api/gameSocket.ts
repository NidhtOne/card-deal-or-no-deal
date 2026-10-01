import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../store/auth';

/**
 * 对局 WebSocket（docs/开发文档.md 6.4 + M2 网关 server/src/match/match.gateway.ts）：
 * path /ws/socket.io、namespace /game、握手 auth: { token: JWT }。
 * 服务端→客户端：offer_ready / flip_result / timeout_warning / match_settled；
 * 客户端→服务端：heartbeat，载荷 { sessionId }（3.6.8：重置服务端 5 分钟超时计时）。
 * 事件载荷字段与 match.gateway.ts 的转发载荷逐字段对齐（只含玩家视图字段）。
 */

export interface OfferReadyEvent {
  sessionId: number;
  offer: { round: number | null; isFinal: boolean; phase: string; offerFen: number };
}

export interface FlipResultEvent {
  sessionId: number;
  round: number;
  /** 与 amountsFen 对齐（M3 逐张翻牌后恒为单元素；超时托管自动路径按牌位升序逐张） */
  positions: number[];
  amountsFen: number[];
}

export interface TimeoutWarningEvent {
  sessionId: number;
  remainingSeconds: number;
}

export interface MatchSettledEvent {
  sessionId: number;
  tier: number | null;
  status: string;
  timeout: boolean;
  settlement: {
    reason: string;
    prizeFen: number;
    profitFen: number;
    taxFen: number;
    netFen: number;
  };
  netProfitFen: number;
  settledBalanceFen: number;
}

/**
 * 建立 /game 命名空间连接（同源相对地址：dev 走 vite 代理 /ws，生产由后端直接托管）。
 * auth 回调每次（重）连都取最新 Access Token，配合 REST 拦截器的单飞行 Refresh 覆盖过期场景。
 */
export function connectGameSocket(): Socket {
  return io('/game', {
    path: '/ws/socket.io',
    auth: (cb) => cb({ token: useAuthStore.getState().accessToken ?? '' }),
  });
}
