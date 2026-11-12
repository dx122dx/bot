// botLifecycle.ts —— bot 生命周期：统一销毁入口（幂等）+ 建连句柄登记（供建连被取消时中止）
import { ts } from './logger.js';
import type { Bot } from 'mineflayer';

// minecraft-protocol Client 的内部字段（其类型未导出 ended/socket 的可写视图）
interface ClientInternals {
    ended?: boolean;
    socket?: { destroyed?: boolean; destroy(): void };
}

// bot.end() 只是 socket.end() + 30 秒后再 destroy；网络异常时连接可能长期半开，
// 用更短的兜底延时强制销毁 socket
const CLOSE_FALLBACK_MS = 1000;

// 已销毁的 bot：状态机 entry、事件回调、shutdown、控制台指令都会调用 destroyBot，
// 用 weak 引用去重，避免重复 end（会重复挂兜底定时器）
const destroyedBots = new WeakSet<Bot>();

/**
 * 统一销毁 bot：幂等，可在任意断开路径上重复调用
 */
export function destroyBot(bot: Bot | null | undefined, reason: string): void {
    if (!bot || destroyedBots.has(bot)) return;
    destroyedBots.add(bot);

    const client = bot._client as unknown as ClientInternals | undefined;
    // ended 为 true 且已有 socket 表示 socket 已关闭；此时再调 bot.end() 会重复挂一个
    // 30 秒的 socket.destroy 兜底定时器（未 unref），故跳过
    const clientClosed = client?.ended === true && !!client.socket;
    if (!clientClosed) {
        try {
            bot.end(reason);
        } catch (err) {
            console.error(`${ts()}❌ 关闭 bot 失败:`, err instanceof Error ? err.message : err);
        }
    }

    const socket = client?.socket;
    if (socket && !socket.destroyed) {
        setTimeout(() => {
            if (!socket.destroyed) socket.destroy();
        }, CLOSE_FALLBACK_MS).unref();
    }
}

/**
 * 建连句柄：connect 层每次建连登记一个，状态机取消建连时用它中止
 * settled 为 true 表示本次建连已结算，或已被中止（结果无人等待）
 */
export interface ConnectHandle {
    bot: Bot | null;
    settled: boolean;
}

let pendingConnect: ConnectHandle | null = null;

/**
 * 登记进行中的建连。状态机 invoke 串行，后一次建连开始前前一次必已结算或被中止，
 * 故只需保留最近一个句柄
 */
export function trackConnect(handle: ConnectHandle): void {
    pendingConnect = handle;
}

/**
 * 中止进行中的建连：状态机离开 connecting 时 invoke 的结果被丢弃，该 Promise 不会再结算，
 * 已创建的 bot 若不主动关闭，会带着连接在后台空转并占住服务器会话
 */
export function abortPendingConnect(reason: string): void {
    const handle = pendingConnect;
    if (!handle || handle.settled) return;
    handle.settled = true; // 先置位：中止触发的 end 事件回调不应再结算（Promise 已无人等待）
    if (handle.bot) {
        destroyBot(handle.bot, reason);
    }
}
