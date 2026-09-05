// interact.ts —— 交互模块：viewer 点击交互（左键查看详情 / 右键使用）+ GUI 数据包监听
// mineflayer-pathfinder 是 CJS 包，Node 26 静态 named-export 检测识别不到 `goals`
// （其值是 require() 调用），故统一改为 default 导入 + 解构（default = module.exports）
import pathfinderModule from 'mineflayer-pathfinder';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pathfinderModule;
import type { Bot } from 'mineflayer';
import type { Window } from 'prismarine-windows';
import type { Block } from 'prismarine-block';
import type { Vec3 } from 'vec3';
import type { ChatMessage } from 'prismarine-chat';
import prismarineChat from 'prismarine-chat';
import { inspect } from 'node:util';

// prismarine-chat 实际导出为 factory（loader(versionOrRegistry) → ChatMessage class）；
// NodeNext 下对 CJS 包 default import 的类型被判定为模块命名空间，故需断言
const loadChatMessage = prismarineChat as unknown as (versionOrRegistry: string) => typeof ChatMessage;
import { ts } from './logger.js';
import viewerPatch from './viewer-patch.cjs';

// —— pathfinder 基础 ——
// 幂等加载 pathfinder 插件（bot 创建后可能被再次调用）
function ensurePathfinder(bot: Bot): void {
    if (!bot.pathfinder) {
        bot.loadPlugin(pathfinder);
    }
    if (!bot.pathfinder) {
        throw new Error('pathfinder 插件加载失败');
    }
}

