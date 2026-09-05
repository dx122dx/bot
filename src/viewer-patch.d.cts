// viewer-patch.cjs 的类型声明（CJS 模块保持 .cjs，故声明为 .d.cts 与之同名配对）
declare const viewerPatch: {
    ensurePatchedAssets(): Promise<void> | void;
    patchSetupRoutes(): unknown;
    setGuiData(data: { title: string; items: string[] }): void;
    VIEWER_ASSETS_DIR: string;
    BLOCKS_PATCH_FILE: string;
    TEXTURE_PATCH_FILE: string;
    TEXTURE_SRC_DIR: string;
};

export = viewerPatch;
