// commands.ts —— 控制台交互与本地指令：initConsole / handleLocalCommand / !status 分级 / !inventory / !eval / !help
import vm from 'vm';
import { createRequire } from 'module';
import type readline from 'readline';
import { ts } from './logger.js';
import { getConfig, reloadConfig } from './config.js';
import { state, type MachineActor, type MachineSnapshot, type MachineValue } from './state.js';
import { showView, stopView } from './view.js';
import { enableLiveView, disableLiveView } from './viewer-server/live-view.js';
import type { Bot } from 'mineflayer';

// ESM 下无全局 require，用 createRequire 提供（!eval 沙箱注入 require）
const require = createRequire(import.meta.url);

let rl: readline.Interface | null = null; // readline 实例（initConsole 时注入）

// ---------- !status 分级展示 ----------
const STATE_LABELS: Record<string, string> = {
    offline: '离线',
    authenticating: '正在认证',
    connecting: '正在连接',
    online: '在线',
    retry: '快速重试',
    waiting: '等待重连',
};

// online 复合状态的嵌套子状态标签（nested-submachine）
const SUB_STATE_LABELS: Record<string, string> = {
    idle: '空闲',
    performing: '执行任务',
};

// 状态值可能是字符串（顶层状态）或对象（复合状态如 { online: 'idle' }）
function getStatusLabel(v: MachineValue | null): string {
    if (!v) return '未初始化';
    if (typeof v === 'string') {
        return STATE_LABELS[v] || v;
    }
    const top = Object.keys(v)[0];
    const sub = v[top as keyof typeof v];
    if (typeof sub === 'string') {
        return `${STATE_LABELS[top] || top}（${SUB_STATE_LABELS[sub] || sub}）`;
    }
    return STATE_LABELS[top] || top;
}

// 当前是否处于 retry/waiting 倒计时状态及剩余秒数（非倒计时状态返回 null）
function getEtaRemaining(v: MachineValue | null): number | null {
    const CONFIG = getConfig();
    if (v === 'retry') {
        return Math.max(0, Math.ceil((CONFIG.autoReconnect.retryDelayMs - (Date.now() - state.etaEnteredAt)) / 1000));
    }
    if (v === 'waiting') {
        return Math.max(0, Math.ceil((CONFIG.autoReconnect.rejoinDelay - (Date.now() - state.etaEnteredAt)) / 1000));
    }
    return null;
}

// 从 snapshot 提取在线 bot（仅 online 状态的 context.bot 有效，避免残留引用；online 现为复合状态）
function getOnlineBot(snapshot: MachineSnapshot | null): Bot | null {
    return snapshot && snapshot.matches('online') ? (snapshot.context.bot || null) : null;
}

// 完整玩家详情（仅在线时调用）
function printPlayerDetail(cur: Bot): void {
    const pos = cur.entity.position;
    const health = cur.health !== undefined ? cur.health : '未知';
    const food = cur.food !== undefined ? cur.food : '未知';
    const saturation = cur.foodSaturation !== undefined ? cur.foodSaturation.toFixed(1) : '未知';
    const level = cur.experience && cur.experience.level !== undefined ? cur.experience.level : '未知';
    const gameMode = cur.game && cur.game.gameMode ? cur.game.gameMode : '未知';
    const dimension = cur.game && cur.game.dimension ? cur.game.dimension : '未知';
    const world = cur.game && cur.game.world ? cur.game.world : '未知';

    console.log(`${ts()}📊 玩家状态`);
    console.log(`  在线状态: 在线`);
    console.log(`  坐标: x=${pos.x.toFixed(1)} y=${pos.y.toFixed(1)} z=${pos.z.toFixed(1)}`);
    console.log(`  维度: ${dimension}`);
    console.log(`  世界: ${world}`);
    console.log(`  血量: ${health} / 20`);
    console.log(`  饥饿: ${food} / 20`);
    console.log(`  饱和度: ${saturation}`);
    console.log(`  经验等级: ${level}`);
    console.log(`  游戏模式: ${gameMode}`);
}

// 基础信息：脚本状态（状态机状态/重试/ETA）+ 在线状态（玩家相关仅在线展示）
function showStatusBase(snapshot: MachineSnapshot | null, v: MachineValue | null, cur: Bot | null): void {
    const CONFIG = getConfig();
    const retryCount = snapshot ? snapshot.context.retryCount : 0;
    const maxRetry = CONFIG.autoReconnect.maxRetryCount;
    const eta = getEtaRemaining(v);
    console.log(`${ts()}📊 脚本状态`);
    console.log(`  状态机状态: ${getStatusLabel(v)}`);
    console.log(`  重试次数: ${retryCount} / ${maxRetry}`);
    if (eta !== null) {
        console.log(`  重连 ETA: ${eta}s`);
    }
    if (cur && cur.entity) {
        const pos = cur.entity.position;
        console.log(`  在线状态: 在线`);
        console.log(`  坐标: x=${pos.x.toFixed(1)} y=${pos.y.toFixed(1)} z=${pos.z.toFixed(1)}`);
    } else {
        console.log(`  在线状态: 未在线（${getStatusLabel(v)}）`);
    }
}