// 导航到指定坐标附近（range 格内）。成功返回 true；失败/超时返回 false（调用方自行处理）。
// 防御措施（针对「移动中打断 → 玩家空中/不可站立 start → A* 立即 noPath」场景）：
//   ① setGoal 前若玩家未落地（onGround=false）先等落地（最多 3s）再导航；
//   ② noPath/timeout 快速失败时打印诊断（status/玩家位置/onGround/isInWater/goal/距离），
//      等 1.5s 重试一次，仍失败才返回 false；30s 总超时不重试。
export function gotoNear(bot: Bot, x: number, y: number, z: number, range = 3, timeoutMs = 30000): Promise<boolean> {
    ensurePathfinder(bot);
    bot.pathfinder.setMovements(new Movements(bot));
    const goal = new goals.GoalNear(x, y, z, range);

    // ① 玩家未落地时先等待落地（最多 3s），避免 A* 从空中/移动中 start 出发立即 noPath
    const waitForGround = (): Promise<void> => new Promise<void>((resolve) => {
        if (bot.entity.onGround) { resolve(); return; }
        console.log(`${ts()}🦶 玩家未落地（onGround=false），等待落地后再导航...`);
        const deadline = Date.now() + 3000;
        const iv = setInterval(() => {
            if (bot.entity.onGround || Date.now() > deadline) {
                clearInterval(iv);
                if (!bot.entity.onGround) console.log(`${ts()}⚠️ 等待落地超时（3s），仍尝试导航`);
                resolve();
            }
        }, 200);
    });

    // 单次导航尝试：返回 'ok'（到达）/ 'noPath' | 'timeout'（A* 快速失败）/ 'totalTimeout'（30s 总超时）
    const navigateOnce = (): Promise<'ok' | 'noPath' | 'timeout' | 'totalTimeout'> => new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => finish('totalTimeout'), timeoutMs);
        const onGoal = (): void => finish('ok');
        const onPath = (path: PartiallyComputedPath): void => {
            if (path.status === 'success') finish('ok');
            else if (path.status === 'noPath' || path.status === 'timeout') finish(path.status);
        };
        function finish(status: 'ok' | 'noPath' | 'timeout' | 'totalTimeout'): void {
            if (done) return;
            done = true;
            clearTimeout(timer);
            bot.removeListener('goal_reached', onGoal);
            bot.removeListener('path_update', onPath);
            resolve(status);
        }
        bot.pathfinder.setGoal(goal);
        bot.on('goal_reached', onGoal);
        bot.on('path_update', onPath);
    });

    // 失败诊断：status + 玩家位置 + onGround + isInWater + goal + 距离
    const diagnose = (status: string): void => {
        const pos = bot.entity?.position;
        // isInWater 由 prismarine-physics 运行时注入，Entity 类型未声明该字段，需断言
        const isInWater = (bot.entity as { isInWater?: boolean } | undefined)?.isInWater ?? false;
        const dist = pos ? Math.hypot(pos.x - x, pos.y - y, pos.z - z) : NaN;
        const posTxt = pos ? `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : '(未知)';
        console.log(`${ts()}⚠️ gotoNear 失败诊断: status=${status} 玩家位置=${posTxt} onGround=${bot.entity?.onGround} isInWater=${isInWater} goal=(${x}, ${y}, ${z}, range=${range}) 距离=${dist.toFixed(1)}格`);
    };

    return new Promise<boolean>((resolve) => {
        void (async () => {
            await waitForGround();

            // ② 首次导航
            const first = await navigateOnce();
            if (first === 'ok') { resolve(true); return; }
            if (first === 'totalTimeout') {
                // 30s 总超时：等待已足够长，不再重试
                diagnose('totalTimeout');
                resolve(false);
                return;
            }

            // 快速失败（noPath/timeout）：打印诊断 + 等 1.5s 重试一次，仍失败才返回 false
            diagnose(first);
            console.log(`${ts()}🔄 等待 1.5s 后重试导航...`);
            await new Promise<void>((r) => setTimeout(r, 1500));
            const second = await navigateOnce();
            if (second === 'ok') { resolve(true); return; }
            diagnose(second === 'totalTimeout' ? 'totalTimeout' : `重试仍失败: ${second}`);
            resolve(false);
        })().catch((err) => {
            // 防御：内部异常一律按失败处理，避免调用方 await 时未捕获 rejection
            diagnose(`内部异常: ${(err as Error).message}`);
            resolve(false);
        });
    });
}

// —— GUI 数据包监听 ——
// 1.20.1 open_window 原始包字段（windowId varint / inventoryType varint / windowTitle string）
interface OpenWindowPacket {
    windowId: number;
    inventoryType: number;
    windowTitle: string;
}

// 1.20.x 的 windowTitle 是 Chat 组件 JSON（如 {"text":"箱子"} / {"translate":"container.chest"}），解析成可读文本
function readableWindowTitle(title: string): string {
    try {
        const parsed: unknown = JSON.parse(title);
        if (parsed && typeof parsed === 'object') {
            const obj = parsed as { text?: unknown; translate?: unknown };
            if (typeof obj.text === 'string') return obj.text;
            if (typeof obj.translate === 'string') return obj.translate;
        }
        return title;
    } catch {
        return title;
    }
}

// windowOpen：非玩家背包窗口时打印标题+非空槽物品（名称 x数量，参考 !inventory），并推送网页
function handleWindowOpen(window: Window): void {
    // 玩家自身背包（按 E 打开）不算外部 GUI，跳过
    if (window.type === 'minecraft:inventory') return;

    const title = readableWindowTitle(window.title);
    console.log(`${ts()}🗔 GUI 窗口: ${title} (type=${window.type})`);
    const lines: string[] = [];
    let hasItem = false;
    for (let i = 0; i < window.slots.length; i++) {
        const item = window.slots[i];
        if (!item) continue;
        hasItem = true;
        const line = `槽${i + 1}: ${item.name} x${item.count}`;
        console.log(`  ${line}`);
        lines.push(line);
    }
    if (!hasItem) {
        console.log('  （容器为空）');
    }
    viewerPatch.setGuiData({ title, items: lines });
}

// 挂接 GUI 数据包监听（原始 open_window 包 → 控制台；windowOpen → 控制台 + 网页）
function installGuiMonitor(bot: Bot): void {
    bot._client.on('open_window', (packet: OpenWindowPacket) => {
        console.log(`${ts()}📦 open_window 原始包:`, JSON.stringify(packet));
    });
    bot.on('windowOpen', (window: Window) => {
        handleWindowOpen(window);
    });
}

// —— viewer 点击交互：左键查看方块详情 / 右键使用 ——

// 容器方块判定：block.name 不带 minecraft: 前缀，与 mineflayer lib/plugins/chest.js openContainer 的 allowedWindowTypes 一致
const CONTAINER_BLOCK_NAMES = new Set([
    'generic', 'chest', 'ender_chest', 'trapped_chest', 'barrel',
    'dispenser', 'dropper', 'hopper',
    'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box', 'light_blue_shulker_box',
    'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box', 'gray_shulker_box',
    'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box', 'blue_shulker_box',
    'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
]);

function isContainerBlock(block: Block): boolean {
    const name = block.name.replace(/^minecraft:/, '');
    return CONTAINER_BLOCK_NAMES.has(name);
}

// 告示牌：block.name 含 sign
function isSignBlock(block: Block): boolean {
    return block.name.includes('sign');
}

// 从方块实体 NBT 提取 front_text.messages（字符串数组）；兼容 Tag 结构（compound/value 包裹）与 plain object
function extractSignMessages(entity: unknown): string[] | null {
    if (!entity || typeof entity !== 'object') return null;
    const root = entity as Record<string, unknown>;
    // 兼容 {type:'compound', value:{front_text:{...}}} 与 {front_text:{...}}
    const rawFront: unknown = (root.type === 'compound' && root.value && typeof root.value === 'object')
        ? (root.value as Record<string, unknown>).front_text
        : root.front_text;
    if (!rawFront || typeof rawFront !== 'object') return null;
    const frontRaw = rawFront as Record<string, unknown>;
    const front = (frontRaw.type === 'compound' && frontRaw.value && typeof frontRaw.value === 'object')
        ? (frontRaw.value as Record<string, unknown>)
        : frontRaw;
    const messages: unknown = front.messages;
    if (messages == null) return null;
    let arr: unknown = null;
    if (Array.isArray(messages)) {
        arr = messages;
    } else if (typeof messages === 'object' && (messages as Record<string, unknown>).type === 'list') {
        // NBT list Tag: { type:'list', value:{ type:'string', value:[...] } }
        const listValue = (messages as Record<string, unknown>).value;
        if (listValue && typeof listValue === 'object') {
            arr = (listValue as Record<string, unknown>).value;
        }
    }
    return Array.isArray(arr) ? arr.map(String) : null;
}

// 告示牌单行：Chat 组件 JSON → 纯文本（fromNotch 失败视为纯文本原样返回）
function renderSignLine(ChatMessageCtor: typeof ChatMessage, raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    try {
        return ChatMessageCtor.fromNotch(trimmed).toString();
    } catch {
        return trimmed;
    }
}

function printSignFrontText(block: Block, ChatMessageCtor: typeof ChatMessage): void {
    const messages = extractSignMessages(block.entity);
    if (!messages) {
        console.log('  （front_text.messages 不可用）');
        return;
    }
    messages.forEach((line, idx) => {
        const text = renderSignLine(ChatMessageCtor, line);
        console.log(`  告示牌第${idx + 1}行: ${text || '（空）'}`);
    });
}

// 左键点击方块：gotoNear 走近 → 打印 id+NBT → 告示牌打印文本 / 容器 openContainer（触发 windowOpen 联动打印物品栏）
async function handleBlockClicked(bot: Bot, block: Block): Promise<void> {
    const pos = block.position;
    console.log(`${ts()}🖱️ 左键点击: ${block.name} @ ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
    const reached = await gotoNear(bot, pos.x, pos.y, pos.z, 3);
    if (!reached) {
        console.log(`${ts()}⚠️ 无法走到方块附近（无路径/超时），跳过详情`);
        return;
    }
    // 默认详情：id + NBT
    console.log(`  id=${block.type} name=${block.name} stateId=${block.stateId}`);
    if (block.entity) {
        console.log(`  NBT: ${inspect(block.entity, { depth: 5, colors: false, maxArrayLength: 20 })}`);
    } else {
        console.log('  （无方块实体 NBT）');
    }
    // 告示牌：front_text.messages 格式化文本
    if (isSignBlock(block)) {
        printSignFrontText(block, loadChatMessage(bot.version));
        return; // 告示牌非容器，不再尝试 openContainer
    }
    // 容器：openContainer 打开窗口（windowOpen 事件 → GUI 打印物品栏）
    if (isContainerBlock(block)) {
        try {
            await bot.openContainer(block);
        } catch (err) {
            console.log(`${ts()}⚠️ openContainer 失败: ${(err as Error).message}`);
        }
    }
}

