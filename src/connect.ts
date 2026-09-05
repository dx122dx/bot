// connect.ts —— 连接模块：创建 bot（Promise 服务）+ 自定义加密协商接入 + 聊天转发 + 断线事件桥接
import * as mineflayer from 'mineflayer';
import { loader as autoEatLoader } from 'mineflayer-auto-eat';
import crypto from 'crypto';
import { ts } from './logger.js';
import { getConfig } from './config.js';
import { state } from './state.js';
import { handleCustomJoin } from './auth.js';
import { startAutoEatPolling, stopAutoEatPolling } from './autoEat.js';
import { installInteractions } from './interact.js';
import type { Bot } from 'mineflayer';
import type { Client, ClientOptions } from 'minecraft-protocol';
import type { ChatMessage } from 'prismarine-chat';
import type { AuthData } from './botMachine.js';
import type { EncryptionBeginPacket } from './auth.js';

const POSITION_LABELS: Record<string, string> = { chat: '💬', system: '⚙️', game_info: 'ℹ️' };

function parseChatParts(message: string): { sender: string | null; content: string } {
    let m = message.match(/^<([^>]+)>\s*(.*)$/);
    if (m) return { sender: m[1].trim(), content: m[2].trim() };
    m = message.match(/^(.+?)\s*[:：]\s*(.*)$/);
    if (m) return { sender: m[1].trim(), content: m[2].trim() };
    m = message.match(/^(.+?)\s*[>»]\s*(.*)$/);
    if (m) return { sender: m[1].trim(), content: m[2].trim() };
    return { sender: null, content: message };
}

// 连接结果回调：转发为状态机事件（XState 自动忽略当前状态未配置的事件）
export function onBotDisconnect(sourceBot: Bot | null): void {
    if (!sourceBot) return; // 旧 bot 残留事件忽略
    if (!state.actor) return;
    const current = state.actor.getSnapshot().value;
    if (current === 'connecting') return; // 建连阶段失败由 invoke onError 处理 → retry
    state.actor.send({ type: 'DISCONNECT' }); // online 意外断线 → retry；其余状态无迁移被忽略
}

