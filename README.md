# ncm2audio

把网易云音乐客户端下载的 `.ncm` 文件解密导出为 **mp3 / flac** 的命令行工具。

零运行时依赖，只用 Node 内置模块；解密逻辑同时作为可导入的库暴露。

```console
$ ncm2audio -o ./music song.ncm
OK  song.ncm
    -> D:\music\song.flac  4.19 MB  [flac]
    封面: 35 KB  -> D:\music\song.cover.jpg
    元数据: 前前前世 — RADWIMPS — 君の名は。
```

## 环境要求

- Node.js >= 18（用到 `node:` 前缀、`node:test`、顶层 await）

## 安装

```bash
# 直接跑，不安装（发布到 npm 后可用）
npx ncm2audio song.ncm

# 装成全局命令
npm i -g ncm2audio

# 本地仓库里直接用，不需要安装
node bin/ncm2audio.mjs song.ncm
```

## 用法

```
ncm2audio [选项] <文件.ncm> [更多.ncm ...]
```

| 选项 | 说明 |
| --- | --- |
| `-o, --out <目录>` | 指定输出目录；默认写到**每个文件同级的 `out/` 目录** |
| `--no-cover` | 不导出内嵌封面 |
| `-q, --quiet` | 只输出错误 |
| `-h, --help` | 显示帮助 |
| `-v, --version` | 显示版本号 |

**输出文件**

```
<输出目录>/<文件名>.<flac|mp3>         音频本体
<输出目录>/<文件名>.cover.<jpg|png>    内嵌封面（如有）
```

**退出码**

| 码 | 含义 |
| --- | --- |
| `0` | 全部成功 |
| `1` | 参数错误，或没有指定文件 |
| `2` | 有文件转换失败（其余文件照常输出） |

**示例**

```bash
ncm2audio song.ncm                          # 输出到 ./out/song.flac
ncm2audio -o ./music a.ncm b.ncm            # 统一输出到 ./music
ncm2audio --no-cover -o ./music *.ncm       # 不要封面
ncm2audio -q $(ls *.ncm)                    # 静默批量
```

## 作为库使用

```js
import fs from "node:fs";
import { decryptNcm, imageExt } from "ncm2audio";

const { audio, ext, image, meta } = decryptNcm(fs.readFileSync("song.ncm"));

fs.writeFileSync(`song.${ext}`, audio);
if (image) fs.writeFileSync(`song.cover.${imageExt(image)}`, image);
console.log(meta?.musicName, meta?.album);
```

导出内容：

- `decryptNcm(buf: Buffer)` → `{ audio, ext: "mp3" | "flac", image: Buffer | null, meta: object | null }`，只收 `Buffer`，不碰文件系统，出错抛 `NcmError`
- `imageExt(image)` → `"jpg" | "png"`
- `NcmError` / `NcmFormatError`：后者表示文件结构不符合 ncm 格式（魔数不对、被截断、找不到音频起点）
- CLI 内部：`ncm2audio/cli` 导出 `main(argv, io)`（返回退出码，`io` 可注入 `log` / `error`，便于测试）

## 工作原理

`.ncm` 是网易云在本地缓存外面套的一层壳，剥三层：

1. **密钥块**：文件头 `CTENFDAM` 之后是定长密钥数据，整体异或 `0x64` 后做 AES-128-ECB 解密，去掉填充、丢掉前 17 字节，得到 RC4 密钥材料。
2. **元数据块**：异或 `0x63` 去掉 `163 key(Don't modify):` 前缀，base64 解码后再 AES-128-ECB 解密，得到歌名 / 歌手 / 专辑的 JSON。
3. **音频块**：用密钥材料构造 RC4 密钥流，与密文逐字节异或还原音频；不同版本前面还有 CRC / 占位 / 封面，所以用「解密后必须是合法音频头（`fLaC` / `ID3` / mp3 帧同步字）」来定位真正的音频起点，并把前面的封面单独取出来。

## 开发与测试

```bash
node test/cli.test.mjs      # 直接跑
npm test                    # 走 node:test runner
```

测试不依赖真实 `.ncm` 样本：用例里实现了对应的「打包侧」逻辑，先构造出合法的 ncm 容器，再走完整解密路径做往返比对，覆盖无封面 / 有封面 / mp3 / 截断 / 魔数错误 / CLI 参数与退出码。

## 已知限制

- 只认网易云客户端自己产出的标准 ncm；魔改过的容器不保证能解。
- 元数据块损坏时不报错，只把 `meta` 置为 `null`，音频照常输出。
- 输出同名文件会直接覆盖。

## 免责声明

本项目只做格式转换，不解密任何受 DRM 保护的内容，也不提供音频下载能力：它处理的只是你自己机器上、客户端已经下载好的缓存文件。请仅用于个人备份与播放，不要公开分发转换后的音频。

## 致谢

解密流程参考 [ncmdump](https://github.com/anonymous5l/ncmdump)（MIT）的思路，本仓库为独立实现。

## License

[MIT](./LICENSE)
