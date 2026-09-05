// botMachine.ts —— XState v5 状态机
// 替代旧 bot.js 中自建 FSM（OFFLINE/AUTHENTICATING/CONNECTING/ONLINE/RETRY/WAITING + 1s tick 主循环）。
// 状态迁移与原 FSM 行为等价，但完全事件驱动：
//   - invoke 托管认证/建连异步服务（离开状态时自动取消进行中的服务，天然解决竞态）
//   - after 延迟迁移替代 retry/waiting 的倒计时轮询
//   - guards 判断重试次数是否达到上限
//   - CONNECT / MANUAL_DISCONNECT 在全部状态可用（等价于原 !connect / !disconnect 任意状态可触发）
//
// 接口约定（deps）：
//   config:          CONFIG 对象（读取 autoReconnect.{retryDelayMs,maxRetryCount,rejoinDelay}）
//   authService:     () => Promise<authData>            认证服务（resolve 认证数据 / reject 失败）
//   connectService:  ({ authData }) => Promise<bot>     建连服务（resolve bot / reject 失败/超时）
//
// 状态机事件：
//   CONNECT            手动连接（任意状态触发，进行中的认证/建连会被自动取消）
//   AUTH_SUCCESS       由 invoke onDone 内部产生，等价旧 FSM 认证成功 → connecting
//   AUTH_ERROR         由 invoke onError 内部产生，等价旧 FSM 认证失败 → retry
//   CONNECT_SUCCESS    由 invoke onDone 内部产生，等价旧 FSM 连接成功 → online
//   CONNECT_ERROR      由 invoke onError 内部产生，等价旧 FSM 连接失败 → retry
//   DISCONNECT         意外断线（仅 online 生效，其余状态被忽略）
//   YIELD              让位退出（仅 online 生效 → waiting，并执行 bot.end('让位退出')）
//   MANUAL_DISCONNECT  手动断开（任意状态 → offline）
import { setup, assign, fromPromise } from 'xstate';
import type { Bot } from 'mineflayer';
import { ts } from './logger.js';
import type { BotConfig } from './config.js';

// 认证数据（yggdrasil 响应结构；auth.ts 返回、connect.ts 消费）
export interface AuthData {
    accessToken: string;
    clientToken: string;
    selectedProfile: {
        id: string;
        name: string;
    };
    [key: string]: unknown;
}

// 状态机 context
export interface BotMachineContext {
    authData: AuthData | null; // 认证数据（selectedProfile/accessToken 等）
    bot: Bot | null; // 当前 mineflayer bot 实例
    retryCount: number; // 已执行的重试次数
}

// 外部可发送事件（invoke onDone/onError 产生的事件由 xstate 自动推断）
export type BotMachineEvent =
    | { type: 'CONNECT' }
    | { type: 'MANUAL_DISCONNECT' }
    | { type: 'DISCONNECT' }
    | { type: 'YIELD' }
    // health 事件桥接（autoEat.ts 的 health 监听发送）：饥饿低于阈值 → performing；恢复 → idle
    | { type: 'HUNGER_LOW' }
    | { type: 'HUNGER_OK' };

export interface BotMachineDeps {
    config: BotConfig;
    authService: () => Promise<AuthData>;
    connectService: (input: { authData: AuthData }) => Promise<Bot>;
}

/**
 * 创建 bot 状态机
 */