// 创建机器人（Promise 服务：spawn resolve | end/error/超时 reject）
export function createBotWithToken(authData: AuthData): Promise<Bot> {
    const CONFIG = getConfig(); // 每次连接取最新配置（!reload 后新连接生效）
    return new Promise<Bot>((resolve, reject) => {
        let settled = false; // 防止重复 resolve/reject
        let connectTimeout: NodeJS.Timeout | null = null;
        let bot: Bot | null = null;
        try {
            if (state.bot) {
                state.bot.end(); // 手动重连/新会话：断开旧 bot（end 事件在非 online 状态被忽略）
                state.bot = null;
            }

            console.log(`${ts()}⏳ 正在连接服务器...`);

            bot = state.bot = mineflayer.createBot({
                host: CONFIG.server.host,
                port: CONFIG.server.port,
                version: CONFIG.server.version,
                username: authData.selectedProfile.name,
                // 关闭 mineflayer loader 默认注册的 bot.on('error', err => console.log(err))，
                // 否则每个连接错误会打印两次（一次无时间戳的裸打印 + 一次我们带 ts() 前缀的）
                logErrors: false,
                auth: (client: Client, options: ClientOptions) => {
                    client.username = authData.selectedProfile.name;
                    client.uuid = authData.selectedProfile.id;
                    client.accessToken = authData.accessToken;
                    client.clientToken = authData.clientToken;

                    client.session = {
                        accessToken: authData.accessToken,
                        clientToken: authData.clientToken,
                        username: authData.selectedProfile.name,
                        uuid: authData.selectedProfile.id,
                        selectedProfile: {
                            id: authData.selectedProfile.id,
                            name: authData.selectedProfile.name
                        }
                    };
                    options.accessToken = authData.accessToken;
                    options.connect!(client);
                }
            });

            connectTimeout = setTimeout(() => {
                if (bot && !bot.entity) {
                    console.error(`${ts()}❌ 连接超时（10 秒内未能进入服务器），正在断开...`);
                    try {
                        if (bot._client && bot._client.socket) {
                            bot._client.socket.destroy();
                        } else {
                            bot.end('连接超时');
                        }
                    } catch (e) {
                        console.error(`${ts()}❌ 断开失败:`, e);
                    }
                }
            }, 10000);

            const mcClient = bot._client;
            // 移除 minecraft-protocol 默认注册的 encryption_begin 处理器（走 yggdrasil session server join 流程），
            // 替换为自定义 handleCustomJoin（自定义 authServer 不走 Mojang session server）。
            // 注意：此移除是刻意的，若删除会与默认处理器同时触发、双重加密响应，导致建连失败。
            mcClient.removeAllListeners('encryption_begin');
            mcClient.once('encryption_begin', (packet: EncryptionBeginPacket) => {
                crypto.randomBytes(16, (err, sharedSecret) => {
                    if (err) {
                        mcClient.emit('error', err);
                        mcClient.end('encryptionSecretError');
                        return;
                    }
                    handleCustomJoin(packet, sharedSecret, mcClient);
                });
            });

            try {
                bot.loadPlugin(autoEatLoader);
            } catch (err) {
                console.error(`${ts()}❌ 自动进食插件加载失败:`, err);
            }

            try {
                installInteractions(bot);
            } catch (err) {
                console.error(`${ts()}❌ 交互模块初始化失败:`, err);
            }

            bot.on('login', () => {
                if (CONFIG.server.language) {
                    bot!.setSettings({ locale: CONFIG.server.language }); // login 触发时 bot 必非 null
                    console.log(`${ts()}🌐 已设置语言: ${CONFIG.server.language}`);
                }
            });

            bot.once('spawn', () => {
                console.log(`${ts()}✅ 进入服务器!`);
                if (connectTimeout) clearTimeout(connectTimeout);

                if (CONFIG.autoEat.enabled) {
                    startAutoEatPolling();
                }

                const autoCommands = CONFIG.behavior.autoCommands;
                if (autoCommands && autoCommands.length) {
                    setTimeout(() => {
                        const b = bot; // const 收窄在 setTimeout 闭包内保持
                        if (b && b.entity) {
                            autoCommands.forEach(cmd => {
                                console.log(`${ts()}⌨️ 执行命令: ${cmd}`);
                                b.chat(cmd);
                            });
                        }
                    }, 1000);
                }

                if (!settled) {
                    settled = true;
                    resolve(bot!); // spawn 成功 → resolve 建连 Promise（spawn 时 bot 必非 null），驱动状态机进入 online
                }
            });

            bot.on('message', (msg: ChatMessage, position: string) => {
                const text = process.stdout.isTTY ? msg.toAnsi() : msg.toString();
                console.log(`${ts()}${POSITION_LABELS[position] || '💬'} ${text}`);
            });

            bot.on('messagestr', (message: string) => {
                const { sender, content } = parseChatParts(message);
                const players = CONFIG.autoReconnect.triggerPlayers || [];
                const senderMatched = !!sender && players.some(name =>
                    sender === name || sender.startsWith(name + '(') || sender.startsWith(name + '[')
                );
                const contentLower = content.toLowerCase();
                const keywordMatched = CONFIG.autoReconnect.triggerKeywords.some(keyword =>
                    contentLower.includes(keyword.toLowerCase())
                );
                const shouldExit = senderMatched && keywordMatched;
                if (shouldExit && CONFIG.autoReconnect.enabled && state.actor && state.actor.getSnapshot().matches('online')) {
                    console.log(`${ts()}⚠️ 检测到 ${sender} 的让位消息（内容含关键词），准备退服让位...`);
                    // YIELD → waiting；waiting 入口不结束 bot，由机器的 yieldBot action 立即执行 bot.end('让位退出')
                    state.actor.send({ type: 'YIELD' });
                }
            });

            bot.on('kicked', function (this: Bot, reason: string) {
                console.log(`${ts()}⚠️ 被踢出: ${reason}`);
                const wasCurrent = (bot === this); // 本次建连的 Promise 归属（连接 Promise 属于具体那次建连）
                // 身份守卫：只有当前活跃 bot 才允许触发状态机事件。
                // 旧 bot 的 socket 在网络异常下可能延迟到新 bot 进服后才触发事件，
                // 若无此守卫会把 online 打回 retry 并让新会话变成无人引用的幽灵。
                const isActive = (state.bot === this);
                if (wasCurrent && !settled) {
                    settled = true;
                    reject(new Error('被踢出: ' + reason));
                }
                if (isActive) onBotDisconnect(this);
            });

            bot.on('error', function (this: Bot, err: Error) {
                console.error(`${ts()}❌ 连接错误:`, err);
                if (err.message && err.message.includes('Invalid session')) {
                    console.error(`${ts()}⚠️ Token 无效，尝试重新认证...`);
                }
                const wasCurrent = (bot === this); // 本次建连的 Promise 归属
                const isActive = (state.bot === this); // 身份守卫：仅当前活跃 bot 才允许驱动状态机
                if (wasCurrent && !settled) {
                    settled = true;
                    reject(err);
                }
                if (isActive) onBotDisconnect(this);
            });

            bot.on('end', function (this: Bot) {
                console.log(`${ts()}ℹ️ 连接已结束。`);
                stopAutoEatPolling(this); // bot 断开时移除 health 监听（内部按归属校验，不会误清新 bot 的监听）
                const wasCurrent = (bot === this); // 本次建连的 Promise 归属
                const isActive = (state.bot === this); // 身份守卫：仅当前活跃 bot 才允许清理共享引用与驱动状态机
                if (wasCurrent) {
                    bot = null;
                }
                if (wasCurrent && !settled) {
                    settled = true;
                    reject(new Error('连接结束'));
                }
                if (isActive) {
                    // 先发事件再清引用：onBotDisconnect 依赖调用时刻的共享状态，
                    // 静默断线（无 error/kicked、只有 end）时若先清引用会丢掉重连触发
                    onBotDisconnect(this);
                    state.bot = null;
                }
            });
        } catch (error) {
            console.error(`${ts()}❌ createBotWithToken 内部错误:`, (error as Error).stack || error);
            if (!settled) {
                settled = true;
                reject(error);
            }
        }
    });
}