// 单项详细信息
function showStatusDetail(snapshot: MachineSnapshot | null, v: MachineValue | null, cur: Bot | null, key: string): void {
    const CONFIG = getConfig();
    switch (key) {
        case 'server':
            console.log(`${ts()}🌐 服务器信息`);
            console.log(`  地址: ${CONFIG.server.host}:${CONFIG.server.port}`);
            console.log(`  版本: ${CONFIG.server.version}`);
            console.log(`  语言: ${CONFIG.server.language || '默认'}`);
            break;
        case 'auth':
            console.log(`${ts()}🔑 认证信息`);
            console.log(`  认证服务器: ${CONFIG.auth.authServer}`);
            console.log(`  用户名: ${CONFIG.auth.username}`);
            break;
        case 'config':
            console.log(`${ts()}⚙️ 配置摘要`);
            console.log(`  自动进食: ${CONFIG.autoEat.enabled ? '开启' : '关闭'}（阈值 ${CONFIG.autoEat.hungerThreshold}${CONFIG.autoEat.bannedFood && CONFIG.autoEat.bannedFood.length ? `，禁用: ${CONFIG.autoEat.bannedFood.join(', ')}` : ''}）`);
            console.log(`  自动重连: ${CONFIG.autoReconnect.enabled ? '开启' : '关闭'}（快速重试 ${CONFIG.autoReconnect.retryDelayMs}ms，长等待 ${CONFIG.autoReconnect.rejoinDelay}ms，上限 ${CONFIG.autoReconnect.maxRetryCount} 次）`);
            console.log(`  自动指令: ${CONFIG.behavior.autoCommands && CONFIG.behavior.autoCommands.length ? CONFIG.behavior.autoCommands.join(' / ') : '无'}`);
            console.log(`  !eval: ${isEvalEnabled() ? '开启' : '关闭'}（需 config.debug.evalEnabled=true 且 DEBUG=1/true）`);
            break;
        case 'player':
            // 玩家相关仅当在线时展示
            if (cur && cur.entity) {
                printPlayerDetail(cur);
            } else {
                console.log(`${ts()}⚠️ 机器人未进入服务器（当前状态: ${getStatusLabel(v)}）`);
            }
            break;
        case 'retry':
            console.log(`${ts()}🔁 重试信息`);
            console.log(`  已重试: ${snapshot ? snapshot.context.retryCount : 0} / ${CONFIG.autoReconnect.maxRetryCount}`);
            console.log(`  快速重试延迟: ${CONFIG.autoReconnect.retryDelayMs}ms`);
            console.log(`  长等待重连延迟: ${CONFIG.autoReconnect.rejoinDelay}ms`);
            console.log(`  当前阶段: ${v === 'retry' ? '快速重试（ETA ' + getEtaRemaining(v) + 's）' : v === 'waiting' ? '等待重连（ETA ' + getEtaRemaining(v) + 's）' : v === 'authenticating' || v === 'connecting' ? '认证/建连中' : '非重试阶段'}`);
            break;
        case 'machine':
            console.log(`${ts()}🤖 状态机信息`);
            console.log(`  当前状态: ${getStatusLabel(v)} (${typeof v === 'string' ? v : JSON.stringify(v) || 'null'})`);
            console.log(`  认证数据: ${snapshot && snapshot.context.authData ? '已获取' : '未获取'}`);
            console.log(`  bot 引用: ${snapshot && snapshot.context.bot ? '有效' : '无'}`);
            break;
        default:
            console.log(`${ts()}⚠️ 未知状态项: !status ${key}`);
            console.log(`${ts()}ℹ️ 可用项: server / auth / config / player / retry / machine，或 !status all 查看全部`);
    }
}

// 全部信息
function showStatusAll(snapshot: MachineSnapshot | null, v: MachineValue | null, cur: Bot | null): void {
    showStatusBase(snapshot, v, cur);
    ['server', 'auth', 'config', 'retry', 'machine', 'player'].forEach((k) => showStatusDetail(snapshot, v, cur, k));
}

