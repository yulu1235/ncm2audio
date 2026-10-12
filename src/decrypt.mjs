/**
 * NCM 解密核心。
 *
 * 只处理网易云音乐客户端自己在本地缓存的 `.ncm` 外壳，做三件事：
 *   ① 用 AES-128-ECB 解出 RC4 密钥材料，构造密钥流
 *   ② 解出元数据块（歌名 / 歌手 / 专辑）
 *   ③ 用密钥流异或还原音频本体，并顺带取出内嵌封面
 *
 * 算法思路参考 ncmdump（MIT），本文件为独立实现。
 *
 * 本模块不读写文件、不打印输出，纯函数，便于测试。
 */
import crypto from "node:crypto";

/** ncm 文件魔数 */
export const NCM_MAGIC = "CTENFDAM";

/** 密钥块与元数据块的 AES-128-ECB 密钥（公开常量，来自 ncmdump） */
export const CORE_KEY = Buffer.from("687A4852416D736F356B496E62617857", "hex"); // "hzHRAmso5kInbaxW"
export const META_KEY = Buffer.from("2331346C6A6B5F215C5D2630553C2728", "hex"); // "#14ljk_!\]&0U<'("

/** 音频头特征，用来在解密后定位真正的音频起点 */
const AUDIO_HEADS = [
	["flac", Buffer.from("fLaC", "latin1")],
	["mp3", Buffer.from([0xff, 0xfb])],
	["mp3", Buffer.from([0xff, 0xfa])],
	["mp3", Buffer.from([0xff, 0xf3])],
	["mp3", Buffer.from([0xff, 0xf2])],
	["mp3", Buffer.from("ID3", "latin1")],
];

/** 所有本包抛出的错误都继承它，方便调用方统一 catch */
export class NcmError extends Error {
	constructor(message) {
		super(message);
		this.name = "NcmError";
	}
}

/** 文件结构不符合 ncm 格式（魔数不对、被截断、找不到音频起点等） */
export class NcmFormatError extends NcmError {
	constructor(message) {
		super(message);
		this.name = "NcmFormatError";
	}
}

function ecbDecrypt(buf, key) {
	const d = crypto.createDecipheriv("aes-128-ecb", key, null);
	d.setAutoPadding(false);
	return Buffer.concat([d.update(buf), d.final()]);
}

/** 去掉尾部 PKCS#7 填充；填充值非法时原样返回 */
function stripPad(buf) {
	const pad = buf[buf.length - 1];
	return pad >= 1 && pad <= 16 && pad <= buf.length ? buf.subarray(0, buf.length - pad) : buf;
}

function xor(buf, k) {
	const o = Buffer.from(buf);
	for (let i = 0; i < o.length; i++) o[i] ^= k;
	return o;
}

/**
 * 由 RC4 密钥材料构造密钥流（与 ncmdump 的 box 构造一致）。
 * @returns {(i: number) => number} 取第 i 个密钥流字节
 */
function buildKeystream(key) {
	if (key.length === 0) throw new NcmFormatError("密钥材料为空，无法构造密钥流");
	const box = new Uint8Array(256);
	for (let i = 0; i < 256; i++) box[i] = i;
	let c = 0;
	let last = 0;
	let ko = 0;
	for (let i = 0; i < 256; i++) {
		const swap = box[i];
		c = (swap + last + key[ko]) & 0xff;
		ko = (ko + 1) % key.length;
		box[i] = box[c];
		box[c] = swap;
		last = c;
	}
	return (i) => {
		const j = (i + 1) & 0xff;
		return box[(box[j] + box[(box[j] + j) & 0xff]) & 0xff];
	};
}

/** 从封面二进制猜扩展名 */
export function imageExt(image) {
	return image[0] === 0xff && image[1] === 0xd8 ? "jpg" : "png";
}

/**
 * 解密一份 ncm 数据。
 * @param {Buffer} buf ncm 文件内容
 * @returns {{ audio: Buffer, ext: "mp3"|"flac", image: Buffer|null, meta: object|null }}
 */
export function decryptNcm(buf) {
	if (!Buffer.isBuffer(buf)) throw new TypeError("decryptNcm 需要 Buffer");
	if (buf.length < 16 || buf.subarray(0, 8).toString("latin1") !== NCM_MAGIC) {
		throw new NcmFormatError(`文件头不是 ${NCM_MAGIC}，看起来不是 ncm 文件`);
	}

	let off = 8 + 2; // "CTENFDAM" + 2 字节版本位

	try {
		// ① RC4 密钥材料
		const keyLen = buf.readUInt32LE(off);
		off += 4;
		if (keyLen === 0 || off + keyLen > buf.length) {
			throw new NcmFormatError("密钥块长度非法，文件可能不完整");
		}
		const key = stripPad(ecbDecrypt(xor(buf.subarray(off, off + keyLen), 0x64), CORE_KEY)).subarray(17);
		off += keyLen;

		// ② 元数据块（异或 0x63 后是 "163 key(Don't modify):" + base64）
		let meta = null;
		const metaLen = buf.readUInt32LE(off);
		off += 4;
		if (metaLen > 0 && metaLen < 1024 * 1024) {
			if (off + metaLen > buf.length) throw new NcmFormatError("元数据块越界，文件可能不完整");
			const raw = xor(buf.subarray(off, off + metaLen), 0x63).subarray(22);
			off += metaLen;
			try {
				const plain = stripPad(
					ecbDecrypt(Buffer.from(raw.toString("latin1"), "base64"), META_KEY),
				).subarray(6);
				meta = JSON.parse(plain.toString("utf8").replace(/\0+$/, ""));
			} catch {
				meta = null; // 元数据坏了不影响音频
			}
		}

		// ③ 音频起点：不同版本前面还有 CRC/占位/封面，用「解密后必须是合法音频头」定位
		const streamByte = buildKeystream(key);

		const tryHead = (audioOff, imgOff, imgLen) => {
			if (audioOff + 4 > buf.length) return null;
			const head = Buffer.from(buf.subarray(audioOff, audioOff + 4));
			for (let i = 0; i < head.length; i++) head[i] ^= streamByte(i);
			for (const [ext, sig] of AUDIO_HEADS) {
				if (head.subarray(0, sig.length).equals(sig)) return { audioOff, imgOff, imgLen, ext };
			}
			return null;
		};

		let found = null;
		for (let p = off; p <= off + 64 && !found; p++) {
			const imgLen = buf.readUInt32LE(p);
			if (imgLen > 0 && imgLen < 20 * 1024 * 1024 && p + 4 + imgLen + 4 <= buf.length) {
				found = tryHead(p + 4 + imgLen, p + 4, imgLen);
			}
			if (!found) found = tryHead(p, 0, 0);
		}
		if (!found) throw new NcmFormatError("找不到音频起点（文件可能不完整或非标准 ncm）");

		const audio = Buffer.from(buf.subarray(found.audioOff));
		for (let i = 0; i < audio.length; i++) audio[i] ^= streamByte(i);
		const image =
			found.imgLen > 0 ? Buffer.from(buf.subarray(found.imgOff, found.imgOff + found.imgLen)) : null;

		return { audio, ext: found.ext, image, meta };
	} catch (e) {
		if (e instanceof NcmError) throw e;
		if (e instanceof RangeError) throw new NcmFormatError("读取文件时越界，文件可能已损坏或被截断");
		throw e;
	}
}
