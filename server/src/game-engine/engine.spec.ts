import {
  createGame,
  restoreGame,
  GameRuleError,
  GameStatus,
  calcTaxFen,
  POOL_SIZE,
  type GameEngine,
  type GameEvent,
  type GameSnapshot,
} from './index';

/** 受控 fixture（金额单位：元，引擎内转分） */
function makeTiersRaw() {
  return {
    common: {
      flip_sequence: [6, 5, 4, 3, 2],
      anchor_amounts: [0.01, 0.1, 1, 10, 50],
      pool_jitter: 0.25,
      k_ranges: {
        early: { min: 0.55, max: 0.75 },
        mid: { min: 0.65, max: 0.85 },
        final: { min: 0.8, max: 0.95 },
      },
      k_phase_rounds: { early_max_round: 2, mid_max_round: 4 },
      counter: { accept_ratio: 0.85, prob_hi: 0.9, prob_lo: 0.3 },
    },
    tiers: {
      test: {
        name: '测试档',
        entry_fee: 388,
        max_prize: 10000,
        amounts: [
          0.01, 0.1, 1, 10, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1400, 1600,
          1800, 2000, 2500, 3000, 4000, 5000, 7500, 10000,
        ],
        weights: Array(POOL_SIZE).fill(1),
      },
    },
  };
}

function makeEconomyRaw() {
  return {
    initial_funds: 10000,
    tax: {
      threshold: 1000,
      brackets: [5000, 20000, 100000, 500000],
      rates: [0.03, 0.1, 0.2, 0.28, 0.35],
    },
    signin: {},
    tasks: {},
    bailout: {},
    achievements: {},
  };
}

function createTestGame(seed = 'engine-seed'): GameEngine {
  return createGame({
    tierId: 'test',
    seed,
    tiersConfig: makeTiersRaw(),
    economyConfig: makeEconomyRaw(),
  });
}

