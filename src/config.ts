// config.ts —— 配置管理器：加载 / 校验 / 默认值深合并 / 重载 / 访问
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ts } from './logger.js';

// ---------- 类型定义（完整配置结构） ----------

export interface ServerConfig {
    host: string;
    port: number;
    version: string;
    language?: string;
}

export interface AuthConfig {
    authServer: string;
    sessionServer?: string;
    username: string;
    password: string;
    auth?: 'mojang' | 'microsoft' | 'offline';
}

export interface AutoEatConfig {
    enabled?: boolean;
    bannedFood?: string[];
    hungerThreshold: number;
}

export interface AutoReconnectConfig {
    enabled?: boolean;
    triggerPlayers?: string[];
    triggerKeywords: string[];
    rejoinDelay: number;
    retryDelayMs: number;
    maxRetryCount: number;
}

export interface BehaviorConfig {
    autoCommands?: string[];
}

export interface DebugConfig {
    evalEnabled?: boolean;
}

export interface BotConfig {
    server: ServerConfig;
    auth: AuthConfig;
    autoEat: AutoEatConfig;
    autoReconnect: AutoReconnectConfig;
    behavior: BehaviorConfig;
    debug: DebugConfig; // 默认值兜底后恒存在（2026-08-19 缺 debug 曾致 !status all 崩溃）
}

// ---------- 默认配置（参照 config.example.json；必填项留空由校验拦截） ----------

export const DEFAULT_CONFIG: BotConfig = {
    server: {
        host: '', // 必填：缺失由校验报错退出
        port: 25565,
        version: '1.20.1',
        language: 'zh_cn',
    },
    auth: {
        authServer: 'https://authmc.newnan.city',
        sessionServer: 'https://authmc.newnan.city',
        username: '', // 必填
        password: '', // 必填
        auth: 'mojang',
    },
    autoEat: {
        enabled: true,
        bannedFood: [],
        hungerThreshold: 18,
    },
    autoReconnect: {
        enabled: true,
        triggerPlayers: [],
        triggerKeywords: [],
        rejoinDelay: 1800000,
        retryDelayMs: 5000,
        maxRetryCount: 2,
    },
    behavior: {
        autoCommands: [],
    },
    debug: {
        evalEnabled: false, // 安全默认：!eval 需在 config.json 显式开启（commands 提示逻辑一致）
    },
};

// ---------- 深合并 ----------

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 默认值深合并：defaults 为基底，overrides 覆盖（对象递归合并，数组/基本类型整体替换；覆盖非对象时保留基底）
function deepMerge(defaults: unknown, overrides: unknown): unknown {
    if (!isPlainObject(defaults) || !isPlainObject(overrides)) {
        return defaults;
    }
    const result: Record<string, unknown> = { ...defaults };
    for (const key of Object.keys(overrides)) {
        const defVal = defaults[key];
        const ovVal = overrides[key];
        if (ovVal === undefined) continue; // 显式 undefined 视为缺省
        result[key] = isPlainObject(defVal) && isPlainObject(ovVal)
            ? deepMerge(defVal, ovVal)
            : ovVal;
    }
    return result;
}

// ---------- 校验（必填项缺失/为空 → 调用方决定处理） ----------

function findMissingRequired(config: BotConfig): string[] {
    const required: Array<{ key: string; value: unknown }> = [
        { key: 'server.host', value: config.server.host },
        { key: 'auth.username', value: config.auth.username },
        { key: 'auth.password', value: config.auth.password },
    ];
    return required
        .filter(({ value }) => typeof value !== 'string' || value.trim() === '')
        .map(({ key }) => key);
}

// ---------- 加载 / 重载 / 访问 ----------

// 消除 cwd 依赖：优先环境变量 MINEFLAYER_CONFIG，否则按模块位置探测
// （兼容源码直跑 src/config.ts 与编译产物 dist/src/config.js 两种布局）
function resolveConfigPath(): string {
    const fromEnv = process.env.MINEFLAYER_CONFIG;
    if (fromEnv) return fromEnv;
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.join(moduleDir, '..', 'config.json'),
        path.join(moduleDir, '..', '..', 'config.json'),
    ];
    return candidates.find((c) => fs.existsSync(c)) ?? candidates[candidates.length - 1];
}

const configPath = resolveConfigPath();
let CONFIG: BotConfig | null = null;

export function getConfig(): BotConfig {
    return CONFIG as BotConfig; // loadConfig 先于一切调用执行，运行时恒非 null
}

// 加载外部配置文件（读失败或必填项缺失时退出进程，与启动失败语义一致）
export function loadConfig(): BotConfig {
    try {
        const configFile = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(configFile) as unknown;
        CONFIG = deepMerge(DEFAULT_CONFIG, parsed) as BotConfig;
        const missing = findMissingRequired(CONFIG);
        if (missing.length > 0) {
            console.error(`${ts()}❌ 配置校验失败，以下必填项缺失或为空：`);
            for (const key of missing) {
                console.error(`  - ${key}`);
            }
            console.error(`${ts()}ℹ️ 请在 config.json 中补齐后重新启动。`);
            process.exit(1);
        }
        console.log(`${ts()}✅ 成功加载外部配置文件: ${configPath}`);
    } catch (error) {
        console.error(`${ts()}❌ 加载配置文件失败:`, (error as Error).message);
        console.error(`${ts()}ℹ️ 请确保 config.json 位于项目根目录，或通过环境变量 MINEFLAYER_CONFIG 指定路径。`);
        process.exit(1);
    }
    return CONFIG;
}

// 重新加载（!reload）：缺失字段同样用默认值兜底；校验失败时保留旧配置不退出（运行中安全性优先）
export function reloadConfig(): void {
    try {
        const configFile = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(configFile) as unknown;
        const merged = deepMerge(DEFAULT_CONFIG, parsed) as BotConfig;
        const missing = findMissingRequired(merged);
        if (missing.length > 0) {
            console.error(`${ts()}❌ 配置校验失败（保留原配置）: 必填项缺失或为空 — ${missing.join(', ')}`);
            return;
        }
        CONFIG = merged;
        console.log(`${ts()}✅ 配置已重新加载。部分设置（如自动进食阈值）需重新连接或重新执行相关操作后生效。`);
    } catch (error) {
        console.error(`${ts()}❌ 重新加载配置失败（保留原配置）:`, (error as Error).message);
    }
}