export function showStatus(arg: string): void {
    const actor: MachineActor | null = state.actor;
    const snapshot = actor ? actor.getSnapshot() : null;
    const v: MachineValue | null = snapshot ? snapshot.value : null;
    const cur = getOnlineBot(snapshot);
    if (arg === 'all') {
        showStatusAll(snapshot, v, cur);
    } else if (arg) {
        showStatusDetail(snapshot, v, cur, arg.toLowerCase());
    } else {
        showStatusBase(snapshot, v, cur);
    }
}

// ---------- 显示装备/副手/快捷栏辅助函数 ----------
function displaySlotItem(slotIndex: number, label: string, isMainHand = false): void {
    const bot: Bot | null = state.bot;
    if (!bot || !bot.inventory) return;
    const item = bot.inventory.slots[slotIndex];
    if (!item) {
        console.log(`${label}: 空`);
    } else {
        const itemStr = `${item.name} x${item.count}`;
        console.log(`${label}: ${isMainHand ? '[' + itemStr + ']' : itemStr}`);
    }
}

function showInventory(): void {
    const bot: Bot | null = state.bot;
    if (!bot || !bot.inventory) {
        console.log(`${ts()}⚠️ 机器人未进入服务器`);
        return;
    }

    const slots = bot.inventory.slots;
    const mainHandSlot = bot.heldItemSlot; // 0-8，快捷栏当前选中槽

    console.log(`${ts()}📦 物品栏`);

    // 装备 1-4（槽位 36-39）
    const armorNames = ['头盔', '胸甲', '护腿', '靴子'];
    for (let i = 0; i < 4; i++) {
        const idx = 36 + i;
        displaySlotItem(idx, `装备${i + 1} (${armorNames[i]})`);
    }

    // 副手（槽位 40）
    displaySlotItem(40, '副手');

    // 快捷栏 1-9（槽位 0-8）
    const hotbarLabels = ['快捷栏1', '快捷栏2', '快捷栏3', '快捷栏4', '快捷栏5', '快捷栏6', '快捷栏7', '快捷栏8', '快捷栏9'];
    console.log('--- 快捷栏 ---');
    for (let i = 0; i < 9; i++) {
        const isMainHand = (i === mainHandSlot);
        displaySlotItem(i, hotbarLabels[i], isMainHand);
    }

    // 背包（槽位 9-35），仅显示非空槽位
    console.log('--- 背包 ---');
    let hasBackpackItem = false;
    for (let i = 9; i <= 35; i++) {
        const item = slots[i];
        if (item) {
            hasBackpackItem = true;
            console.log(`背包槽${i + 1}: ${item.name} x${item.count}`);
        }
    }
    if (!hasBackpackItem) {
        console.log('  （背包为空）');
    }
}

// ---------- !eval（vm 沙箱，保持 JS） ----------
// 双门控判定：config.debug.evalEnabled 与环境变量 DEBUG 严格匹配 '1'/'true'（大小写敏感）同时满足才启用
function isEvalEnabled(): boolean {
    const CONFIG = getConfig();
    const debugEnv = process.env.DEBUG;
    return CONFIG.debug.evalEnabled === true && (debugEnv === '1' || debugEnv === 'true');
}

function runEval(code: string): void {
    if (!isEvalEnabled()) {
        console.log(`${ts()}⚠️ !eval 未启用：需 config.json 中 debug.evalEnabled = true 且环境变量 DEBUG=1 或 DEBUG=true`);
        return;
    }
    const CONFIG = getConfig();
    const context: Record<string, unknown> = {
        bot: state.bot,
        CONFIG,
        console,
        require,
        process,
        ts,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
    };
    try {
        const script = new vm.Script(code, { filename: '!eval' });
        const result = script.runInNewContext(context, { timeout: 5000 });
        if (result !== undefined) {
            console.log(`${ts()}🔧 eval 结果:`, result);
        }
    } catch (err) {
        console.error(`${ts()}❌ eval 执行错误:`, (err as Error).message);
    }
}

// ---------- 帮助 ----------
function showHelp(): void {
    console.log(`${ts()}ℹ️ 可用本地命令`);
    console.log('  !help           显示本帮助');
    console.log('  !connect        立即重新连接服务器');
    console.log('  !disconnect/!dc 手动断开连接');
    console.log('  !inventory      查看物品栏（装备/副手/快捷栏/背包）');
    console.log('  !status         查看脚本状态（!status all 全部 / !status <server|auth|config|player|retry|machine> 单项）');
    console.log('  !reload         重新加载 config.json');
    console.log('  !view enable [端口] 启动 3D 可视化（可选端口，默认3000）');
    console.log('  !view disable   关闭 3D 可视化');
    console.log('  !liveview enable [端口] 启动自研实时查看器（默认端口3001）');
    console.log('  !liveview disable  关闭自研实时查看器');
    console.log('  !eval <代码>    执行调试代码（需 config.debug.evalEnabled=true 且 DEBUG=1/true）');
    console.log('  !quit           退出程序');
    console.log('  直接输入文字则发送到服务器聊天');
}

