// mineflayer 类型扩展声明：运行时存在但官方类型缺失的属性（由插件/内部实现注入）
declare module 'mineflayer' {
    interface Bot {
        // prismarine-viewer 插件注入的 viewer 实例（mineflayerViewer 挂载）
        viewer?: {
            _viewerPort?: number;
            close(): void;
        };
        // mineflayer 运行时的当前快捷栏选中槽位（0-8），官方类型仅暴露 heldItem
        heldItemSlot?: number;
    }

    interface GameState {
        // 运行时的维度世界名（mineflayer 内部 game.world 字段），官方类型未声明
        world?: string;
    }

    interface GameSettings {
        // setSettings({ locale }) 运行时字段（1.19+ 服务器接受 locale），官方类型未声明
        locale?: string;
    }
}

export {};