function eventsOf<T extends GameEvent['type']>(events: GameEvent[], type: T) {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

/** 剩余金额（含底牌），从快照派生 */
function remainingAmounts(state: GameSnapshot): number[] {
  return state.poolFen.filter((_, i) => !state.eliminated[i]);
}

/** 从快照计算当前 EV（与引擎内部一致） */
function currentEv(state: GameSnapshot): number {
  const r = remainingAmounts(state);
  return r.reduce((a, b) => a + b, 0) / r.length;
}

/** 逐张翻完当前轮（按牌位升序，与前端点击交互一致），返回追加事件 */
function flipRoundByCard(game: GameEngine): GameEvent[] {
  const events: GameEvent[] = [];
  for (;;) {
    const s = game.getState();
    if (s.status !== GameStatus.FlipRound) break;
    const p = s.poolFen.findIndex((_, i) => !s.eliminated[i] && i !== s.ownIndex);
    if (p < 0) throw new Error('无公共牌可翻（测试辅助函数内部错误）');
    events.push(...game.flipCardAtPosition(p));
  }
  return events;
}

function playToFirstOffer(game: GameEngine, pickIndex = 7): void {
  game.pickOwnCard(pickIndex);
  flipRoundByCard(game);
}

/** 一路 noDeal 推进到终局报价 */
function playToFinalOffer(game: GameEngine): void {
  playToFirstOffer(game);
  for (;;) {
    const status = game.getState().status;
    if (status === GameStatus.FinalOffer) return;
    if (status === GameStatus.BankerOffer) {
      game.respondOffer('noDeal');
    } else if (status === GameStatus.FlipRound) {
      game.flipCurrentRound();
    } else {
      throw new Error(`playToFinalOffer 遇到意外状态 ${status}`);
    }
  }
}

/** 一路 noDeal 推进到换牌决策 */
function playToSwapDecision(game: GameEngine): void {
  playToFinalOffer(game);
  game.respondOffer('noDeal');
}

describe('engine：创建与事件日志（规则四.5.2、七章.3）', () => {
  it('首条事件写入 seed，序号从 1 递增，含卡池生成记录', () => {
    const game = createTestGame('seed-mark-1');
    const events = game.getState().events;
    expect(events[0]).toMatchObject({
      type: 'game_created',
      seq: 1,
      seed: 'seed-mark-1',
      timeout: false,
    });
    expect(events[1]).toMatchObject({ type: 'pool_generated', seq: 2, timeout: false });
    expect((events[1] as { poolFen: number[] }).poolFen).toHaveLength(POOL_SIZE);
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    // 引擎内禁止时间戳
    for (const e of events) {
      expect(e).not.toHaveProperty('timestamp');
      expect(e).not.toHaveProperty('time');
    }
  });

  it('未知档位抛 ConfigError', () => {
    expect(() =>
      createGame({
        tierId: 'nope',
        seed: 's',
        tiersConfig: makeTiersRaw(),
        economyConfig: makeEconomyRaw(),
      }),
    ).toThrow(/未知档位/);
  });

  it('非法配置在创建时抛错（加载校验）', () => {
    const bad = makeTiersRaw();
    bad.common.counter.accept_ratio = 1.5;
    expect(() =>
      createGame({ tierId: 'test', seed: 's', tiersConfig: bad, economyConfig: makeEconomyRaw() }),
    ).toThrow();
  });
});

describe('engine：状态机主流程（3.6.3；附录 A：轮次翻牌数 6/5/4/3/2/1… 固定）', () => {
  it('完整流程：翻牌序列 6/5/4/3/2/1/1/1/1，剩 2 张进终局，换牌后结算', () => {
    const game = createTestGame('full-flow');
    game.pickOwnCard(7);
    const flipCounts: number[] = [];
    let sawFinalOffer = false;
    for (let guard = 0; guard < 50; guard++) {
      const status = game.getState().status;
      if (status === GameStatus.FlipRound) {
        const events = flipRoundByCard(game);
        const flips = eventsOf(events, 'cards_flipped');
        flipCounts.push(flips.reduce((acc, e) => acc + e.positions.length, 0));
      } else if (status === GameStatus.BankerOffer) {
        game.respondOffer('noDeal');
      } else if (status === GameStatus.FinalOffer) {
        sawFinalOffer = true;
        // 终局时恰好剩 2 张（底牌 + 1 张公共牌）
        expect(remainingAmounts(game.getState())).toHaveLength(2);
        game.respondOffer('noDeal');
      } else if (status === GameStatus.SwapDecision) {
        game.decideSwap(false);
      } else if (status === GameStatus.Settle) {
        break;
      }
    }
    expect(game.getState().status).toBe(GameStatus.Settle);
    expect(flipCounts).toEqual([6, 5, 4, 3, 2, 1, 1, 1, 1]); // 附录 A：轮次翻牌数固定
    expect(sawFinalOffer).toBe(true);

    const events = game.getState().events;
    // 淘汰总数 24：25 张公共牌翻 24 张，留 1 张与底牌进终局换牌
    const totalFlipped = eventsOf(events, 'cards_flipped').reduce(
      (acc, e) => acc + e.positions.length,
      0,
    );
    expect(totalFlipped).toBe(POOL_SIZE - 2);
    // reveal：保留底牌 → 税前奖金 = 底牌金额（二选一不相加）
    const reveal = eventsOf(events, 'reveal')[0];
    expect(reveal.prizeFen).toBe(reveal.ownAmountFen);
    expect(reveal.prizeFen).not.toBe(reveal.ownAmountFen + reveal.publicAmountFen);
    // 结算一致性
    const state = game.getState();
    const settlement = state.settlement;
    expect(settlement).not.toBeNull();
    expect(settlement!.reason).toBe('keep');
    expect(settlement!.prizeFen).toBe(reveal.prizeFen);
    expect(settlement!.profitFen).toBe(reveal.prizeFen - state.tier.entryFeeFen);
    expect(settlement!.taxFen).toBe(calcTaxFen(settlement!.profitFen, state.tax).taxFen);
    expect(settlement!.netFen).toBe(settlement!.prizeFen - settlement!.taxFen);
    // 序号连续递增
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it('DEAL 成交：报价即税前奖金，计税结算（规则五.1/十一章）', () => {
    const game = createTestGame('deal-flow');
    playToFirstOffer(game);
    const offer = game.getState().currentOffer!;
    const events = game.respondOffer('deal');
    expect(events.map((e) => e.type)).toEqual(['offer_response', 'tax_calculated', 'settled']);
    const state = game.getState();
    expect(state.status).toBe(GameStatus.Settle);
    const settled = eventsOf(events, 'settled')[0];
    expect(settled.prizeFen).toBe(offer.offerFen);
    expect(settled.reason).toBe('deal');
    const taxEvent = eventsOf(events, 'tax_calculated')[0];
    expect(taxEvent.profitFen).toBe(offer.offerFen - state.tier.entryFeeFen);
    expect(taxEvent.taxFen).toBe(calcTaxFen(taxEvent.profitFen, state.tax).taxFen);
  });

  it('命令返回追加的事件数组', () => {
    const game = createTestGame('cmd-events');
    const pickEvents = game.pickOwnCard(3);
    expect(pickEvents.map((e) => e.type)).toEqual(['own_card_picked']);
    const flipEvents = flipRoundByCard(game);
    expect(flipEvents.map((e) => e.type)).toEqual([
      'cards_flipped',
      'cards_flipped',
      'cards_flipped',
      'cards_flipped',
      'cards_flipped',
      'cards_flipped',
      'offer_made',
    ]);
    const dealEvents = game.respondOffer('deal');
    expect(dealEvents.map((e) => e.type)).toEqual(['offer_response', 'tax_calculated', 'settled']);
    // 追加语义：返回的正是事件日志的尾部切片
    const all = game.getState().events;
    const appended = [...pickEvents, ...flipEvents, ...dealEvents];
    expect(all.slice(-appended.length)).toEqual(appended);
  });
});

describe('engine：还价机制（3.6.5、规则四.3；附录 A：每轮还价 1 次、非法还价不计次数）', () => {
  it('还价 ≤ 0.85EV 必接受 → 按还价金额成交', () => {
    const game = createTestGame('counter-accept');
    playToFirstOffer(game);
    const state = game.getState();
    const ev = currentEv(state);
    const minRemain = Math.min(...remainingAmounts(state));
    const counter = Math.max(minRemain, Math.floor(ev * 0.5)); // 远低于 0.85EV
    expect(counter).toBeLessThanOrEqual(ev * 0.85);
    const events = game.respondOffer({ counter });
    const counterEvent = eventsOf(events, 'counter_made')[0];
    expect(counterEvent.accepted).toBe(true);
    expect(counterEvent.draw).toBeNull();
    expect(counterEvent.counterFen).toBe(counter);
    const settled = eventsOf(events, 'settled')[0];
    expect(settled.prizeFen).toBe(counter);
    expect(settled.reason).toBe('counter');
  });

  it('还价 > EV 必拒：保留原报价、回到报价态、不扣资金、可再 DEAL 原报价', () => {
    const game = createTestGame('counter-reject');
    playToFirstOffer(game);
    const state = game.getState();
    const ev = currentEv(state);
    const offerBefore = state.currentOffer!;
    const counter = state.tier.maxPrizeFen; // 必 > EV（剩余卡不可能全为上限值）
    expect(counter).toBeGreaterThan(ev);
    const events = game.respondOffer({ counter });
    const counterEvent = eventsOf(events, 'counter_made')[0];
    expect(counterEvent.accepted).toBe(false);
    expect(counterEvent.draw).toBeNull();
    const after = game.getState();
    expect(after.status).toBe(GameStatus.BankerOffer); // 回到报价态
    expect(after.currentOffer).toEqual(offerBefore); // 原报价保留
    expect(after.counterUsed).toBe(true); // 机会已消耗
    expect(after.settlement).toBeNull(); // 未扣资金
    // 原报价仍可 DEAL
    const dealEvents = game.respondOffer('deal');
    expect(eventsOf(dealEvents, 'settled')[0].prizeFen).toBe(offerBefore.offerFen);
  });

  it('还价落在 (0.85EV, EV] 中间分支：记录概率与抽签，accepted = draw < P', () => {
    const game = createTestGame('counter-mid');
    playToFirstOffer(game);
    const ev = currentEv(game.getState());
    const counter = Math.ceil(ev * 0.9);
    expect(counter).toBeGreaterThan(ev * 0.85);
    expect(counter).toBeLessThanOrEqual(ev);
    const events = game.respondOffer({ counter });
    const e = eventsOf(events, 'counter_made')[0];
    expect(e.probability).not.toBeNull();
    expect(e.probability!).toBeGreaterThan(0.3);
    expect(e.probability!).toBeLessThan(0.9);
    expect(e.draw).not.toBeNull();
    expect(e.accepted).toBe(e.draw! < e.probability!);
  });

  it('每轮限还价 1 次；新一轮报价后重置', () => {
    const game = createTestGame('counter-once');
    playToFirstOffer(game);
    const ev = currentEv(game.getState());
    game.respondOffer({ counter: game.getState().tier.maxPrizeFen }); // 必拒分支，消耗机会
    expect(ev).toBeGreaterThan(0);
    expect(() => game.respondOffer({ counter: 100 })).toThrow(GameRuleError);
    expect(game.getLegalActions()).not.toContain('counter');
    // 拒绝报价进下一轮 → 还价机会重置
    game.respondOffer('noDeal');
    game.flipCurrentRound();
    expect(game.getLegalActions()).toContain('counter');
  });

  it('终局 2 张阶段同样限 1 次还价', () => {
    const game = createTestGame('counter-final');
    playToFinalOffer(game);
    const state = game.getState();
    expect(state.status).toBe(GameStatus.FinalOffer);
    const ev = currentEv(state);
    const counter = Math.ceil(ev * 0.9); // 中间分支，可能接受也可能拒绝
    const events = game.respondOffer({ counter });
    if (eventsOf(events, 'counter_made')[0].accepted) {
      expect(game.getState().status).toBe(GameStatus.Settle);
      return; // 接受了就直接成交，无法验证第二次
    }
    expect(game.getState().status).toBe(GameStatus.FinalOffer);
    expect(() => game.respondOffer({ counter })).toThrow(GameRuleError);
    // 但终局机会与常规轮相互独立：此前各轮还价不占用终局机会（本局此前未还价，天然成立）
  });

  it('终局还价接受 → 按还价成交（终局 DEAL 路径）', () => {
    const game = createTestGame('counter-final-accept');
    playToFinalOffer(game);
    const state = game.getState();
    const ev = currentEv(state);
    const minRemain = Math.min(...remainingAmounts(state));
    const counter = Math.max(minRemain, Math.floor(ev * 0.5));
    const events = game.respondOffer({ counter });
    expect(eventsOf(events, 'counter_made')[0].accepted).toBe(true);
    expect(eventsOf(events, 'settled')[0].prizeFen).toBe(counter);
  });

  it('非法还价驳回且不计入次数：非整数/低于最低面额/超上限/负数', () => {
    const game = createTestGame('counter-illegal');
    playToFirstOffer(game);
    const state = game.getState();
    const minRemain = Math.min(...remainingAmounts(state));
    const cap = state.tier.maxPrizeFen;
    const illegalInputs: number[] = [100.5, -1, minRemain - 1, cap + 1];
    for (const bad of illegalInputs) {
      expect(() => game.respondOffer({ counter: bad })).toThrow(GameRuleError);
      expect(game.getState().counterUsed).toBe(false); // 不计次数
      expect(game.getLegalActions()).toContain('counter');
    }
    // 非法输入不产生事件
    const before = game.getState().events.length;
    expect(() => game.respondOffer({ counter: minRemain - 1 })).toThrow();
    expect(game.getState().events.length).toBe(before);
    // 合法还价仍可用
    const ok = game.respondOffer({
      counter: Math.max(minRemain, Math.floor(currentEv(game.getState()) * 0.5)),
    });
    expect(eventsOf(ok, 'counter_made')[0].accepted).toBe(true);
  });
});

describe('engine：非法操作与终局换牌（3.6.6；附录 A：终局仅 2 张牌可换牌，二选一不相加）', () => {
  it('非法状态操作一律抛 GameRuleError', () => {
    const game = createTestGame('illegal-ops');
    expect(() => game.flipCurrentRound()).toThrow(GameRuleError); // 未选底牌
    expect(() => game.flipCardAtPosition(0)).toThrow(GameRuleError);
    expect(() => game.respondOffer('deal')).toThrow(GameRuleError);
    expect(() => game.decideSwap(true)).toThrow(GameRuleError);
    game.pickOwnCard(0);
    expect(() => game.pickOwnCard(1)).toThrow(GameRuleError); // 重复选
    expect(() => game.respondOffer('noDeal')).toThrow(GameRuleError); // 还没有报价
    flipRoundByCard(game);
    expect(() => game.flipCurrentRound()).toThrow(GameRuleError); // 报价态不能翻牌
    expect(() => game.flipCardAtPosition(1)).toThrow(GameRuleError);
    expect(() => game.decideSwap(false)).toThrow(GameRuleError);
  });

  it('底牌序号非法抛错', () => {
    const game = createTestGame('bad-index');
    expect(() => game.pickOwnCard(-1)).toThrow(GameRuleError);
    expect(() => game.pickOwnCard(POOL_SIZE)).toThrow(GameRuleError);
    expect(() => game.pickOwnCard(2.5)).toThrow(GameRuleError);
  });

  it('报价响应形状非法抛错', () => {
    const game = createTestGame('bad-response');
    playToFirstOffer(game);
    expect(() => game.respondOffer('maybe' as never)).toThrow(GameRuleError);
    expect(() => game.respondOffer({} as never)).toThrow(GameRuleError);
    expect(() => game.respondOffer({ counter: '100' } as never)).toThrow(GameRuleError);
  });

  it('终局换牌：二选一，只取所选一张为税前奖金，不相加', () => {
    const game = createTestGame('swap-choice');
    playToSwapDecision(game);
    const snap = game.getState();
    const ownIndex = snap.ownIndex!;
    const publicIndex = snap.eliminated.findIndex((e, i) => !e && i !== ownIndex);
    const ownAmount = snap.poolFen[ownIndex];
    const publicAmount = snap.poolFen[publicIndex];

    const keepGame = restoreGame(snap);
    const keepEvents = keepGame.decideSwap(false);
    const keepSettled = eventsOf(keepEvents, 'settled')[0];
    expect(keepSettled.prizeFen).toBe(ownAmount);
    expect(keepSettled.reason).toBe('keep');

    const swapGame = restoreGame(snap);
    const swapEvents = swapGame.decideSwap(true);
    const swapSettled = eventsOf(swapEvents, 'settled')[0];
    expect(swapSettled.prizeFen).toBe(publicAmount);
    expect(swapSettled.reason).toBe('swap');

    if (ownAmount !== publicAmount) {
      expect(keepSettled.prizeFen).not.toBe(swapSettled.prizeFen);
    }
    // 不相加
    expect(keepSettled.prizeFen).not.toBe(ownAmount + publicAmount);
    expect(swapSettled.prizeFen).not.toBe(ownAmount + publicAmount);
    // reveal 事件字段完整
    const reveal = eventsOf(swapEvents, 'reveal')[0];
    expect(reveal.ownAmountFen).toBe(ownAmount);
    expect(reveal.publicAmountFen).toBe(publicAmount);
  });

  it('换牌决策参数必须是布尔值', () => {
    const game = createTestGame('bad-swap-type');
    playToSwapDecision(game);
    expect(() => game.decideSwap('yes' as never)).toThrow(GameRuleError);
    expect(game.getState().status).toBe(GameStatus.SwapDecision); // 状态未被破坏
  });

  it('结算后一切命令抛错（终态）', () => {
    const game = createTestGame('settled-locked');
    playToFirstOffer(game);
    game.respondOffer('deal');
    expect(() => game.pickOwnCard(0)).toThrow(GameRuleError);
    expect(() => game.flipCurrentRound()).toThrow(GameRuleError);
    expect(() => game.flipCardAtPosition(0)).toThrow(GameRuleError);
    expect(() => game.respondOffer('deal')).toThrow(GameRuleError);
    expect(() => game.decideSwap(false)).toThrow(GameRuleError);
    expect(() => game.autoResolve()).toThrow(GameRuleError);
    expect(game.getLegalActions()).toEqual([]);
  });
});

describe('engine：逐张翻牌与本轮配额（3.6.3，M3）', () => {
  it('进入某轮时按配置与钳制赋值 roundFlipsRemaining，快照序列化/反序列化包含该字段', () => {
    const game = createTestGame('quota-init');
    game.pickOwnCard(7);
    const st = game.getState();
    expect(st.roundFlipsRemaining).toBe(6); // 第 1 轮配置 6
    // JSON 往返一致
    expect(JSON.parse(JSON.stringify(st))).toEqual(st);
    const restored = restoreGame(st);
    expect(restored.getState().roundFlipsRemaining).toBe(6);
    // 心跳/报价阶段非翻牌态为 0
    flipRoundByCard(game);
    expect(game.getState().roundFlipsRemaining).toBe(0);
  });

  it('逐张翻：每张 roundFlipsRemaining -1、单元素 cards_flipped；配额耗尽瞬间生成报价且仅一次', () => {
    const game = createTestGame('flip-per-card');
    game.pickOwnCard(0);
    for (let i = 0; i < 6; i++) {
      const events = game.flipCardAtPosition(i + 1);
      const flip = eventsOf(events, 'cards_flipped')[0];
      expect(flip).toMatchObject({ round: 1, positions: [i + 1], amountsFen: [expect.any(Number)] as never });
      const st = game.getState();
      expect(st.roundFlipsRemaining).toBe(5 - i);
      if (i < 5) {
        expect(events).toHaveLength(1); // 未满配额：不发 offer_made，停留 FLIP_ROUND
        expect(st.status).toBe(GameStatus.FlipRound);
      } else {
        expect(events).toHaveLength(2);
        expect(events[1].type).toBe('offer_made'); // 配额耗尽瞬间生成报价
        expect(st.status).toBe(GameStatus.BankerOffer);
        expect(st.currentOffer).not.toBeNull();
        expect(st.counterUsed).toBe(false);
      }
    }
    // 事件日志全量：6 张单翻 + 仅 1 条 offer_made（报价唯一生成点）
    const all = game.getState().events;
    expect(eventsOf(all, 'offer_made')).toHaveLength(1);
    expect(eventsOf(all, 'cards_flipped')).toHaveLength(6);
    // 配额耗尽后再翻 → 状态已转移，抛错
    expect(() => game.flipCardAtPosition(7)).toThrow(GameRuleError);
    expect(game.getState().events.length).toBe(all.length); // 状态未被破坏
  });

  it('牌位越界/非整数/已翻/底牌位置一律抛 GameRuleError 且不产生事件、不耗配额', () => {
    const game = createTestGame('flip-bad-pos');
    game.pickOwnCard(3);
    const before = game.getState().events.length;
    for (const bad of [-1, POOL_SIZE, 2.5, Number.NaN]) {
      expect(() => game.flipCardAtPosition(bad)).toThrow(GameRuleError);
    }
    expect(() => game.flipCardAtPosition(3)).toThrow(GameRuleError); // 底牌位置
    expect(game.getState().events.length).toBe(before);
    expect(game.getState().roundFlipsRemaining).toBe(6);
    expect(game.getState().eliminated.filter(Boolean)).toHaveLength(0);
    game.flipCardAtPosition(0);
    expect(() => game.flipCardAtPosition(0)).toThrow(GameRuleError); // 已翻位置
    expect(game.getState().events.length).toBe(before + 1);
    expect(game.getState().roundFlipsRemaining).toBe(5);
    expect(game.getState().status).toBe(GameStatus.FlipRound);
  });

  it('快照含 roundFlipsRemaining，restore 后半程逐张翻与不断线完全一致', () => {
    const a = createTestGame('restore-flip-mid');
    a.pickOwnCard(5);
    a.flipCardAtPosition(0);
    a.flipCardAtPosition(2);
    const snap = JSON.parse(JSON.stringify(a.getState())) as GameSnapshot;
    expect(snap.roundFlipsRemaining).toBe(4);
    flipRoundByCard(a);
    const b = restoreGame(snap);
    expect(b.getState()).toEqual(snap); // 恢复快照原样（含 roundFlipsRemaining）
    flipRoundByCard(b);
    expect(JSON.stringify(b.getState().events)).toBe(JSON.stringify(a.getState().events));
    expect(b.getState().status).toBe(a.getState().status);
  });

  it('clamp 边界：配额取满 min(configured, 公共牌-1)，翻后公共牌+底牌恰好剩 2，终局路径不受影响', () => {
    // 注：配置校验要求 flip_sequence 之和 ≤ 24，故 quota 恰为「公共牌-1」是本约束下的钳制上界
    const raw = makeTiersRaw();
    raw.common.flip_sequence = [24]; // 首轮即 24 张 → 25 张公共牌翻 24 张
    const game = createGame({
      tierId: 'test',
      seed: 'clamp-round',
      tiersConfig: raw,
      economyConfig: makeEconomyRaw(),
    });
    game.pickOwnCard(1);
    expect(game.getState().roundFlipsRemaining).toBe(24); // min(24 配置, 公共牌 25 - 1)
    let last: GameEvent[] = [];
    for (let p = 0; p < POOL_SIZE; p++) {
      if (p === 1 || game.getState().status !== GameStatus.FlipRound) continue;
      last = game.flipCardAtPosition(p);
    }
    const st = game.getState();
    expect(st.status).toBe(GameStatus.BankerOffer);
    expect(eventsOf(last, 'offer_made')).toHaveLength(1);
    expect(st.eliminated.filter(Boolean)).toHaveLength(24); // 公共牌恰好剩 1 + 底牌 1
    game.respondOffer('noDeal');
    expect(game.getState().status).toBe(GameStatus.FinalOffer); // 剩余 2 张 → 终极报价
  });

  it('超时托管整轮自动路径：翻牌中途接管按牌位升序补齐配额，报价仍只在配额耗尽瞬间生成一次', () => {
    const game = createTestGame('auto-mid-round');
    game.pickOwnCard(2);
    game.flipCardAtPosition(0);
    game.flipCardAtPosition(1);
    expect(game.getState().roundFlipsRemaining).toBe(4);
    const events = game.autoResolve();
    const flips = eventsOf(events, 'cards_flipped');
    // 托管在第一轮补齐剩余 4 张（牌位升序），之后整轮自动走完
    expect(flips.slice(0, 4).map((e) => e.positions[0])).toEqual([3, 4, 5, 6]);
    for (const f of flips) {
      expect(f.positions).toHaveLength(1); // 逐张淘汰
      expect(f.timeout).toBe(true);
    }
    const all = game.getState().events;
    expect(eventsOf(all, 'offer_made')).toHaveLength(10); // 9 轮常规 + 1 终局，每轮报价均仅一次
    expect(game.getState().status).toBe(GameStatus.Settle);
  });
});

describe('engine：超时托管（规则四.5.3、七章.5）', () => {
  it('从 BANKER_OFFER 托管：收敛 SETTLE，后续事件 timeout=true，终局固定保留底牌', () => {
    const game = createTestGame('auto-from-offer');
    playToFirstOffer(game);
    const before = game.getState().events.length;
    const events = game.autoResolve();
    expect(game.getState().status).toBe(GameStatus.Settle);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.timeout).toBe(true);
    for (const e of game.getState().events.slice(0, before)) expect(e.timeout).toBe(false);
    // 固定「保留底牌」：税前奖金 = 底牌金额
    const reveal = eventsOf(events, 'reveal')[0];
    expect(reveal.prizeFen).toBe(reveal.ownAmountFen);
    expect(eventsOf(events, 'swap_decision')[0].swap).toBe(false);
    // 事件链完整（看全量日志）：10 次报价（9 轮常规 + 1 终局）均被拒绝
    const all = game.getState().events;
    expect(eventsOf(events, 'cards_flipped').length).toBeGreaterThan(0);
    expect(eventsOf(events, 'offer_made').length).toBeGreaterThan(0);
    expect(eventsOf(all, 'offer_made')).toHaveLength(10);
    const noDeals = eventsOf(all, 'offer_response').filter((e) => e.action === 'no_deal');
    expect(noDeals).toHaveLength(10);
    expect(eventsOf(events, 'tax_calculated')).toHaveLength(1);
    expect(eventsOf(events, 'settled')).toHaveLength(1);
  });

  it('从 FLIP_ROUND_N / FINAL_OFFER / SWAP_DECISION / PICK_OWN_CARD 托管均收敛 SETTLE', () => {
    // FLIP_ROUND_N
    const g1 = createTestGame('auto-flip');
    g1.pickOwnCard(2);
    g1.autoResolve();
    expect(g1.getState().status).toBe(GameStatus.Settle);
    // FINAL_OFFER
    const g2 = createTestGame('auto-final');
    playToFinalOffer(g2);
    g2.autoResolve();
    expect(g2.getState().status).toBe(GameStatus.Settle);
    expect(eventsOf(g2.getState().events, 'settled')[0].reason).toBe('keep');
    // SWAP_DECISION
    const g3 = createTestGame('auto-swap');
    playToSwapDecision(g3);
    g3.autoResolve();
    expect(g3.getState().status).toBe(GameStatus.Settle);
    // PICK_OWN_CARD（全程托管）
    const g4 = createTestGame('auto-pick');
    const events = g4.autoResolve();
    expect(g4.getState().status).toBe(GameStatus.Settle);
    expect(eventsOf(events, 'own_card_picked')).toHaveLength(1);
    expect(events.every((e) => e.timeout)).toBe(true);
  });

  it('托管与手动全 noDeal 完全等价（托管选 0 号位不额外消耗随机流）', () => {
    const autoGame = createTestGame('auto-eq');
    autoGame.autoResolve();
    const autoEvents = autoGame.getState().events;
    const autoPick = eventsOf(autoEvents, 'own_card_picked')[0].index;
    expect(autoPick).toBe(0);

    const manualGame = createTestGame('auto-eq');
    manualGame.pickOwnCard(0);
    for (let guard = 0; guard < 50; guard++) {
      const status = manualGame.getState().status;
      if (status === GameStatus.FlipRound) manualGame.flipCurrentRound();
      else if (status === GameStatus.BankerOffer || status === GameStatus.FinalOffer)
        manualGame.respondOffer('noDeal');
      else if (status === GameStatus.SwapDecision) manualGame.decideSwap(false);
      else break;
    }
    // 结算完全一致；事件流除 timeout 标记外逐项一致
    expect(manualGame.getState().settlement).toEqual(autoGame.getState().settlement);
    const manualEvents = manualGame.getState().events;
    expect(manualEvents.length).toBe(autoEvents.length);
    const stripTimeout = (e: GameEvent): Record<string, unknown> => {
      const copy: Record<string, unknown> = { ...e };
      delete copy.timeout;
      return copy;
    };
    manualEvents.forEach((e, i) => {
      expect(stripTimeout(autoEvents[i])).toEqual(stripTimeout(e));
    });
  });

  it('同 seed 托管两次：事件流逐字节一致（可复现）', () => {
    const a = createTestGame('auto-repro');
    const b = createTestGame('auto-repro');
    a.autoResolve();
    b.autoResolve();
    expect(JSON.stringify(a.getState().events)).toBe(JSON.stringify(b.getState().events));
  });
});

describe('engine：可复现与可恢复（规则四.5.2、七章.3）', () => {
  it('同 seed 同操作序列 → 全流程逐事件一致', () => {
    const script = (g: GameEngine) => {
      g.pickOwnCard(11);
      g.flipCurrentRound();
      g.respondOffer('noDeal');
      g.flipCurrentRound();
      const ev = currentEv(g.getState());
      g.respondOffer({ counter: Math.ceil(ev * 0.9) }); // 中间分支，消耗随机流
      const st = g.getState().status;
      if (st === GameStatus.BankerOffer) g.respondOffer('noDeal');
      g.autoResolve();
    };
    const a = createTestGame('repro-1');
    const b = createTestGame('repro-1');
    script(a);
    script(b);
    expect(JSON.stringify(a.getState())).toBe(JSON.stringify(b.getState()));
  });

  it('异 seed → 卡池不同', () => {
    const a = createTestGame('seed-x').getState().poolFen;
    const b = createTestGame('seed-y').getState().poolFen;
    expect(a).not.toEqual(b);
  });

  it('getState 可 JSON 序列化且往返一致', () => {
    const game = createTestGame('snapshot-json');
    playToFirstOffer(game);
    const snap = game.getState();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it('restore 后继续游玩与不中断完全一致（随机流断点续接）', () => {
    const a = createTestGame('restore-flow');
    a.pickOwnCard(5);
    a.flipCurrentRound();
    const snap = JSON.parse(JSON.stringify(a.getState())) as GameSnapshot;
    // a 继续：还价（中间分支）→ 视结果继续 → 托管收尾
    const evA = currentEv(a.getState());
    a.respondOffer({ counter: Math.ceil(evA * 0.9) });
    if (a.getState().status === GameStatus.BankerOffer) a.respondOffer('noDeal');
    a.autoResolve();

    const b = restoreGame(snap);
    expect(b.getState()).toEqual(snap); // 恢复快照原样
    const evB = currentEv(b.getState());
    b.respondOffer({ counter: Math.ceil(evB * 0.9) });
    if (b.getState().status === GameStatus.BankerOffer) b.respondOffer('noDeal');
    b.autoResolve();
    expect(JSON.stringify(b.getState().events)).toBe(JSON.stringify(a.getState().events));
    expect(b.getState().settlement).toEqual(a.getState().settlement);
  });

  it('restore 拒绝坏快照', () => {
    const game = createTestGame('bad-snap');
    playToFirstOffer(game);
    const snap = JSON.parse(JSON.stringify(game.getState())) as GameSnapshot;
    expect(() => restoreGame({ ...snap, version: 2 } as never)).toThrow(GameRuleError);
    expect(() => restoreGame({ ...snap, status: 'NOPE' } as never)).toThrow(GameRuleError);
    expect(() => restoreGame({ ...snap, poolFen: [1, 2, 3] } as never)).toThrow(GameRuleError);
    expect(() => restoreGame({ ...snap, eliminated: [] } as never)).toThrow(GameRuleError);
    expect(() => restoreGame(null as never)).toThrow(GameRuleError);
    expect(() => restoreGame({ ...snap, seed: 42 } as never)).toThrow(GameRuleError);
    expect(() => restoreGame({ ...snap, events: null } as never)).toThrow(GameRuleError);
  });
});

describe('engine：报价性质全量断言（附录 A：报价 ≤ EV 且 ≤ 档位上限、非负）', () => {
  it('多 seed 托管全程校验每个报价与税事件', () => {
    for (const seed of ['prop-1', 'prop-2', 'prop-3', 'prop-4', 'prop-5']) {
      const game = createTestGame(seed);
      game.autoResolve();
      const state = game.getState();
      const offers = eventsOf(state.events, 'offer_made');
      expect(offers.length).toBe(10); // 9 轮常规报价 + 1 次终局报价
      const kRangeByPhase = state.common.kRanges;
      for (const o of offers) {
        expect(o.offerFen).toBeGreaterThanOrEqual(0);
        expect(o.offerFen).toBeLessThanOrEqual(o.evFen);
        expect(o.offerFen).toBeLessThanOrEqual(state.tier.maxPrizeFen);
        const range = kRangeByPhase[o.phase];
        expect(o.k).toBeGreaterThanOrEqual(range.min);
        expect(o.k).toBeLessThanOrEqual(range.max);
        // 阶段映射：1-2 前期、3-4 中期、5+ 与终局 = 终局
        if (o.isFinal) expect(o.phase).toBe('final');
        else if (o.round! <= 2) expect(o.phase).toBe('early');
        else if (o.round! <= 4) expect(o.phase).toBe('mid');
        else expect(o.phase).toBe('final');
      }
      // 翻牌节奏
      const flips = eventsOf(state.events, 'cards_flipped');
      const byRound = new Map<number, number>();
      for (const e of flips) byRound.set(e.round, (byRound.get(e.round) ?? 0) + e.positions.length);
      expect(byRound.get(0)).toBeUndefined();
      expect(
        [...byRound.keys()].sort((a, b) => a - b).map((r) => byRound.get(r)),
      ).toEqual([6, 5, 4, 3, 2, 1, 1, 1, 1]);
      // 税事件与 calcTaxFen 完全一致
      const taxEvent = eventsOf(state.events, 'tax_calculated')[0];
      expect(taxEvent.taxFen).toBe(calcTaxFen(taxEvent.profitFen, state.tax).taxFen);
      expect(taxEvent.taxableFen).toBe(calcTaxFen(taxEvent.profitFen, state.tax).taxableFen);
    }
  });

  it('getLegalActions 随状态变化', () => {
    const game = createTestGame('legal-actions');
    expect(game.getLegalActions()).toEqual(['pick_own_card', 'auto_resolve']);
    game.pickOwnCard(1);
    expect(game.getLegalActions()).toEqual(['flip', 'auto_resolve']);
    game.flipCurrentRound();
    expect(game.getLegalActions()).toEqual(['deal', 'no_deal', 'counter', 'auto_resolve']);
    // 还价后（必拒分支）counter 消失
    game.respondOffer({ counter: game.getState().tier.maxPrizeFen });
    expect(game.getLegalActions()).toEqual(['deal', 'no_deal', 'auto_resolve']);
    game.respondOffer('noDeal');
    expect(game.getLegalActions()).toEqual(['flip', 'auto_resolve']);
  });
});
