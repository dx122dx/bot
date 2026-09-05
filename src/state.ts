// state.ts —— 跨模块共享的可变状态
// 拆分 bot.js 后，原先的顶层全局变量（bot/actor/eta* 等）集中于此，
// 避免模块间循环依赖（commands 需要 shutdown/actor/bot，connect 需要 actor/bot 等）。
import type { Bot } from 'mineflayer';
import type { Actor } from 'xstate';
import type { createBotMachine } from './botMachine.js';

export type MachineActor = Actor<ReturnType<typeof createBotMachine>>;
export type MachineSnapshot = ReturnType<MachineActor['getSnapshot']>;
export type MachineValue = MachineSnapshot['value'];
export type MachineContext = MachineSnapshot['context'];

export interface SharedState {
    bot: Bot | null; // 当前 mineflayer bot 实例（仅 online 状态的有效引用）
    actor: MachineActor | null; // XState actor（index.js 创建后赋值）
    etaState: 'retry' | 'waiting' | null; // 当前倒计时所属状态
    etaEnteredAt: number; // 进入该状态的毫秒时间戳（用于计算 ETA 剩余秒数）
    shutdown: ((reason?: string) => void) | null; // 由 index.js 注入（commands 的 !quit 调用）
}

export const state: SharedState = {
    bot: null,
    actor: null,
    etaState: null,
    etaEnteredAt: 0,
    shutdown: null,
};
