# DICOM Reading Workbench

一个面向 CT / MRI 人机实验场景的本地阅片工作台。  
项目用于科研实验与流程记录，不作为临床正式诊断系统。

## 项目特性

- 本地导入病例文件夹或 ZIP 数据
- DICOM 阅片与多分区查看
- 拖拽替换病例、分屏布局调整
- 影像所见 / 诊断意见填写
- AI 参考报告与推理查看
- 计时、问卷、草稿恢复、结果导出
- 导出实验结果为 CSV / JSON

## 技术栈

- Electron
- React
- TypeScript
- Vite
- `sql.js`

## 目录结构

```text
dicom-reading-workbench/
├─ .github/workflows/      GitHub Actions 构建与发版流程
├─ data/                   本地运行数据、数据库、导入病例
├─ electron/               Electron 主进程与 preload
├─ scripts/                辅助脚本
├─ source-assets/          需求文档与参考资料
├─ src/                    前端界面与阅片逻辑
├─ tools/                  本地便携工具
├─ package.json            项目脚本与依赖配置
└─ README.md               项目说明
```

## 数据约定

程序默认扫描 `data/raw/` 下的病例数据，推荐结构：

```text
data/
  raw/
    001_CT/
      image001.dcm
      image002.dcm
    001_CT.json
```

支持的影像文件：

- `.dcm`
- `.dicom`
- `.ima`
- 无扩展名但文件头包含 `DICM` 的文件

示例 JSON：

```json
{
  "patientId": "20240506002311",
  "description": "AI 参考影像所见",
  "diagnosis": "AI 参考诊断意见",
  "reasoning": "AI 推理内容"
}
```

## 本地开发

已安装全局 Node.js 时：

```bash
npm install
npm run dev
```

Windows 使用仓库自带 Node.js 时：

```bat
set PATH=%CD%\tools\node-v22.22.3-win-x64;%PATH%
npm install
npm run dev
```

常用命令：

```bash
npm run dev
npm run build
npm run pack:win
npm run pack:mac
npm run verify:data
```

## 自动构建与发版

仓库已配置 GitHub Actions：

- 推送到 `main` 后自动构建 Windows 与 macOS 安装包
- 推送 `v*` 标签后自动创建 GitHub Release
- 构建产物包含：
  - Windows: `.exe`
  - macOS: `.dmg`、`.zip`

如需让 macOS 安装包通过签名与公证，还需要在 GitHub 仓库中配置以下 Secrets：

- `MACOS_CERTIFICATE_P12_BASE64`：Apple Developer ID Application 证书导出的 `.p12` 文件 Base64 内容
- `MACOS_CERTIFICATE_PASSWORD`：该 `.p12` 的导出密码
- `APPLE_ID`：用于 notarization 的 Apple ID
- `APPLE_APP_SPECIFIC_PASSWORD`：Apple ID 的 app-specific password
- `APPLE_TEAM_ID`：Apple Developer Team ID

示例发版命令：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 说明

- 运行数据默认保存在 `data/`
- 构建产物输出到 `release/`
- 大体积原始数据、运行数据库、导出结果默认不纳入 Git
