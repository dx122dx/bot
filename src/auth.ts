// auth.ts —— 认证模块：手动认证 + 自定义加密协商
import axios from 'axios';
import crypto from 'crypto';
import { createRequire } from 'module';
import { ts } from './logger.js';
import { getConfig } from './config.js';
import type { AuthData } from './botMachine.js';
import type { Client } from 'minecraft-protocol';

// ESM 下无全局 require，用 createRequire 提供（sendEncryptionResponse 需要加载 minecraft-data）
const require = createRequire(import.meta.url);

// ---------- 手动认证 ----------
export async function authenticate(): Promise<AuthData> {
    const CONFIG = getConfig();
    const authUrl = CONFIG.auth.authServer + '/authserver/authenticate';
    const payload = {
        agent: { name: 'Minecraft', version: 1 },
        username: CONFIG.auth.username,
        password: CONFIG.auth.password,
    };
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Minecraft/1.20.1',
    };
    const res = await axios.post(authUrl, payload, { headers });
    return res.data as AuthData;
}

// ---------- 自定义加密协商辅助函数 ----------
// encryption_begin 包（服务端公钥与验证令牌）
export interface EncryptionBeginPacket {
    serverId: string;
    publicKey: Buffer;
    verifyToken: Buffer;
}

export function mcHexDigest(hash: Buffer): string {
    const negative = hash.readInt8(0) < 0;
    if (negative) {
        for (let i = 0; i < hash.length; i++) hash[i] = ~hash[i];
        for (let i = hash.length - 1; i >= 0; i--) {
            hash[i]++;
            if (hash[i] !== 0) break;
        }
    }
    return (negative ? '-' : '') + hash.toString('hex').replace(/^0+/, '');
}

export function mcPubKeyToPem(mcPubKeyBuffer: Buffer): string {
    let pem = '-----BEGIN PUBLIC KEY-----\n';
    const base64PubKey = mcPubKeyBuffer.toString('base64');
    const maxLineLength = 64;
    for (let i = 0; i < base64PubKey.length; i += maxLineLength) {
        pem += base64PubKey.substring(i, i + maxLineLength) + '\n';
    }
    pem += '-----END PUBLIC KEY-----\n';
    return pem;
}

interface JoinError {
    response?: { status?: number; data?: unknown };
    message?: string;
}

export function handleCustomJoin(packet: EncryptionBeginPacket, sharedSecret: Buffer, client: Client): void {
    const CONFIG = getConfig();
    const serverIdHash = mcHexDigest(
        crypto.createHash('sha1')
            .update(packet.serverId)
            .update(sharedSecret)
            .update(packet.publicKey)
            .digest()
    );
    const joinUrl = CONFIG.auth.authServer + '/sessionserver/session/minecraft/join';
    axios.post(joinUrl, {
        accessToken: client.session!.accessToken, // session 在 auth 回调中已写入
        selectedProfile: client.session!.selectedProfile.id,
        serverId: serverIdHash
    }, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Minecraft/' + CONFIG.server.version } })
        .then(() => {
            sendEncryptionResponse(packet, sharedSecret, client);
        })
        .catch((err: JoinError) => {
            console.error(`${ts()}❌ join 请求失败:`, err.response?.status, err.response?.data || err.message);
            client.emit('error', err);
            client.end('encryptionLoginError');
        });
}

export function sendEncryptionResponse(packet: EncryptionBeginPacket, sharedSecret: Buffer, client: Client): void {
    const mcData = require('minecraft-data')(client.version);
    const pubKey = mcPubKeyToPem(packet.publicKey);
    const encryptedSharedSecretBuffer = crypto.publicEncrypt({ key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING }, sharedSecret);
    const encryptedVerifyTokenBuffer = crypto.publicEncrypt({ key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING }, packet.verifyToken);

    if (mcData.supportFeature('signatureEncryption')) {
        client.write('encryption_begin', {
            sharedSecret: encryptedSharedSecretBuffer,
            hasVerifyToken: true,
            crypto: { verifyToken: encryptedVerifyTokenBuffer }
        });
    } else {
        client.write('encryption_begin', {
            sharedSecret: encryptedSharedSecretBuffer,
            verifyToken: encryptedVerifyTokenBuffer
        });
    }
    client.setEncryption(sharedSecret);
}