// ---------- 本地指令 ----------
export function handleLocalCommand(input: string): void {
    const parts = input.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    const bot: Bot | null = state.bot;
    const actor: MachineActor | null = state.actor;
    switch (cmd) {
        case 'quit':
            console.log(`${ts()}👋 本地指令 !quit：正在退出...`);
            if (state.shutdown) state.shutdown('本地指令 !quit');
            break;
        case 'disconnect':
        case 'dc':
            console.log(`${ts()}⏸️ 手动断开连接（可用 !connect 重新连接）`);
            if (bot) {
                try { bot.end('手动断开'); } catch (e) { /* ignore */ }
                state.bot = null;
            }
            actor!.send({ type: 'MANUAL_DISCONNECT' }); // 任意状态 → offline
            break;
        case 'connect':
            console.log(`${ts()}🔄 立即重新连接...`);
            if (bot) {
                try { bot.end('手动重连'); } catch (e) { /* ignore */ }
                state.bot = null;
            }
            actor!.send({ type: 'CONNECT' }); // 任意状态 → authenticating（自动取消进行中的认证/建连）
            break;
        case 'view': {
            const sub = (parts[1] || '').toLowerCase();
            if (sub === 'enable') {
                const p = parseInt(parts[2], 10);
                showView(Number.isInteger(p) && p > 0 && p < 65536 ? p : 3000);
            } else if (sub === 'disable') {
                stopView();
            } else {
                console.log(`${ts()}⚠️ 用法错误: !view enable [端口] 或 !view disable`);
                console.log(`${ts()}ℹ️ 示例: !view enable 3000 / !view disable`);
            }
            break;
        }
        case 'liveview': {
            const sub = (parts[1] || '').toLowerCase();
            if (sub === 'enable') {
                const p = parseInt(parts[2], 10);
                // 守卫：机器人本体未就绪（未连接 / 未入服）时不带 null 进入启动逻辑，
                // 交由 enableLiveView 内部状态判断；不直接断言 bot! 以免运行期 TypeError。
                if (!bot || !bot.entity || !bot.world) {
                    console.log(`${ts()}⚠️ 机器人未进入服务器，无法启动实时查看器（请先 !connect 且已在游戏内）`);
                    break;
                }
                const port = Number.isInteger(p) && p > 0 && p < 65536 ? p : 3001;
                enableLiveView(bot, port).catch((err: unknown) => {
                    console.error(`${ts()}❌ 启动实时查看器异常: ${err instanceof Error ? err.message : String(err)}`);
                });
            } else if (sub === 'disable') {
                disableLiveView().catch((err: unknown) => {
                    console.error(`${ts()}❌ 关闭实时查看器异常: ${err instanceof Error ? err.message : String(err)}`);
                });
            } else {
                console.log(`${ts()}⚠️ 用法错误: !liveview enable [端口] 或 !liveview disable`);
                console.log(`${ts()}ℹ️ 示例: !liveview enable 3001 / !liveview disable`);
            }
            break;
        }
        case 'inventory':
            showInventory();
            break;
        case 'status':
            // 用法：!status 基础信息 / !status <key> 单项 / !status all 全部
            showStatus(parts[1] || '');
            break;
        case 'reload':
            reloadConfig();
            break;
        case 'help':
            showHelp();
            break;
        case 'eval': {
            // 语法：!eval <JavaScript 代码>
            const code = parts.slice(1).join(' ').trim();
            if (!code) {
                console.log(`${ts()}⚠️ 用法: !eval <代码>`);
            } else {
                runEval(code);
            }
            break;
        }
        default:
            console.log(`${ts()}⚠️ 未知本地指令 !${cmd}。使用 !help 获取帮助。`);
    }
}

// ---------- 控制台交互 ----------
export function initConsole(readlineInstance: readline.Interface): void {
    rl = readlineInstance;
    rl.on('line', (line) => {
        const input = line.trim();
        if (!input) { rl!.prompt(); return; }
        if (input.startsWith('!')) {
            handleLocalCommand(input);
        } else if (state.bot && state.bot.entity) {
            state.bot.chat(input);
            console.log(`${ts()}➤ 已发送: ${input}`);
        } else {
            console.log(`${ts()}⚠️ 机器人未进入服务器，无法发送`);
        }
        rl!.prompt();
    });
    console.log(`${ts()}💬 控制台已启用：直接输入发送聊天/命令，使用 !help 检查本地指令。`);
    rl.prompt();
}
