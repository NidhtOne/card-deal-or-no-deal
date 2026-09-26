import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { Socket } from 'socket.io';

/**
 * WebSocket 网关（socket.io，挂载路径 /ws/socket.io，与 web 端 dev 代理 /ws 对应）。
 * 本阶段仅建立连接与断连日志；对局事件（docs/开发文档.md 6.4）在后续阶段实现。
 */
@WebSocketGateway({ path: '/ws/socket.io' })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  handleConnection(client: Socket): void {
    this.logger.log(`ws client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`ws client disconnected: ${client.id}`);
  }
}
