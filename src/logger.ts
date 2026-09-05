// logger.ts —— 日志模块：console.log/error 重定向（写入 bot.log + TTY 保护）
import fs from 'fs';
import path from 'path';
import util from 'util';
import { fileURLToPath } from 'url';
import type readline from 'readline';

// 消除 cwd 依赖：优先环境变量 MINEFLAYER_LOG，否则按模块位置探测
// （兼容源码直跑 src/logger.ts 与编译产物 dist/src/logger.js 两种布局）
function resolveLogPath(): string {
    const fromEnv = process.env.MINEFLAYER_LOG;
    if (fromEnv) return fromEnv;
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.join(moduleDir, '..', 'bot.log'),
        path.join(moduleDir, '..', '..', 'bot.log'),
    ];
    return candidates.find((c) => fs.existsSync(c)) ?? candidates[candidates.length - 1];
}

// 日志文件路径
const LOG_FILE_PATH = resolveLogPath();

// readline 实例（index.js 创建控制台后注入；TTY 保护输出需要它）
let rl: readline.Interface | null = null;

// 去除 ANSI 转义码
export function stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// 统一时间戳
export function ts(): string {
    return new Date().toLocaleString();
}

// 注入 readline 实例（必须在创建 rl 后调用）
export function setRl(value: readline.Interface): void {
    rl = value;
}

const _origLog = console.log;
const _origError = console.error;

function protectedOutput(fn: (...args: unknown[]) => void, args: unknown[]): void {
    // 写入日志文件
    try {
        const logMessage = stripAnsi(util.format(...args));
        fs.appendFileSync(LOG_FILE_PATH, logMessage + '\n');
    } catch (err) {
        // 忽略写文件错误
    }

    // 终端输出保护（仅在 readline 未关闭时操作；prompt(true) 强制重绘当前行，避免 pause/resume 重入）
    if (process.stdout.isTTY && rl && !rl.closed) {
        process.stdout.write('\r\x1b[2K');
        fn(...args);
        rl.prompt(true);
    } else {
        fn(...args);
    }
}

// 初始化日志重定向（index.js 中最先调用，之后所有 console 输出都写入 bot.log）
export function initLogger(): void {
    console.log = (...args: unknown[]) => protectedOutput(_origLog, args);
    console.error = (...args: unknown[]) => protectedOutput(_origError, args);
}
