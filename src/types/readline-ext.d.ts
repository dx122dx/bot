// @types/node 的 readline.Interface 运行时存在 closed 属性（rl.closed 判断 prompt 是否已关闭），官方类型未声明
declare module 'readline' {
    interface Interface {
        closed: boolean;
    }
}

export {};
