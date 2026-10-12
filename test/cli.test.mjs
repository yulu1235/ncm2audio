import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CliUsageError, main, parseArgs } from "../src/cli.mjs";
import { CORE_KEY, NcmFormatError, decryptNcm, imageExt } from "../src/decrypt.mjs";

// ── 测试用的「加密侧」实现：把明文重新打包成 ncm，用来做往返验证 ──────────────
// 与 decrypt.mjs 各自独立实现同一套算法，任一侧写错都会让往返对不上。

const KEY_MATERIAL = Buffer.from("ncm2audio-test-key-material-32byte", "latin1");
const FLAC_AUDIO = Buffer.concat([Buffer.from("fLaC", "latin1"), crypto.randomBytes(1024)]);
const MP3_AUDIO = Buffer.concat([Buffer.from("ID3", "latin1"), crypto.randomBytes(2048)]);
const JPEG_COVER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(256)]);
const PNG_COVER = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(128)]);

const xor = (buf, k) => {
	const out = Buffer.from(buf);
	for (let i = 0; i < out.length; i++) out[i] ^= k;
	return out;
};

const u32 = (n) => {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(n, 0);
	return b;
};

function pkcs7Pad(buf) {
	const pad = 16 - (buf.length % 16);
	return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function ecbEncrypt(buf, key) {
	const c = crypto.createCipheriv("aes-128-ecb", key, null);
	c.setAutoPadding(false);
	return Buffer.concat([c.update(buf), c.final()]);
}

function keystreamBytes(key) {
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

/** 构造一个合法的 ncm 文件（密钥块真实、元数据块留空） */
function buildNcm({ audio, cover = null }) {
	const keyPlain = pkcs7Pad(Buffer.concat([Buffer.alloc(17, 0x41), KEY_MATERIAL]));
	const keyBlock = xor(ecbEncrypt(keyPlain, CORE_KEY), 0x64);
	const header = Buffer.concat([
		Buffer.from("CTENFDAM", "latin1"),
		Buffer.from([0x01, 0x00]),
		u32(keyBlock.length),
		keyBlock,
		u32(0), // 元数据块长度，0 表示没有
	]);

	const stream = keystreamBytes(KEY_MATERIAL);
	const encrypted = Buffer.from(audio);
	for (let i = 0; i < encrypted.length; i++) encrypted[i] ^= stream(i);

	const body = cover ? Buffer.concat([u32(cover.length), cover, encrypted]) : encrypted;
	return Buffer.concat([header, body]);
}

function captureIo() {
	const logs = [];
	const errors = [];
	return { logs, errors, io: { log: (m) => logs.push(String(m)), error: (m) => errors.push(String(m)) } };
}

// ── 解密核心 ────────────────────────────────────────────────────────────────

test("解出 flac 音频（无封面）", () => {
	const result = decryptNcm(buildNcm({ audio: FLAC_AUDIO }));
	assert.equal(result.ext, "flac");
	assert.deepEqual(result.audio, FLAC_AUDIO);
	assert.equal(result.image, null);
	assert.equal(result.meta, null);
});

test("解出 mp3 音频（ID3 头）", () => {
	const result = decryptNcm(buildNcm({ audio: MP3_AUDIO }));
	assert.equal(result.ext, "mp3");
	assert.deepEqual(result.audio, MP3_AUDIO);
});

test("顺带取出内嵌封面", () => {
	const result = decryptNcm(buildNcm({ audio: FLAC_AUDIO, cover: JPEG_COVER }));
	assert.equal(result.ext, "flac");
	assert.deepEqual(result.audio, FLAC_AUDIO);
	assert.deepEqual(result.image, JPEG_COVER);
});

test("封面扩展名按文件头判断", () => {
	assert.equal(imageExt(JPEG_COVER), "jpg");
	assert.equal(imageExt(PNG_COVER), "png");
});

test("魔数不对时抛 NcmFormatError", () => {
	assert.throws(() => decryptNcm(Buffer.from("this is not a ncm file at all")), NcmFormatError);
});

test("文件被截断时抛 NcmFormatError", () => {
	const truncated = buildNcm({ audio: FLAC_AUDIO }).subarray(0, 32);
	assert.throws(() => decryptNcm(truncated), NcmFormatError);
});

test("传入非 Buffer 时抛 TypeError", () => {
	assert.throws(() => decryptNcm("path/to/song.ncm"), TypeError);
});

// ── 参数解析 ────────────────────────────────────────────────────────────────

test("解析文件与选项", () => {
	const opts = parseArgs(["-o", "./music", "--no-cover", "-q", "a.ncm", "b.ncm"]);
	assert.deepEqual(opts.files, ["a.ncm", "b.ncm"]);
	assert.equal(opts.outDir, "./music");
	assert.equal(opts.cover, false);
	assert.equal(opts.quiet, true);
});

test("-o 缺少参数时报错", () => {
	assert.throws(() => parseArgs(["a.ncm", "-o"]), CliUsageError);
});

test("未知选项报错", () => {
	assert.throws(() => parseArgs(["--nope", "a.ncm"]), CliUsageError);
});

// ── 命令行 ──────────────────────────────────────────────────────────────────

test("--help 返回 0 并打印用法", async () => {
	const { logs, io } = captureIo();
	assert.equal(await main(["--help"], io), 0);
	assert.equal(logs.length, 1);
	assert.match(logs[0], /^ncm2audio v\d/);
});

test("--version 返回 0 并打印版本号", async () => {
	const { logs, io } = captureIo();
	assert.equal(await main(["--version"], io), 0);
	assert.match(logs[0], /^\d+\.\d+\.\d+$/);
});

test("没有文件时返回 1", async () => {
	const { logs, errors, io } = captureIo();
	assert.equal(await main([], io), 1);
	assert.equal(logs.length, 0);
	assert.match(errors.join("\n"), /没有指定要转换的 \.ncm 文件/);
});

test("参数错误返回 1", async () => {
	const { errors, io } = captureIo();
	assert.equal(await main(["--nope"], io), 1);
	assert.match(errors.join("\n"), /参数错误/);
});

test("文件不存在返回 2", async () => {
	const { errors, io } = captureIo();
	assert.equal(await main([path.join(os.tmpdir(), "不存在的文件.ncm")], io), 2);
	assert.match(errors.join("\n"), /找不到文件/);
});

test("成功转换并写出音频与封面，退出码 0", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncm2audio-"));
	try {
		const src = path.join(dir, "song.ncm");
		const out = path.join(dir, "out");
		fs.writeFileSync(src, buildNcm({ audio: FLAC_AUDIO, cover: JPEG_COVER }));

		const { logs, errors, io } = captureIo();
		assert.equal(await main(["-o", out, src], io), 0);
		assert.deepEqual(errors, []);
		assert.deepEqual(fs.readFileSync(path.join(out, "song.flac")), FLAC_AUDIO);
		assert.deepEqual(fs.readFileSync(path.join(out, "song.cover.jpg")), JPEG_COVER);
		assert.match(logs.join("\n"), /OK {2}song\.ncm/);
		assert.match(logs.join("\n"), /\[flac\]/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("--no-cover 时不写封面文件", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncm2audio-"));
	try {
		const src = path.join(dir, "song.ncm");
		const out = path.join(dir, "out");
		fs.writeFileSync(src, buildNcm({ audio: MP3_AUDIO, cover: JPEG_COVER }));

		const { io } = captureIo();
		assert.equal(await main(["--no-cover", "-o", out, src], io), 0);
		assert.ok(fs.existsSync(path.join(out, "song.mp3")));
		assert.equal(fs.existsSync(path.join(out, "song.cover.jpg")), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("多文件里部分失败时返回 2，成功的照常写出", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncm2audio-"));
	try {
		const good = path.join(dir, "good.ncm");
		const bad = path.join(dir, "bad.ncm");
		const out = path.join(dir, "out");
		fs.writeFileSync(good, buildNcm({ audio: FLAC_AUDIO }));
		fs.writeFileSync(bad, "not a ncm file");

		const { logs, errors, io } = captureIo();
		assert.equal(await main(["-o", out, good, bad], io), 2);
		assert.ok(fs.existsSync(path.join(out, "good.flac")));
		assert.equal(fs.existsSync(path.join(out, "bad.flac")), false);
		assert.match(errors.join("\n"), /ERR bad\.ncm/);
		assert.match(logs.join("\n"), /成功 1 个，失败 1 个/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("--quiet 时不输出成功日志", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncm2audio-"));
	try {
		const src = path.join(dir, "song.ncm");
		fs.writeFileSync(src, buildNcm({ audio: FLAC_AUDIO }));

		const { logs, io } = captureIo();
		assert.equal(await main(["-q", "-o", dir, src], io), 0);
		assert.deepEqual(logs, []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
