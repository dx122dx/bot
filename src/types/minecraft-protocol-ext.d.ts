// minecraft-protocol 类型扩展声明：运行时存在但官方类型缺失的成员
declare module 'minecraft-protocol' {
    interface Client {
        // 加密协商：认证成功后启用会话加密（client.setEncryption(sharedSecret)）
        setEncryption(sharedSecret: Buffer): void;
        // auth 回调中写入的凭据（运行时属性）
        accessToken?: string;
        clientToken?: string;
    }

    interface SessionOption {
        // connect.js 的 auth 回调向 client.session 额外写入用户名/会话 UUID
        username?: string;
        uuid?: string;
    }
}

export {};
