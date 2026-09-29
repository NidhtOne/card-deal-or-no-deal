import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Namespace, Socket } from 'socket.io';
import { DataSource } from 'typeorm';
import { User, USER_STATUS } from '../entities/user.entity';
import { GameSessionService } from './game-session.service';

/** WS 内部载荷（进程内事件总线 → 网关转发；只含玩家视图字段，禁泄牌） */
interface OfferReadyPayload {
  userId: number;
  sessionId: number;
  offer: { round: number | null; isFinal: boolean; phase: string; offerFen: number };
}
interface FlipResultPayload {
  userId: number;
  sessionId: number;
  round: number;
  positions: number[];
  amountsFen: number[];
}
interface TimeoutWarningPayload {
  userId: number;
  sessionId: number;
  remainingSeconds: number;
}
interface MatchSettledPayload {
  userId: number;
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

function roomOf(userId: number): string {
  return `user:${userId}`;
}

/**
 * 对局 WebSocket 网关（docs/开发文档.md 6.4）。
 * 复用 EventsGateway 的 path（/ws/socket.io），namespace '/game'
 * （文档 6.4 未定义命名空间 —— 文档外补充，注释标注）。
 * JWT 握手鉴权（复用 M1 auth）；连接后按 userId 归房，仅向会话属主推送。
 * 服务端→客户端：offer_ready / flip_result / timeout_warning / match_settled；
 * 客户端→服务端：heartbeat（重置内存超时计时）。
 */
@WebSocketGateway({ path: '/ws/socket.io', namespace: '/game' })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GameGateway.name);

  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly jwtService: JwtService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: GameSessionService,
  ) {}

  /** JWT 握手鉴权：token 取自 handshake.auth.token / Authorization: Bearer / query.token */
  async handleConnection(client: Socket): Promise<void> {
    try {
      const auth = (client.handshake.auth ?? {}) as Record<string, unknown>;
      const header = client.handshake.headers.authorization ?? '';
      const queryToken = client.handshake.query.token;
      const token =
        (typeof auth.token === 'string' && auth.token) ||
        (header.startsWith('Bearer ') ? header.slice(7) : '') ||
        (typeof queryToken === 'string' ? queryToken : '');
      if (!token) throw new Error('no token');
      const payload = await this.jwtService.verifyAsync<{ sub: number }>(token);
      const exists = await this.dataSource
        .getRepository(User)
        .exist({ where: { id: payload.sub, status: USER_STATUS.NORMAL } });
      if (!exists) throw new Error('user gone');
      client.data.userId = payload.sub;
      await client.join(roomOf(payload.sub));
      this.logger.debug(`game ws connected: user=${payload.sub} socket=${client.id}`);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`game ws disconnected: ${client.id}`);
  }

  /** 客户端心跳：重置内存 timeout_deadline（只更新内存不写库，见 service 注释） */
  @SubscribeMessage('heartbeat')
  async heartbeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: boolean }> {
    const userId = client.data.userId as number | undefined;
    const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
    if (!userId || typeof sessionId !== 'number' || !Number.isInteger(sessionId)) {
      return { ok: false };
    }
    await this.sessions.heartbeat(sessionId, userId);
    return { ok: true };
  }

  @OnEvent('offer_ready')
  onOfferReady(payload: OfferReadyPayload): void {
    const { userId, ...rest } = payload;
    this.server.to(roomOf(userId)).emit('offer_ready', rest);
  }

  @OnEvent('flip_result')
  onFlipResult(payload: FlipResultPayload): void {
    const { userId, ...rest } = payload;
    this.server.to(roomOf(userId)).emit('flip_result', rest);
  }

  @OnEvent('timeout_warning')
  onTimeoutWarning(payload: TimeoutWarningPayload): void {
    const { userId, ...rest } = payload;
    this.server.to(roomOf(userId)).emit('timeout_warning', rest);
  }

  @OnEvent('match_settled')
  onMatchSettled(payload: MatchSettledPayload): void {
    const { userId, ...rest } = payload;
    this.server.to(roomOf(userId)).emit('match_settled', rest);
  }
}
