// autoEat.ts —— 自动进食模块：health 事件监听管理
import { ts } from './logger.js';
import { getConfig } from './config.js';
import { state } from './state.js';
import type { Bot } from 'mineflayer';

let autoEatHealthHandler: (() => void) | null = null; // autoEat 的 health 事件处理器（spawn 时注册、bot end 时移除）

export function startAutoEatPolling(): void {
    const bot = state.bot;
    const CONFIG = getConfig();
    if (!bot || !bot.autoEat) {
        console.error(`${ts()}❌ autoEat 插件未加载，无法启用自动进食。`);
        return;
    }
    // 设置选项（不使用内部监听，但保留配置）
    // EatUtil 官方类型仅声明 opts，运行时的 options 属性通过断言访问
    const eatUtil = bot.autoEat as unknown as {
        options: {
            startAt: number;
            priority: string;
            bannedFood: string[];
            eatingTimeout: number;
        };
    };
    eatUtil.options = {
        startAt: CONFIG.autoEat.hungerThreshold,
        priority: 'foodPoints',
        bannedFood: CONFIG.autoEat.bannedFood || [],
        eatingTimeout: 3,
    };
    console.log(`${ts()}✅ 自动进食已启用（事件监听，饥饿阈值: ${CONFIG.autoEat.hungerThreshold}）`);
    if (CONFIG.autoEat.bannedFood && CONFIG.autoEat.bannedFood.length) {
        console.log(`${ts()}ℹ️ 已禁止食物: ${CONFIG.autoEat.bannedFood.join(', ')}`);
    }

    // 移除旧的监听（防止重复注册）
    stopAutoEatPolling();

    // 监听 health 事件（mineflayer 无 food 事件，health.js 在收到 update_health 包时触发 health）
    // 每次健康/饥饿更新时检查饥饿值，将状态桥接进子状态机（online.idle/performing）：
    //   低于阈值 → HUNGER_LOW（performing 的 entry 执行进食）
    //   恢复     → HUNGER_OK（回到 idle）
    // 非 online 状态（离线/认证/重试等）下发送的事件会被状态机忽略，无副作用
    autoEatHealthHandler = () => {
        const b = state.bot;
        if (!b || !b.entity) {
            return; // 不在线，忽略
        }
        if (b.food === undefined) {
            return; // 饥饿值尚未同步
        }
        if (b.food < CONFIG.autoEat.hungerThreshold) {
            state.actor?.send({ type: 'HUNGER_LOW' });
        } else {
            state.actor?.send({ type: 'HUNGER_OK' });
        }
    };
    bot.on('health', autoEatHealthHandler);
}

export function stopAutoEatPolling(targetBot: Bot | null = null): void {
    const target = targetBot || state.bot;
    if (target && target.off && autoEatHealthHandler) {
        target.off('health', autoEatHealthHandler);
        autoEatHealthHandler = null;
        console.log(`${ts()}ℹ️ 自动进食事件监听已停止。`);
    }
}
