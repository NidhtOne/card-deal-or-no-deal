import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import { User, USER_STATUS } from '../entities/user.entity';

export interface AuthUserPayload {
  userId: number;
  username: string;
}

type AuthedRequest = Request & { user?: AuthUserPayload };

/**
 * JWT 守卫：校验 Authorization: Bearer <accessToken>。
 * 同时实时校验用户存在且状态正常 —— 账号注销（3.1.3 默认直接删除数据）后旧令牌立即失效。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException('未登录');

    let payload: { sub: number; username: string };
    try {
      payload = await this.jwtService.verifyAsync<{ sub: number; username: string }>(token);
    } catch {
      throw new UnauthorizedException('登录状态已失效');
    }

    const exists = await this.dataSource
      .getRepository(User)
      .exist({ where: { id: payload.sub, status: USER_STATUS.NORMAL } });
    if (!exists) throw new UnauthorizedException('账号不存在或已注销');

    req.user = { userId: payload.sub, username: payload.username };
    return true;
  }
}

/** 取当前登录用户（配合 JwtAuthGuard 使用） */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUserPayload => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new UnauthorizedException('未登录');
    return req.user;
  },
);
