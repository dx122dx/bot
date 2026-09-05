// index.ts —— 入口：组装各模块 + XState actor 订阅 + ETA 提示符 + 错误处理 + 启动/停止
import readline from 'readline';
import { createActor } from 'xstate';
import { initLogger, ts, setRl } from './src/logger.js';
import { loadConfig } from './src/config.js';
import { createBotMachine } from './src/botMachine.js';
import { authenticate } from './src/auth.js';
import { createBotWithToken } from './src/connect.js';
import { stopAutoEatPolling } from './src/autoEat.js';
import { initConsole } from './src/commands.js';
import { state } from './src/state.js';
import type { BotConfig } from './src/config.js';

// ---------- 初始化顺序（与原 bot.js 顶层等价） ----------

// 1. 初始化日志重定向（最先调用：之后所有 console 输出写入 bot.log）
initLogger();

// 2. 加载配置
const CONFIG: BotConfig = loadConfig();

// 3. 控制台 readline（TTY 保护依赖 rl，需先创建再注入 logger）
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
});
setRl(rl);

// 4. XState 状态机（事件驱动，无每秒轮询）
const machine = createBotMachine({
    config: CONFIG,
    authService: () => authenticate(),
    connectService: ({ authData }) => createBotWithToken(authData),
});

let etaRefreshTimer: NodeJS.Timeout | null = null;

// 停止 retry/waiting 倒计时显示定时器（离开状态或 shutdown 时调用）
function stopEtaCountdown() {
    if (etaRefreshTimer) {
        clearInterval(etaRefreshTimer);
        etaRefreshTimer = null;
    }
    state.etaState = null;
}

// prompt 维护：状态迁移时由 actor 订阅回调更新；retry/waiting 下由 1s 显示定时器每秒重绘，ETA 递减
function refreshPrompt() {
    if (!process.stdout.isTTY || !rl || rl.closed) return; // 非 TTY 不处理
    if (!state.actor) return; // actor 尚未创建
    const v = state.actor.getSnapshot().value;
    let prompt: string;
    if (v === 'retry') {
        const remaining = Math.max(0, Math.ceil((CONFIG.autoReconnect.retryDelayMs - (Date.now() - state.etaEnteredAt)) / 1000));
        prompt = `\x1b[33m[快速重试] ETA ${remaining}s\x1b[0m > `;
    } else if (v === 'waiting') {
        const remaining = Math.max(0, Math.ceil((CONFIG.autoReconnect.rejoinDelay - (Date.now() - state.etaEnteredAt)) / 1000));
        prompt = `\x1b[33m[等待重连] ETA ${remaining}s\x1b[0m > `;
    } else if (v === 'offline') {
        prompt = '\x1b[31m[离线]\x1b[0m > ';
    } else if (v === 'authenticating') {
        prompt = '\x1b[36m[正在认证]\x1b[0m > ';
    } else if (v === 'connecting') {
        prompt = '\x1b[34m[正在连接]\x1b[0m > ';
    } else {
        prompt = '\x1b[32m[在线]\x1b[0m > ';
    }
    rl.setPrompt(prompt);
    if (rl.terminal) {
        rl.prompt(true);
    }
}

// 初始化提示符（初始状态 offline；actor 尚未创建，refreshPrompt 内部直接返回）
refreshPrompt();

// 5. 控制台（rl 已创建并注入 logger）
initConsole(rl);

// ---------- 错误处理 ----------
process.on('uncaughtException', (err) => {
    console.error(`${ts()}❌ 未捕获异常，进程将退出:`, err);
    process.exitCode = 1; // 异常退出码非 0，便于脚本检测
    shutdown(`未捕获异常: ${err instanceof Error ? err.message : err}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`${ts()}❌ 未处理的 Promise 拒绝:`, reason);
});

// ---------- 停止 ----------
let isShuttingDown = false;

function shutdown(reason = '未知原因导致退出'): void {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`${ts()}👋 ${reason}，正在关闭机器人...`);

    stopAutoEatPolling();
    stopEtaCountdown(); // 停止 ETA 倒计时显示定时器

    // 停止状态机（取消进行中的 invoke 与 after 定时器）
    if (state.actor) {
        try { state.actor.stop(); } catch (e) { /* ignore */ }
    }

    // 断开机器人
    if (state.bot) {
        try { state.bot.end('程序退出'); } catch (e) { /* ignore */ }
        state.bot = null;
    }

    // 关闭 readline（如果还开着）
    if (rl && !rl.closed) {
        // 清除当前行，避免残留 [离线] > prompt 直接贴着 shell 提示符
        if (process.stdout.isTTY) {
            process.stdout.write('\r\x1b[2K');
        }
        rl.close();
    }

    // 退出进程（尊重已设置的 process.exitCode，如 uncaughtException 置 1）
    process.exit(process.exitCode ?? 0);
}
state.shutdown = shutdown; // 注入共享状态（commands 的 !quit 调用）

process.on('SIGINT', () => {
    console.log(`${ts()}👋 收到退出信号，正在关闭...`);
    shutdown('收到 SIGINT 信号');
});

// ---------- 启动 ----------
(async () => {
    // 创建并启动 XState actor；订阅回调同步当前 bot 引用并刷新提示符（状态迁移即刷新）
    state.actor = createActor(machine);
    state.actor.subscribe((snapshot) => {
        if (snapshot.matches('online') && snapshot.context.bot) {
            state.bot = snapshot.context.bot;
        }
        const v = snapshot.value;
        if (v === 'retry' || v === 'waiting') {
            // 进入倒计时状态：记录时间戳（仅首次进入时更新，自迁移等保持原起点），并启动每秒重绘（仅 TTY 下）
            if (state.etaState !== v) {
                state.etaState = v;
                state.etaEnteredAt = Date.now();
            }
            if (!etaRefreshTimer && process.stdout.isTTY) {
                etaRefreshTimer = setInterval(refreshPrompt, 1000);
            }
        } else if (state.etaState) {
            // 离开倒计时状态：停止定时器
            stopEtaCountdown();
        }
        refreshPrompt();
    });
    state.actor.start();
    // 初始启动认证纳入状态机：认证失败自动进入 retry 快速重试，不再直接退出
    state.actor.send({ type: 'CONNECT' });
})();
