// view.ts —— 3D 可视化模块：!view enable/disable
import net from 'net';
import { createRequire } from 'module';
import { ts } from './logger.js';
import { state } from './state.js';
import { attachBlockClicked } from './interact.js';
import type { Bot } from 'mineflayer';
import viewerPatch from './viewer-patch.cjs';

// ESM 下无全局 require，用 createRequire 提供（按需加载 prismarine-viewer）
const require = createRequire(import.meta.url);

let recentClosedPort: number | null = null; // 最近关闭的端口（用于停用后立即重启用例的端口等待）

function checkPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.listen(port, '0.0.0.0', () => {
            tester.close(() => resolve(true));
        });
    });
}

export async function showView(port = 3000): Promise<void> {
    const bot: Bot | null = state.bot;
    if (!bot || !bot.entity) {
        console.log(`${ts()}⚠️ 机器人未进入服务器`);
        return;
    }
    let mineflayerViewer: (bot: Bot, opts: Record<string, unknown>) => unknown;
    try {
        const viewerModule = 'prismarine-viewer';
        mineflayerViewer = require(viewerModule).mineflayer;
    } catch (err) {
        console.log(`${ts()}⚠️ 无法加载 prismarine-viewer，!view 可视化不可用: ${(err as Error).message}`);
        console.log(`${ts()}ℹ️ 若提示缺少 canvas（可装依赖，仅可视化用到），在本目录执行后重试: npm i canvas`);
        console.log(`${ts()}ℹ️ 装不上 canvas 不影响机器人其余功能；自包含分发包默认不含 canvas`);
        return;
    }
    if (bot.viewer && bot.viewer._viewerPort) {
        console.log(`${ts()}ℹ️ 可视化已在运行: http://localhost:${bot.viewer._viewerPort}`);
        return;
    }
    let portAvailable = await checkPortAvailable(port);
    if (!portAvailable && recentClosedPort === port) {
        await new Promise((r) => setTimeout(r, 1000));
        portAvailable = await checkPortAvailable(port);
    }
    if (!portAvailable) {
        console.log(`${ts()}⚠️ 端口 ${port} 已被占用，无法启动可视化`);
        console.log(`${ts()}ℹ️ 请使用 !view enable <端口> 指定其他端口，例如: !view enable ${port + 1}`);
        return;
    }
    try {
        try {
            await viewerPatch.ensurePatchedAssets();
        } catch (patchErr) {
            console.error(`${ts()}❌ 高保真补丁生成失败（可视化将使用原始数据继续启动）: ${(patchErr as Error).message}`);
        }
        mineflayerViewer(bot, { viewDistance: 6, firstPerson: false, port });
        if (bot.viewer) bot.viewer._viewerPort = port;
        attachBlockClicked(bot);
        const pos = bot.entity.position;
        console.log(`${ts()}🌐 可视化已启动！浏览器打开 http://localhost:${port} 查看机器人周边 3D 视角`);
        console.log(`${ts()}📍 当前坐标: x=${pos.x.toFixed(1)} y=${pos.y.toFixed(1)} z=${pos.z.toFixed(1)}`);
    } catch (err) {
        console.error(`${ts()}❌ 可视化启动失败: ${(err as Error).message}`);
    }
}

export function stopView(): void {
    const bot: Bot | null = state.bot;
    if (!bot || !bot.viewer || !bot.viewer._viewerPort) {
        console.log(`${ts()}⚠️ 可视化未在运行`);
        return;
    }
    const port = bot.viewer._viewerPort;
    try {
        bot.viewer.close();
        delete bot.viewer._viewerPort;
        recentClosedPort = port;
        console.log(`${ts()}🛑 可视化已关闭（端口 ${port} 已释放）`);
    } catch (err) {
        console.error(`${ts()}❌ 可视化关闭失败: ${(err as Error).message}`);
    }
}
