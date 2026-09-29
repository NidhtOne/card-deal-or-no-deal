import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 卡牌状态（docs/开发文档.md 5.1 game_cards.state：底牌/公共/已淘汰） */
export enum GameCardState {
  Own = '底牌',
  Public = '公共',
  Eliminated = '已淘汰',
}

/**
 * game_cards —— 对局卡牌表（docs/开发文档.md 5.1）。
 * (session_id, position) 唯一索引（5.2）。铁律 4：amount 为 INTEGER「分」。
 */
@Entity('game_cards')
@Index('UQ_game_cards_session_position', ['sessionId', 'position'], { unique: true })
export class GameCard {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'session_id' })
  sessionId!: number;

  /** 牌位 0–25（3.6.2） */
  @Column()
  position!: number;

  /** 面额（分，服务端生成、26 张唯一） */
  @Column()
  amount!: number;

  @Column({ type: 'text' })
  state!: GameCardState;

  /** 翻牌时间；未翻为 NULL */
  @Column({ name: 'flipped_at', type: 'datetime', nullable: true })
  flippedAt!: Date | null;
}