// 右键使用方块：gotoNear 走近 → bot.activateBlock(block)（activateBlock 内部自动 lookAt；
// 容器打开会触发 windowOpen 事件 → 联动打印物品栏）；失败/超时打印错误
async function handleBlockUse(bot: Bot, block: Block): Promise<void> {
    const pos = block.position;
    console.log(`${ts()}🖱️ 右键使用: ${block.name} @ ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
    const reached = await gotoNear(bot, pos.x, pos.y, pos.z, 3);
    if (!reached) {
        console.log(`${ts()}⚠️ 无法走到方块附近（无路径/超时），跳过使用`);
        return;
    }
    try {
        await bot.activateBlock(block);
    } catch (err) {
        console.log(`${ts()}⚠️ activateBlock 失败: ${(err as Error).message}`);
    }
}

// 挂接 viewer blockClicked（view.ts 在 mineflayerViewer 创建后调用）
export function attachBlockClicked(bot: Bot): void {
    const viewer = (bot as unknown as { viewer?: { on: (event: string, cb: (block: Block, face: Vec3, button: number) => void) => void } }).viewer;
    if (!viewer) {
        console.log(`${ts()}⚠️ attachBlockClicked: viewer 未初始化，跳过`);
        return;
    }
    viewer.on('blockClicked', (block: Block, _face: Vec3, button: number) => {
        if (button === 0) {
            void handleBlockClicked(bot, block);
        } else if (button === 2) {
            void handleBlockUse(bot, block);
        }
    });
}

// 在 bot 创建后统一初始化（GUI 监听不依赖 viewer；viewer 点击挂接由 view.ts 在 viewer 创建后调用 attachBlockClicked）
export function installInteractions(bot: Bot): void {
    // pathfinder 插件注入依赖 mineflayer 的 inject_allowed 事件（loader.js 用 setTimeout(0) 在 createBot
    // 后下一 tick 才触发），此前的 loadPlugin 只会排队，bot.pathfinder 仍是 undefined。故：
    // 1) 这里 try-catch 隔离，避免抛错连带中断 installGuiMonitor；
    // 2) bot.once('spawn') 时 inject_allowed 必已触发，loadPlugin 立即生效，再确保一次（双保险）。
    try {
        ensurePathfinder(bot);
    } catch (err) {
        console.log(`${ts()}⚠️ pathfinder 尚未注入（inject_allowed 未触发），将在 spawn 后再确保: ${(err as Error).message}`);
    }
    installGuiMonitor(bot);
    bot.once('spawn', () => {
        try {
            ensurePathfinder(bot);
            console.log(`${ts()}✅ pathfinder 插件已就绪`);
        } catch (err) {
            console.log(`${ts()}⚠️ spawn 后 pathfinder 仍不可用: ${(err as Error).message}`);
        }
    });
    // 左键详情/右键使用已由 view.ts 挂接 attachBlockClicked
}
