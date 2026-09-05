// autoEat.ts —— 自动进食模块：health 事件监听管理
import { ts } from './logger.js';
import { getConfig } from './config.js';
import { state } from './state.js';
import type { Bot } from 'mineflayer';

// health 监听绑定：handler 必须与「注册它的 bot」一并记录。
// 旧 bot 的 socket 在网络异常下可能延迟到新 bot 进服后才触发 end，
// 若只存 handler 指针，旧 bot 的 stop 调用会误清新 bot 的监听（并置空指针使新 bot 的监听再也无法卸载）。
interface AutoEatBinding {
    bot: Bot;
    handler: () => void;
}
let autoEatHealthBinding: AutoEatBinding | null = null; // autoEat 的 health 监听绑定（spawn 时注册、bot end 时移除）

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

    // 移除旧的监听（防止重复注册）：无条件卸载上一次绑定，无论它挂在旧 bot 还是新 bot 上
    clearBinding();

    // 监听 health 事件（mineflayer 无 food 事件，health.js 在收到 update_health 包时触发 health）
    // 每次健康/饥饿更新时检查饥饿值，将状态桥接进子状态机（online.idle/performing）：
    //   低于阈值 → HUNGER_LOW（performing 的 entry 执行进食）
    //   恢复     → HUNGER_OK（回到 idle）
    // 非 online 状态（离线/认证/重试等）下发送的事件会被状态机忽略，无副作用
    const binding: AutoEatBinding = {
        bot,
        handler: () => {
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
        }
    };
    autoEatHealthBinding = binding;
    bot.on('health', binding.handler);
}

export function stopAutoEatPolling(targetBot: Bot | null = null): void {
    if (!autoEatHealthBinding) return;
    const target = targetBot || state.bot;
    // 归属校验：仅当目标就是「注册监听的那个 bot」时才卸载。
    // 传入旧 bot（其 end 可能延迟到新 bot 进服后才触发）时直接返回，避免误清新 bot 的监听。
    if (!target || target !== autoEatHealthBinding.bot) return;
    clearBinding();
}

// 模块内私有：无条件卸载当前绑定（供 startAutoEatPolling 注册前清理上一次监听）
function clearBinding(): void {
    if (!autoEatHealthBinding) return;
    const { bot, handler } = autoEatHealthBinding;
    autoEatHealthBinding = null;
    if (bot.off) bot.off('health', handler);
    console.log(`${ts()}ℹ️ 自动进食事件监听已停止。`);
}