export function createBotMachine(deps: BotMachineDeps) {
    const config = deps.config;

    return setup({
        types: {
            context: {} as BotMachineContext,
            events: {} as BotMachineEvent,
        },
        // v5 中 invoke 的异步服务注册于 actors（取代 v4 的 services）
        actors: {
            authService: fromPromise(() => deps.authService()),
            connectService: fromPromise(({ input }: { input: { authData: AuthData } }) => deps.connectService(input)),
        },
        guards: {
            // 重试上限判断：retryCount 为已执行的重试次数，未达上限继续快速重试
            canRetry: ({ context }) => context.retryCount < config.autoReconnect.maxRetryCount,
        },
        delays: {
            // 延迟值在创建机器时从 CONFIG 读入；!reload 后不自动更新（与 task.md 注意事项一致）
            RETRY_DELAY: () => config.autoReconnect.retryDelayMs,
            REJOIN_DELAY: () => config.autoReconnect.rejoinDelay,
        },
        actions: {
            // 让位退出：等价原 messagestr 命中后的 bot.end('让位退出')
            yieldBot: ({ context }) => {
                if (context.bot) {
                    context.bot.end('让位退出');
                }
            },
            // 自动进食（简单任务落地）：online.performing 的 entry 动作，
            // 由 health 桥接事件 HUNGER_LOW 触发，配置经 config.autoEat 读取
            autoEatNow: ({ context }) => {
                const bot = context.bot;
                if (!bot || !bot.autoEat || !config.autoEat.enabled) return;
                bot.autoEat.eat().catch((err) => {
                    console.error(`${ts()}❌ 自动进食失败:`, err instanceof Error ? err.message : err);
                });
            },
        },
    }).createMachine({
        id: 'botMachine',
        initial: 'offline',
        context: {
            authData: null,
            bot: null,
            retryCount: 0,
        },
        states: {
            offline: {
                on: {
                    CONNECT: 'authenticating',
                },
            },

            authenticating: {
                invoke: {
                    src: 'authService',
                    onDone: {
                        target: 'connecting',
                        actions: assign({ authData: ({ event }) => event.output }),
                    },
                    onError: 'retry',
                },
                on: {
                    // 自迁移重新认证：reenter: true 强制外部迁移（exit 取消进行中的 authService → 重新 invoke）
                    // 注意：v5 中字符串形式的自迁移是 internal transition，不会取消/重启 invoke，必须显式 reenter
                    CONNECT: { target: 'authenticating', reenter: true },
                    MANUAL_DISCONNECT: 'offline',
                },
            },

            connecting: {
                invoke: {
                    src: 'connectService',
                    // authData 进入 connecting 前必已被 onDone assign（非 null），! 断言与旧 JS 直接传递行为一致
                    input: ({ context }) => ({ authData: context.authData! }),
                    onDone: {
                        target: 'online',
                        actions: assign({
                            bot: ({ event }) => event.output,
                            retryCount: 0, // 连接成功，重置快速重试计数
                        }),
                    },
                    onError: 'retry',
                },
                on: {
                    // 立即重连：等价原 CONNECTING 状态按 !connect → 重新认证
                    CONNECT: 'authenticating',
                    MANUAL_DISCONNECT: 'offline',
                },
            },

            // online 复合状态：内嵌嵌套子状态（idle/performing）承载简单任务（autoEat），
            // 共享主机器 context；health 事件桥接 HUNGER_LOW/HUNGER_OK 驱动子状态迁移
            online: {
                initial: 'idle',
                entry: assign({ retryCount: 0 }),
                states: {
                    idle: {
                        on: {
                            HUNGER_LOW: 'performing', // 饥饿低于阈值 → 进入执行任务
                        },
                    },
                    performing: {
                        entry: 'autoEatNow', // 执行自动进食；重复 HUNGER_LOW 为 internal 迁移，不会重复触发 entry
                        on: {
                            HUNGER_OK: 'idle', // 饥饿恢复 → 回到空闲
                        },
                    },
                },
                on: {
                    DISCONNECT: 'retry', // 意外断线 → 快速重试
                    YIELD: { target: 'waiting', actions: 'yieldBot' }, // 让位退出 → 长等待
                    CONNECT: 'authenticating',
                    MANUAL_DISCONNECT: 'offline',
                },
            },

            retry: {
                after: {
                    RETRY_DELAY: [
                        {
                            target: 'authenticating',
                            guard: 'canRetry',
                            actions: assign({ retryCount: ({ context }) => context.retryCount + 1 }),
                        },
                        { target: 'waiting' }, // 达到重试上限 → 长等待
                    ],
                },
                on: {
                    CONNECT: 'authenticating',
                    MANUAL_DISCONNECT: 'offline',
                },
            },

            waiting: {
                entry: assign({ retryCount: 0 }), // 长等待后重新开始快速重试计数
                after: {
                    REJOIN_DELAY: 'authenticating',
                },
                on: {
                    CONNECT: 'authenticating',
                    MANUAL_DISCONNECT: 'offline',
                },
            },
        },
    });
}
