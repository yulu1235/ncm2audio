/**
 * ncm2audio 命令行入口。
 *
 * 这里只负责参数解析、文件读写和输出，解密逻辑在 ./decrypt.mjs。
 * main() 不直接调用 process.exit，而是返回退出码，方便测试。
 */
import fs from "node:fs";
import path from "node:path";
import { NcmError, decryptNcm, imageExt } from "./decrypt.mjs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const VERSION = pkg.version;

export const USAGE = `ncm2audio v${VERSION} — 把网易云音乐的 .ncm 文件解密导出为 mp3 / flac

用法:
  ncm2audio [选项] <文件.ncm> [更多.ncm ...]

选项:
  -o, --out <目录>   指定输出目录（默认：每个文件同级的 out/ 目录）
      --no-cover     不导出内嵌封面
  -q, --quiet        只输出错误
  -h, --help         显示本帮助
  -v, --version      显示版本号

输出:
  <输出目录>/<文件名>.<flac|mp3>         音频本体
  <输出目录>/<文件名>.cover.<jpg|png>    内嵌封面（如有）

退出码:
  0  全部成功
  1  参数错误或没有指定文件
  2  有文件转换失败

示例:
  ncm2audio song.ncm
  ncm2audio -o ./music song.ncm another.ncm
  ncm2audio --no-cover -o ./music *.ncm

说明:
  只解开网易云客户端自己下载的 ncm 外壳，不涉及任何版权解除。
  解出来的文件请自行斟酌用途，不要公开分发。`;

export class CliUsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "CliUsageError";
	}
}

/** 解析 argv；不认识的形式直接抛 CliUsageError */
export function parseArgs(argv) {
	const opts = { files: [], outDir: null, cover: true, quiet: false, help: false, version: false };

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-h":
			case "--help":
				opts.help = true;
				break;
			case "-v":
			case "--version":
				opts.version = true;
				break;
			case "-q":
			case "--quiet":
				opts.quiet = true;
				break;
			case "--no-cover":
				opts.cover = false;
				break;
			case "-o":
			case "--out": {
				const value = argv[++i];
				if (!value || value.startsWith("-")) throw new CliUsageError(`${arg} 后面需要跟一个输出目录`);
				opts.outDir = value;
				break;
			}
			default:
				if (arg.startsWith("-") && arg !== "-") throw new CliUsageError(`无法识别的选项：${arg}`);
				opts.files.push(arg);
		}
	}
	return opts;
}

function formatSize(bytes) {
	if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
	return `${(bytes / 1024).toFixed(0)} KB`;
}

function describeMeta(meta) {
	if (!meta) return null;
	const artists = (meta.artist ?? []).map((a) => a[0]).join(" / ");
	return `${meta.musicName ?? "?"} — ${artists || "?"} — ${meta.album ?? "?"}`;
}

/**
 * 转换一批文件。
 * @param {string[]} argv 不含 node 与脚本名的参数
 * @param {{ log?: Function, error?: Function }} [io] 注入输出函数，便于测试
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2), io = {}) {
	const log = io.log ?? console.log;
	const error = io.error ?? console.error;

	let opts;
	try {
		opts = parseArgs(argv);
	} catch (e) {
		error(`参数错误：${e.message}\n`);
		error(USAGE);
		return 1;
	}

	if (opts.help) {
		log(USAGE);
		return 0;
	}
	if (opts.version) {
		log(VERSION);
		return 0;
	}
	if (opts.files.length === 0) {
		error("没有指定要转换的 .ncm 文件\n");
		error(USAGE);
		return 1;
	}

	const outDirOverride = opts.outDir ? path.resolve(opts.outDir) : null;
	let succeeded = 0;
	let failed = 0;

	for (const file of opts.files) {
		try {
			if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
				throw new NcmError(`找不到文件：${file}`);
			}

			const result = decryptNcm(fs.readFileSync(file));
			const base = path.basename(file).replace(/\.ncm$/i, "");
			const outDir = outDirOverride ?? path.join(path.dirname(path.resolve(file)), "out");
			fs.mkdirSync(outDir, { recursive: true });

			const audioPath = path.join(outDir, `${base}.${result.ext}`);
			fs.writeFileSync(audioPath, result.audio);

			let coverPath = null;
			if (opts.cover && result.image) {
				coverPath = path.join(outDir, `${base}.cover.${imageExt(result.image)}`);
				fs.writeFileSync(coverPath, result.image);
			}

			succeeded++;
			if (!opts.quiet) {
				log(`OK  ${path.basename(file)}`);
				log(`    -> ${audioPath}  ${formatSize(result.audio.length)}  [${result.ext}]`);
				log(`    封面: ${coverPath ? `${formatSize(result.image.length)}  -> ${coverPath}` : "无"}`);
				const meta = describeMeta(result.meta);
				if (meta) log(`    元数据: ${meta}`);
			}
		} catch (e) {
			failed++;
			const reason = e instanceof NcmError ? e.message : `未知错误：${e.message}`;
			error(`ERR ${path.basename(file)}: ${reason}`);
		}
	}

	if (opts.files.length > 1 && !opts.quiet) {
		log(`\n完成：成功 ${succeeded} 个，失败 ${failed} 个`);
	}
	return failed === 0 ? 0 : 2;
}
