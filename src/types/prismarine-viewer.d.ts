// prismarine-viewer 无内置类型声明（npm 包未含 .d.ts），此处按实际使用面声明。
// 代码通过 createRequire 动态加载（require('prismarine-viewer').mineflayer）。
declare module 'prismarine-viewer' {
    interface ViewerOptions {
        viewDistance?: number;
        firstPerson?: boolean;
        port?: number;
        [key: string]: unknown;
    }

    export function mineflayer(bot: unknown, options?: ViewerOptions): unknown;
    export function standalone(options?: ViewerOptions): unknown;

    const viewer: {
        mineflayer: typeof mineflayer;
        standalone: typeof standalone;
    };
    export default viewer;
}
